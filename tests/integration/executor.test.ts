import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightRunner } from "../../src/executor/playwrightRunner.js";
import { PriceParser } from "../../src/executor/priceParser.js";
import { MockStoreServer } from "../../src/fixtures/mockStoreServer.js";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import type { AgentTask, SiteAdapter, Skill } from "../../src/types/domain.js";

describe("Execution Worker & Deterministic Local Playwright Replay", () => {
  let mockServer: MockStoreServer;
  let baseUrl: string;
  let repo: Repository;
  let runner: PlaywrightRunner;

  beforeAll(async () => {
    mockServer = new MockStoreServer();
    baseUrl = await mockServer.start();

    const db = new DatabaseConstructor(":memory:");
    initSchema(db);
    repo = new Repository(db);
    runner = new PlaywrightRunner(repo);
  }, 20000);

  afterAll(async () => {
    await mockServer.stop();
  });

  const createActiveSkill = (): Skill => ({
    id: randomUUID(),
    name: "Product Lookup",
    taskType: "PRODUCT_LOOKUP",
    version: "1.0.0",
    status: "ACTIVE",
    taskTemplate: [
      { order: 1, stepName: "OPEN", description: "Open", postcondition: "Pass" },
      { order: 2, stepName: "SEARCH", description: "Search", postcondition: "Pass" },
      { order: 3, stepName: "PARSE", description: "Parse", postcondition: "Pass" },
      { order: 4, stepName: "SELECT", description: "Select", postcondition: "Pass" },
      { order: 5, stepName: "CONFIRM", description: "Confirm", postcondition: "Pass" },
    ],
    outputSchema: {},
    postconditions: [],
    sourceRunIds: ["run-1"],
    tests: [],
    limitations: [],
    timestamps: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  });

  const createAdapter = (entryPath: string, overrides?: Partial<SiteAdapter>): SiteAdapter => ({
    domain: "localhost",
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
        domain: "localhost",
        version: "1.0.0",
      },
      PRODUCT_CARD: {
        semanticRole: "PRODUCT_CARD",
        locatorStrategy: "css",
        locatorValue: ".product-grid-item",
        anchorEvidence: { role: "article" },
        uniquenessExpectation: "MULTIPLE",
        provenance: "TINYFISH_EXPLORER",
        domain: "localhost",
        version: "1.0.0",
      },
      PRODUCT_TITLE: {
        semanticRole: "PRODUCT_TITLE",
        locatorStrategy: "css",
        locatorValue: ".product-title a",
        anchorEvidence: {},
        uniquenessExpectation: "SINGLE",
        provenance: "TINYFISH_EXPLORER",
        domain: "localhost",
        version: "1.0.0",
      },
      PRODUCT_PRICE: {
        semanticRole: "PRODUCT_PRICE",
        locatorStrategy: "css",
        locatorValue: ".woocommerce-Price-amount bdi",
        anchorEvidence: {},
        uniquenessExpectation: "SINGLE",
        provenance: "TINYFISH_EXPLORER",
        domain: "localhost",
        version: "1.0.0",
      },
    },
    urlPatterns: {
      entryUrl: `${baseUrl}${entryPath}`,
    },
    evidence: {},
    source: "agent",
    validationQueries: [],
    validationResults: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  const createTask = (query: string): AgentTask => ({
    taskId: randomUUID(),
    jobId: randomUUID(),
    role: "EXECUTOR",
    goal: `Find ${query}`,
    site: "localhost",
    inputPayload: { query },
    deadline: new Date(Date.now() + 60000).toISOString(),
    maxSteps: 10,
    budget: { maxSeconds: 30, maxUsd: 0 },
    correlationId: "replay-test",
  });

  // --------------------------------------------------------------------------
  // 1. Success Replay (Zero TinyFish Calls, Sub-Second Replay)
  // --------------------------------------------------------------------------
  it("executes successful local deterministic replay with zero TinyFish API calls", async () => {
    const task = createTask("Arduino Uno");
    const skill = createActiveSkill();
    const adapter = createAdapter("/store-a");

    const result = await runner.executeReplay(task, skill, adapter);

    expect(result.status).toBe("SUCCESS");
    expect(result.structuredOutput).not.toBeNull();

    const output = result.structuredOutput as any;
    expect(output.title).toContain("Arduino Uno");
    expect(output.numericPrice).toBe(499); // Correctly parsed sale price, ignoring MRP 799
    expect(output.currency).toBe("INR");

    // PROOF: Zero TinyFish Agent calls
    expect(result.providerRunIds.tinyFishRunId).toBeUndefined();
    expect(result.durationMs).toBeLessThan(5000); // Sub-second/fast local execution
  });

  // --------------------------------------------------------------------------
  // 2. Price Parsing Differentiation (Sale vs Original vs EMI vs Unit)
  // --------------------------------------------------------------------------
  describe("Price Parser Granularity", () => {
    it("distinguishes sale price from strikethrough MRP", () => {
      const parsed = PriceParser.parse("MRP ₹799 Sale Price ₹499");
      expect(parsed.salePrice).toBe(499);
      expect(parsed.originalPrice).toBe(799);
      expect(parsed.currency).toBe("INR");
      expect(parsed.isAmbiguous).toBe(false);
    });

    it("detects and flags EMI installment pricing", () => {
      const parsed = PriceParser.parse("EMI starting at ₹249 / month");
      expect(parsed.emiPrice).toBe(249);
      expect(parsed.salePrice).toBeNull();
      expect(parsed.currency).toBe("INR");
    });

    it("detects and flags unit pricing", () => {
      const parsed = PriceParser.parse("₹45 per piece");
      expect(parsed.unitPrice).toBe(45);
      expect(parsed.salePrice).toBeNull();
    });

    it("never fabricates a missing price", () => {
      const parsed = PriceParser.parse("Call for pricing");
      expect(parsed.salePrice).toBeNull();
      expect(parsed.originalPrice).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Stale Selector / DOM Mutation Detection (STUCK / BINDING_FAILED)
  // --------------------------------------------------------------------------
  it("detects stale selector / DOM layout mutation and returns BINDING_FAILED", async () => {
    // Enable DOM mutation on test fixture
    mockServer.domMutated = true;

    try {
      const task = createTask("Arduino Uno");
      const skill = createActiveSkill();
      const adapter = createAdapter("/store-a"); // Stale adapter pointing to old class names

      const result = await runner.executeReplay(task, skill, adapter, { timeoutMs: 1500 });

      expect(result.status).toBe("STUCK");
      expect(result.errors[0]?.code).toBe("BINDING_FAILED");
    } finally {
      mockServer.domMutated = false;
    }
  }, 15000);

  // --------------------------------------------------------------------------
  // 4. Duplicate / Ambiguous Controls
  // --------------------------------------------------------------------------
  it("rejects duplicate search controls as ambiguous BINDING_FAILED", async () => {
    const task = createTask("Arduino Uno");
    const skill = createActiveSkill();
    const adapter = createAdapter("/store-duplicate", {
      locatorBindings: {
        SEARCH_INPUT: {
          semanticRole: "SEARCH_INPUT",
          locatorStrategy: "css",
          locatorValue: "input[name='s']",
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "localhost",
          version: "1.0.0",
        },
      } as any,
    });

    const result = await runner.executeReplay(task, skill, adapter, { timeoutMs: 2000 });

    expect(result.status).toBe("STUCK");
    expect(result.errors[0]?.code).toBe("BINDING_FAILED");
    expect(result.errors[0]?.message).toMatch(/Ambiguous/i);
  }, 15000);

  // --------------------------------------------------------------------------
  // 5. Empty / No Results
  // --------------------------------------------------------------------------
  it("handles zero search results safely without crashing", async () => {
    const task = createTask("empty_results_query");
    const skill = createActiveSkill();
    const adapter = createAdapter("/store-a");

    const result = await runner.executeReplay(task, skill, adapter, { timeoutMs: 1500 });

    expect(result.status).toBe("STUCK");
    expect(result.errors[0]?.code).toBe("BINDING_FAILED");
    expect(result.errors[0]?.message).toContain("No product cards found");
  }, 15000);

  // --------------------------------------------------------------------------
  // 6. Accessory Mismatch Filter (NEEDS_REVIEW)
  // --------------------------------------------------------------------------
  it("filters out accessory items when searching for primary device", async () => {
    const task = createTask("Smart Watch");
    const skill = createActiveSkill();
    const adapter = createAdapter("/store-a");

    const result = await runner.executeReplay(task, skill, adapter);

    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.errors[0]?.code).toBe("MISMATCH");
    expect(result.errors[0]?.message).toContain("accessory");
  }, 15000);

  // --------------------------------------------------------------------------
  // 7. Block Page Detection (HTTP 403 / Access Denied -> BLOCKED)
  // --------------------------------------------------------------------------
  it("detects bot block / HTTP 403 and halts with BLOCKED status", async () => {
    const task = createTask("Arduino Uno");
    const skill = createActiveSkill();
    const adapter = createAdapter("/store-blocked");

    const result = await runner.executeReplay(task, skill, adapter);

    expect(result.status).toBe("BLOCKED");
    expect(result.errors[0]?.code).toBe("ACCESS_RESTRICTED");
  });

  // --------------------------------------------------------------------------
  // 8. Disallowed Target Domain
  // --------------------------------------------------------------------------
  it("rejects replay navigation to unapproved domain", async () => {
    const task = createTask("Arduino Uno");
    const skill = createActiveSkill();
    const adapter = createAdapter("/store-a", {
      domain: "unauthorized-malicious-domain.com",
    });

    const result = await runner.executeReplay(task, skill, adapter);

    expect(result.status).toBe("BLOCKED");
    expect(result.errors[0]?.code).toBe("DISALLOWED_DOMAIN");
  });
});
