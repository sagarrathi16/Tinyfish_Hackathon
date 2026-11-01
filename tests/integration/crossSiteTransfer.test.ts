import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockStoreServer } from "../../src/fixtures/mockStoreServer.js";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import { PlaywrightRunner } from "../../src/executor/playwrightRunner.js";
import { ValidatorWorker } from "../../src/validator/validatorWorker.js";
import { CrossSiteTransferEngine } from "../../src/transfer/crossSiteTransfer.js";
import type { Skill, SiteAdapter } from "../../src/types/domain.js";

describe("Cross-Site Transfer Workflow & TIP Telemetry", () => {
  let mockServer: MockStoreServer;
  let baseUrl: string;
  let db: ReturnType<typeof DatabaseConstructor>;
  let repo: Repository;
  let runner: PlaywrightRunner;
  let validator: ValidatorWorker;
  let transferEngine: CrossSiteTransferEngine;

  beforeAll(async () => {
    mockServer = new MockStoreServer();
    baseUrl = await mockServer.start();

    db = new DatabaseConstructor(":memory:");
    initSchema(db);
    repo = new Repository(db);
    runner = new PlaywrightRunner(repo);
    validator = new ValidatorWorker(repo);
    transferEngine = new CrossSiteTransferEngine(repo, runner, validator);
  }, 20000);

  afterAll(async () => {
    await mockServer.stop();
    db.close();
  });

  const seedStoreASkillAndAdapter = () => {
    const skill: Skill = {
      id: randomUUID(),
      name: "Product Discovery",
      taskType: "PRODUCT_LOOKUP",
      version: "1.0.0",
      status: "ACTIVE",
      taskTemplate: [
        { order: 1, stepName: "OPEN", description: "Open store entry URL", postcondition: "PAGE_LOADED" },
        { order: 2, stepName: "SEARCH", description: "Type query into search input", postcondition: "SEARCH_SUBMITTED" },
        { order: 3, stepName: "PARSE", description: "Parse product cards from results", postcondition: "CARDS_EXTRACTED" },
        { order: 4, stepName: "SELECT", description: "Filter out accessory items", postcondition: "PRODUCT_SELECTED" },
        { order: 5, stepName: "CONFIRM", description: "Extract product price, title, and link", postcondition: "DETAILS_CONFIRMED" },
      ],
      outputSchema: {
        title: "string",
        numericPrice: "number",
        currency: "string",
        url: "string",
      },
      postconditions: [
        { name: "SCHEMA_VALID", rule: "All required output fields present", required: true },
        { name: "PRICE_PARSED_INR", rule: "Price parsed with valid currency and numeric value", required: true },
      ],
      sourceRunIds: ["store-a-run-1"],
      tests: [],
      limitations: [],
      timestamps: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    const storeAAdapter: SiteAdapter = {
      domain: "store-a.local",
      adapterVersion: "1.0.0",
      status: "ACTIVE",
      locatorBindings: {
        SEARCH_INPUT: {
          semanticRole: "SEARCH_INPUT",
          locatorStrategy: "css",
          locatorValue: "input[name='s']",
          anchorEvidence: { placeholder: "Search products..." },
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "store-a.local",
          version: "1.0.0",
        },
        PRODUCT_CARD: {
          semanticRole: "PRODUCT_CARD",
          locatorStrategy: "css",
          locatorValue: ".product-grid-item",
          anchorEvidence: { role: "article" },
          uniquenessExpectation: "MULTIPLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "store-a.local",
          version: "1.0.0",
        },
        PRODUCT_TITLE: {
          semanticRole: "PRODUCT_TITLE",
          locatorStrategy: "css",
          locatorValue: ".product-title a",
          anchorEvidence: { text: "Title" },
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "store-a.local",
          version: "1.0.0",
        },
        PRODUCT_PRICE: {
          semanticRole: "PRODUCT_PRICE",
          locatorStrategy: "css",
          locatorValue: ".woocommerce-Price-amount",
          anchorEvidence: { text: "Price" },
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "store-a.local",
          version: "1.0.0",
        },
      },
      urlPatterns: {
        entryUrl: `${baseUrl}/store-a`,
      },
      evidence: {
        traceId: "store-a-trace-1",
      },
      source: "agent",
      validationQueries: ["Arduino Uno", "ESP32"],
      validationResults: [],
      createdAt: new Date().toISOString(),
    };

    repo.saveSkill(skill);
    repo.saveSiteAdapter(storeAAdapter);
    repo.promoteSiteAdapter("store-a.local", "1.0.0");
  };

  it("executes P0 cross-site transfer: reuses template/policy, discovers Store B adapter via TIP, passes 2 queries, and replays with 0 TinyFish calls", async () => {
    seedStoreASkillAndAdapter();

    const report = await transferEngine.transferWorkflow({
      sourceDomain: "store-a.local",
      targetDomain: "localhost",
      entryUrl: `${baseUrl}/store-b`,
      validationQueries: ["Arduino Uno", "ESP32"],
      subsequentQuery: "Raspberry Pi",
      enableTip: true,
    });

    expect(report).toBeDefined();

    // 1. Verify transferred artifacts
    expect(report.transferredArtifacts.taskTemplate.length).toBe(5);
    expect(report.transferredArtifacts.selectionPolicy.taskType).toBe("PRODUCT_LOOKUP");
    expect(report.transferredArtifacts.postconditions).toContain("SCHEMA_VALID");
    expect(report.transferredArtifacts.postconditions).toContain("PRICE_PARSED_INR");

    // 2. Verify relearned artifacts
    expect(report.relearnedArtifacts.domain).toBe("localhost");
    expect(report.tipStatus).toBe("MATCHED");
    expect(report.relearnedArtifacts.provenance).toBe("TIP_GROUNDED");
    expect(report.relearnedArtifacts.locatorBindings.SEARCH_INPUT.locatorValue).not.toBe("input[name='s']"); // Relearned!
    expect(report.relearnedArtifacts.locatorBindings.PRODUCT_CARD.locatorValue).not.toBe(".product-grid-item"); // Relearned!

    // 3. Verify 2-query independent validation gate
    expect(report.validationOutcome.query1.passed).toBe(true);
    expect(report.validationOutcome.query2.passed).toBe(true);
    expect(report.validationOutcome.promoted).toBe(true);
    expect(report.validationOutcome.activeVersion).toBe("1.0.0");

    // Verify atomic promotion in SQLite
    const activeInRepo = repo.getActiveSiteAdapter("localhost");
    expect(activeInRepo).toBeDefined();
    expect(activeInRepo?.status).toBe("ACTIVE");

    // 4. Verify subsequent replay proof: Strictly ZERO TinyFish API calls
    expect(report.replayProof.tinyfishApiCalls).toBe(0);
    expect(report.replayProof.passed).toBe(true);
    expect(report.replayProof.subsequentQuery).toBe("Raspberry Pi");

    // 5. Verify markdown table generation
    const mdTable = transferEngine.generateTransferMarkdownTable(report);
    expect(mdTable).toContain("# ShadowTwin Cross-Site Workflow Transfer Report");
    expect(mdTable).toContain("TRANSFERRED (100%)");
    expect(mdTable).toContain("RELEARNED");
    expect(mdTable).toContain("VERIFIED PASS");
    expect(mdTable).toContain("DETERMINISTIC REPLAY");
    expect(mdTable).toContain("0 TinyFish API calls");
  }, 25000);

  it("strictly enforces invariant: rejects candidate adapter that attempts to copy Store A selectors into Store B", async () => {
    // Attempt to transfer with a candidate that copied Store A selectors
    const copiedAdapter: SiteAdapter = {
      domain: "store-b.local",
      adapterVersion: "1.0.0",
      status: "CANDIDATE",
      locatorBindings: {
        SEARCH_INPUT: {
          semanticRole: "SEARCH_INPUT",
          locatorStrategy: "css",
          locatorValue: "input[name='s']", // Copied from Store A!
          anchorEvidence: {},
          uniquenessExpectation: "SINGLE",
          provenance: "MANUAL",
          domain: "store-b.local",
          version: "1.0.0",
        },
        PRODUCT_CARD: {
          semanticRole: "PRODUCT_CARD",
          locatorStrategy: "css",
          locatorValue: ".product-grid-item", // Copied from Store A!
          anchorEvidence: {},
          uniquenessExpectation: "MULTIPLE",
          provenance: "MANUAL",
          domain: "store-b.local",
          version: "1.0.0",
        },
      },
      urlPatterns: {
        entryUrl: `${baseUrl}/store-b`,
      },
      evidence: {},
      source: "manual",
      validationQueries: [],
      validationResults: [],
      createdAt: new Date().toISOString(),
    };

    await expect(
      transferEngine.transferWorkflow({
        sourceDomain: "store-a.local",
        targetDomain: "store-b.local",
        entryUrl: `${baseUrl}/store-b`,
        validationQueries: ["Arduino Uno", "ESP32"],
        subsequentQuery: "Raspberry Pi",
        enableTip: false, // Disables TIP so it uses fallbackAdapter
        fallbackAdapter: copiedAdapter,
      })
    ).rejects.toThrow("Cross-site transfer violation: Store A selectors were directly copied into Store B adapter");
  });

  it("halts closed when Store B candidate fails 2-query validation gate", async () => {
    // Adapter pointing to non-existent selectors
    const brokenAdapter: SiteAdapter = {
      domain: "localhost",
      adapterVersion: "2.0.0",
      status: "CANDIDATE",
      locatorBindings: {
        SEARCH_INPUT: {
          semanticRole: "SEARCH_INPUT",
          locatorStrategy: "css",
          locatorValue: "#non-existent-search-field",
          anchorEvidence: {},
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "localhost",
          version: "2.0.0",
        },
        PRODUCT_CARD: {
          semanticRole: "PRODUCT_CARD",
          locatorStrategy: "css",
          locatorValue: ".non-existent-card",
          anchorEvidence: {},
          uniquenessExpectation: "MULTIPLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "localhost",
          version: "2.0.0",
        },
      },
      urlPatterns: {
        entryUrl: `${baseUrl}/store-b`,
      },
      evidence: {},
      source: "agent",
      validationQueries: [],
      validationResults: [],
      createdAt: new Date().toISOString(),
    };

    await expect(
      transferEngine.transferWorkflow({
        sourceDomain: "store-a.local",
        targetDomain: "localhost",
        entryUrl: `${baseUrl}/store-b`,
        validationQueries: ["Arduino Uno", "ESP32"],
        subsequentQuery: "Raspberry Pi",
        enableTip: false,
        fallbackAdapter: brokenAdapter,
      })
    ).rejects.toThrow("Store B candidate adapter failed 2-query validation gate");
  }, 25000);

  it("supports Agent-assisted adapter learning when TIP is disabled by feature flag", async () => {
    // Valid Store B adapter provided by Explorer Agent
    const agentLearnedStoreB: SiteAdapter = {
      domain: "localhost",
      adapterVersion: "3.0.0",
      status: "CANDIDATE",
      locatorBindings: {
        SEARCH_INPUT: {
          semanticRole: "SEARCH_INPUT",
          locatorStrategy: "css",
          locatorValue: "[data-testid='search-input']",
          anchorEvidence: { testid: "search-input" },
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "localhost",
          version: "3.0.0",
        },
        PRODUCT_CARD: {
          semanticRole: "PRODUCT_CARD",
          locatorStrategy: "css",
          locatorValue: "article.catalog-card",
          anchorEvidence: { role: "article" },
          uniquenessExpectation: "MULTIPLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "localhost",
          version: "3.0.0",
        },
        PRODUCT_TITLE: {
          semanticRole: "PRODUCT_TITLE",
          locatorStrategy: "css",
          locatorValue: ".catalog-card-title a",
          anchorEvidence: {},
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "localhost",
          version: "3.0.0",
        },
        PRODUCT_PRICE: {
          semanticRole: "PRODUCT_PRICE",
          locatorStrategy: "css",
          locatorValue: ".sale-price",
          anchorEvidence: {},
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "localhost",
          version: "3.0.0",
        },
      },
      urlPatterns: {
        entryUrl: `${baseUrl}/store-b`,
      },
      evidence: {
        traceId: "agent-trace-store-b",
      },
      source: "agent",
      validationQueries: [],
      validationResults: [],
      createdAt: new Date().toISOString(),
    };

    const report = await transferEngine.transferWorkflow({
      sourceDomain: "store-a.local",
      targetDomain: "localhost",
      entryUrl: `${baseUrl}/store-b`,
      validationQueries: ["Arduino Uno", "ESP32"],
      subsequentQuery: "Raspberry Pi",
      enableTip: false, // Disabled feature flag
      fallbackAdapter: agentLearnedStoreB,
    });

    expect(report.tipStatus).toBe("DISABLED");
    expect(report.relearnedArtifacts.provenance).toBe("TINYFISH_EXPLORER");
    expect(report.validationOutcome.promoted).toBe(true);
    expect(report.replayProof.tinyfishApiCalls).toBe(0);
    expect(report.replayProof.passed).toBe(true);
  }, 25000);
});
