import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { CompilerAgent, type CompileParams } from "../../src/agents/compiler.js";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import type { AgentResult } from "../../src/types/domain.js";

describe("Compiler Agent & Skill/Adapter Compilation", () => {
  let repo: Repository;

  beforeEach(() => {
    const db = new DatabaseConstructor(":memory:");
    initSchema(db);
    repo = new Repository(db);
  });

  const createMockExplorerResult = (
    overrides?: Partial<AgentResult>
  ): AgentResult => ({
    taskId: randomUUID(),
    jobId: randomUUID(),
    status: "SUCCESS",
    structuredOutput: {
      product: {
        title: "Arduino Uno R3",
        numeric_price: 499,
        currency: "INR",
        product_url: "https://robu.in/product/arduino-uno-r3",
        evidence_url: "https://robu.in/product/arduino-uno-r3",
        retrieval_time: new Date().toISOString(),
        evidence_explanation: "Verified title in h1 and price in .price bdi",
      },
      candidate_bindings: {
        search_input_selector: "input[name='s']",
        search_input_anchor: "placeholder='Search for products'",
        product_card_selector: ".product-grid-item",
        product_card_anchor: "role='article'",
        title_selector: ".product-title a",
        title_anchor: "role='heading'",
        price_selector: ".woocommerce-Price-amount bdi",
        price_anchor: "currency='₹'",
        evidence_explanation: "Grounded selectors",
      },
    },
    evidenceReferences: ["https://robu.in/product/arduino-uno-r3"],
    providerRunIds: {
      tinyFishRunId: "tf_run_explore_999",
    },
    stepsUsage: { stepsCompleted: 5 },
    durationMs: 14000,
    errors: [],
    warnings: [],
    ...overrides,
  });

  it("compiles a valid candidate skill and site adapter with CANDIDATE status", async () => {
    const compiler = new CompilerAgent(repo);
    const explorerResult = createMockExplorerResult();

    const output = await compiler.compile({
      domain: "robu.in",
      entryUrl: "https://robu.in",
      explorerResult,
    });

    expect(output.skill.status).toBe("CANDIDATE");
    expect(output.adapter.status).toBe("CANDIDATE");
    expect(output.adapter.domain).toBe("robu.in");
    expect(output.adapter.adapterVersion).toBe("1.0.0");

    // Check five-step platform-neutral procedure
    expect(output.skill.taskTemplate).toHaveLength(5);
    expect(output.skill.taskTemplate.map((s) => s.stepName)).toEqual([
      "OPEN",
      "SEARCH",
      "PARSE",
      "SELECT",
      "CONFIRM",
    ]);

    // Check step bindings have provenance and run ID
    const searchBinding = output.adapter.locatorBindings["SEARCH_INPUT"];
    expect(searchBinding).toBeDefined();
    expect(searchBinding?.locatorValue).toBe("input[name='s']");
    expect(searchBinding?.provenance).toBe("TINYFISH_EXPLORER");
    expect(searchBinding?.sourceRunId).toBe("tf_run_explore_999");

    // Verify stored in DB as CANDIDATE (never ACTIVE)
    const storedAdapter = repo.getSiteAdapter("robu.in", "1.0.0");
    expect(storedAdapter?.status).toBe("CANDIDATE");
    expect(repo.getActiveSiteAdapter("robu.in")).toBeNull();
  });

  it("rejects compiler outputs if model attempts to mark skill ACTIVE", async () => {
    const maliciousLLM = async () =>
      JSON.stringify({
        candidate_skill: {
          id: randomUUID(),
          name: "E-Commerce",
          taskType: "PRODUCT_LOOKUP",
          version: "1.0.0",
          status: "ACTIVE", // VIOLATION!
          taskTemplate: [{ order: 1, stepName: "OPEN", description: "test", postcondition: "test" }],
          outputSchema: {},
          timestamps: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        },
        candidate_adapter: {
          domain: "robu.in",
          adapterVersion: "1.0.0",
          status: "CANDIDATE",
          locatorBindings: {
            SEARCH_INPUT: {
              semanticRole: "SEARCH_INPUT",
              locatorStrategy: "css",
              locatorValue: "input",
              domain: "robu.in",
              version: "1.0.0",
            },
          },
          urlPatterns: { entryUrl: "https://robu.in" },
          createdAt: new Date().toISOString(),
        },
      });

    const compiler = new CompilerAgent(repo, maliciousLLM);
    await expect(
      compiler.compile({
        domain: "robu.in",
        entryUrl: "https://robu.in",
        explorerResult: createMockExplorerResult(),
      })
    ).rejects.toThrowError(/Security violation: Skill cannot be marked 'ACTIVE'/i);
  });

  it("rejects malformed LLM JSON output with informative error", async () => {
    const brokenLLM = async () => "```json { broken_json_string ...";

    const compiler = new CompilerAgent(repo, brokenLLM);
    await expect(
      compiler.compile({
        domain: "robu.in",
        entryUrl: "https://robu.in",
        explorerResult: createMockExplorerResult(),
      })
    ).rejects.toThrowError(/Compiler output is malformed JSON/i);
  });

  it("rejects missing exploration provenance if provider run ID is missing", async () => {
    const compiler = new CompilerAgent(repo);
    const explorerResult = createMockExplorerResult({
      providerRunIds: {}, // missing tinyFishRunId
    });

    await expect(
      compiler.compile({
        domain: "robu.in",
        entryUrl: "https://robu.in",
        explorerResult,
      })
    ).rejects.toThrowError(/Missing exploration provenance/i);
  });

  it("rejects unsafe or unauthorized target domains", async () => {
    const compiler = new CompilerAgent(repo);
    await expect(
      compiler.compile({
        domain: "malicious-site.com",
        entryUrl: "https://malicious-site.com",
        explorerResult: createMockExplorerResult(),
      })
    ).rejects.toThrowError(/Target domain 'malicious-site.com' is not in ALLOWED_TARGET_DOMAINS/i);
  });

  it("detects and rejects accidental hardcoded volatile price values in selectors", async () => {
    // Model erroneously produced a selector with hardcoded price 499
    const priceLeakingLLM = async () =>
      JSON.stringify({
        candidate_skill: {
          id: randomUUID(),
          name: "E-Commerce",
          taskType: "PRODUCT_LOOKUP",
          version: "1.0.0",
          status: "CANDIDATE",
          taskTemplate: [{ order: 1, stepName: "OPEN", description: "test", postcondition: "test" }],
          outputSchema: {},
          timestamps: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        },
        candidate_adapter: {
          domain: "robu.in",
          adapterVersion: "1.0.0",
          status: "CANDIDATE",
          locatorBindings: {
            SEARCH_INPUT: {
              semanticRole: "SEARCH_INPUT",
              locatorStrategy: "css",
              locatorValue: "input[name='s']",
              domain: "robu.in",
              version: "1.0.0",
            },
            PRODUCT_PRICE: {
              semanticRole: "PRODUCT_PRICE",
              locatorStrategy: "css",
              locatorValue: "span[data-price='499']", // HARDCODED LIVE PRICE!
              domain: "robu.in",
              version: "1.0.0",
            },
          },
          urlPatterns: { entryUrl: "https://robu.in" },
          createdAt: new Date().toISOString(),
        },
      });

    const compiler = new CompilerAgent(repo, priceLeakingLLM);
    await expect(
      compiler.compile({
        domain: "robu.in",
        entryUrl: "https://robu.in",
        explorerResult: createMockExplorerResult(),
      })
    ).rejects.toThrowError(/Anti-corruption check failed: Locator for 'PRODUCT_PRICE' contains hardcoded volatile price '499'/i);
  });

  it("increments SemVer version string cleanly across repairs (1.0.0 -> 1.1.0)", async () => {
    const compiler = new CompilerAgent(repo);
    const output = await compiler.compile({
      domain: "robu.in",
      entryUrl: "https://robu.in",
      explorerResult: createMockExplorerResult(),
      existingVersion: "1.0.0",
    });

    expect(output.adapter.adapterVersion).toBe("1.1.0");
    expect(output.skill.version).toBe("1.1.0");
  });

  it("maintains separate, unmerged site adapters across different domains", async () => {
    const compiler = new CompilerAgent(repo);

    // Domain A: robu.in
    const outputA = await compiler.compile({
      domain: "robu.in",
      entryUrl: "https://robu.in",
      explorerResult: createMockExplorerResult(),
    });

    // Domain B: books.toscrape.com
    const outputB = await compiler.compile({
      domain: "books.toscrape.com",
      entryUrl: "https://books.toscrape.com",
      explorerResult: createMockExplorerResult({
        site: "books.toscrape.com",
        structuredOutput: {
          product: {
            title: "A Light in the Attic",
            numeric_price: 51.77,
            currency: "GBP",
            product_url: "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
            evidence_url: "https://books.toscrape.com",
            retrieval_time: new Date().toISOString(),
            evidence_explanation: "Verified book item",
          },
          candidate_bindings: {
            search_input_selector: "input#search",
            search_input_anchor: "id='search'",
            product_card_selector: "article.product_pod",
            product_card_anchor: "tag='article'",
            title_selector: "h3 a",
            title_anchor: "tag='h3'",
            price_selector: "p.price_color",
            price_anchor: "class='price_color'",
            evidence_explanation: "BookScrape bindings",
          },
        },
      }),
    });

    expect(outputA.adapter.domain).toBe("robu.in");
    expect(outputB.adapter.domain).toBe("books.toscrape.com");

    expect(outputA.adapter.locatorBindings["PRODUCT_CARD"]?.locatorValue).toBe(".product-grid-item");
    expect(outputB.adapter.locatorBindings["PRODUCT_CARD"]?.locatorValue).toBe("article.product_pod");

    // Verify completely separate entries in repo
    const storedA = repo.getSiteAdapter("robu.in", "1.0.0");
    const storedB = repo.getSiteAdapter("books.toscrape.com", "1.0.0");
    expect(storedA?.locatorBindings["PRODUCT_CARD"]?.locatorValue).toBe(".product-grid-item");
    expect(storedB?.locatorBindings["PRODUCT_CARD"]?.locatorValue).toBe("article.product_pod");
  });
});

