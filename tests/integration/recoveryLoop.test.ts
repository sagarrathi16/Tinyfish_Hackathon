import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { RunStatus } from "@tiny-fish/sdk";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import { PlaywrightRunner } from "../../src/executor/playwrightRunner.js";
import { ValidatorWorker } from "../../src/validator/validatorWorker.js";
import { RecoveryAgent } from "../../src/agents/recovery.js";
import { TinyFishClient } from "../../src/agents/tinyfishClient.js";
import { MockStoreServer } from "../../src/fixtures/mockStoreServer.js";
import type { AgentTask, SiteAdapter, Skill } from "../../src/types/domain.js";

describe("Flagship E2E Loop: Replay -> Mutation -> Detection -> Recovery -> 2-Query Validation -> Promotion -> Replay v2", () => {
  let server: MockStoreServer;
  let baseUrl: string;
  let db: ReturnType<typeof DatabaseConstructor>;
  let repo: Repository;
  let runner: PlaywrightRunner;
  let validator: ValidatorWorker;
  let recoveryAgent: RecoveryAgent;
  let mockClient: TinyFishClient;
  let initialV1Adapter: SiteAdapter;

  const mockSkill: Skill = {
    id: randomUUID(),
    name: "Product Discovery Skill",
    taskType: "PRODUCT_LOOKUP",
    version: "1.0.0",
    status: "ACTIVE",
    taskTemplate: [
      { order: 1, stepName: "OPEN", description: "Open entry URL", postcondition: "PAGE_LOADED" },
      { order: 2, stepName: "SEARCH", description: "Fill search box and submit", postcondition: "SEARCH_SUBMITTED" },
      { order: 3, stepName: "PARSE", description: "Parse candidate listing items", postcondition: "ITEMS_FOUND" },
      { order: 4, stepName: "SELECT", description: "Select target item", postcondition: "ITEM_SELECTED" },
      { order: 5, stepName: "CONFIRM", description: "Verify final product", postcondition: "PRODUCT_VERIFIED" },
    ],
    outputSchema: { type: "object" },
    postconditions: [],
    sourceRunIds: ["initial-teach-run-1"],
    tests: [],
    limitations: [],
    timestamps: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      promotedAt: new Date().toISOString(),
    },
  };

  beforeAll(async () => {
    server = new MockStoreServer();
    baseUrl = await server.start();

    initialV1Adapter = {
      domain: "localhost",
      adapterVersion: "1.0.0",
      status: "ACTIVE",
      locatorBindings: {
        OPEN: {
          semanticRole: "PAGE_ROOT",
          locatorStrategy: "css",
          locatorValue: "body",
          anchorEvidence: {},
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "localhost",
          version: "1.0.0",
        },
        SEARCH_INPUT: {
          semanticRole: "SEARCH_INPUT",
          locatorStrategy: "css",
          locatorValue: "input[type='search']",
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
          anchorEvidence: {},
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
        entryUrl: `${baseUrl}/store-a`,
      },
      evidence: {
        traceId: "initial-teach-trace-1",
      },
      source: "agent",
      validationQueries: ["Arduino Uno"],
      validationResults: [],
      createdAt: new Date().toISOString(),
      promotedAt: new Date().toISOString(),
    };

    db = new DatabaseConstructor(":memory:");
    initSchema(db);
    repo = new Repository(db);
    repo.saveSkill(mockSkill);
    repo.saveSiteAdapter(initialV1Adapter);

    runner = new PlaywrightRunner(repo);
    validator = new ValidatorWorker(repo);
    mockClient = new TinyFishClient();
    recoveryAgent = new RecoveryAgent(mockClient, repo);
  }, 20000);

  afterAll(async () => {
    await server.stop();
    db.close();
    vi.restoreAllMocks();
  });

  function createTask(goal: string, query: string): AgentTask {
    return {
      taskId: randomUUID(),
      jobId: randomUUID(),
      role: "EXECUTOR",
      goal,
      site: "localhost",
      inputPayload: { query },
      deadline: new Date(Date.now() + 60000).toISOString(),
      correlationId: randomUUID(),
      maxSteps: 10,
      budget: { maxSeconds: 30, maxUsd: 0.5 },
    };
  }

  it("executes the entire self-healing recovery loop from mutation to promotion and v2 replay", async () => {
    // -------------------------------------------------------------------------
    // Phase 1: Normal Replay on v1.0.0 (Zero TinyFish calls)
    // -------------------------------------------------------------------------
    const task1 = createTask("Search for Arduino Uno", "Arduino Uno");

    const replayResult1 = await runner.executeReplay(task1, mockSkill, initialV1Adapter);
    expect(replayResult1.status).toBe("SUCCESS");
    expect(replayResult1.providerRunIds.tinyFishRunId).toBeUndefined(); // Zero TinyFish API calls
    const valResult1 = validator.validateResult(task1, replayResult1, initialV1Adapter);
    expect(valResult1.status).toBe("PASS");

    // -------------------------------------------------------------------------
    // Phase 2: Controlled DOM Mutation on Owned Fixture
    // -------------------------------------------------------------------------
    server.domMutated = true; // Mutates .product-grid-item -> .mutated-card-node

    // -------------------------------------------------------------------------
    // Phase 3: Detect Failure (Refuse silent wrong answer)
    // -------------------------------------------------------------------------
    const task2 = createTask("Search for Arduino Uno on mutated page", "Arduino Uno");

    const replayResult2 = await runner.executeReplay(task2, mockSkill, initialV1Adapter, { timeoutMs: 1500 });
    expect(replayResult2.status).toBe("STUCK");
    expect(replayResult2.errors[0]?.code).toBe("BINDING_FAILED");

    // Deterministic Validator catches the failure
    const valResult2 = validator.validateResult(task2, replayResult2, initialV1Adapter);
    expect(valResult2.status).toBe("FAIL");
    expect(valResult2.failureCategory).toBe("BINDING_FAILED");

    // -------------------------------------------------------------------------
    // Phase 4: Autonomous Recovery Agent diagnoses page & synthesizes Candidate v1.1.0
    // -------------------------------------------------------------------------
    const recoveryRunId = "tf-recovery-run-e2e-123";
    vi.spyOn(mockClient, "runAutomation").mockResolvedValueOnce({
      runId: recoveryRunId,
      status: RunStatus.COMPLETED,
      durationMs: 2800,
      numOfSteps: 3,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: {
        repaired_binding: {
          semantic_role: "PRODUCT_CARD",
          repaired_selector: ".mutated-card-node", // The mutated card selector!
          anchor_attribute: "mutated card container",
          explanation: "Listing card container mutated to .mutated-card-node",
        },
        verification_product: {
          title: "Arduino Uno R3 Compatible Board",
          price: "₹499.00",
          product_url: `${baseUrl}/product/arduino-uno`,
        },
      },
    });

    const recoveryOutcome = await recoveryAgent.recoverBinding({
      task: task2,
      activeAdapter: initialV1Adapter,
      failingBindingKey: "PRODUCT_CARD",
      failureDetails: {
        code: "BINDING_FAILED",
        message: replayResult2.errors[0].message,
        currentUrl: `${baseUrl}/store-a`,
      },
      query: "Arduino Uno",
    });

    const candidateAdapter = recoveryOutcome.candidateAdapter;
    expect(candidateAdapter.status).toBe("CANDIDATE"); // Must remain CANDIDATE
    expect(candidateAdapter.adapterVersion).toBe("1.1.0");
    expect(candidateAdapter.locatorBindings.PRODUCT_CARD.locatorValue).toBe(".mutated-card-node");

    // -------------------------------------------------------------------------
    // Phase 5: Independent Candidate Validation Gate across TWO distinct queries
    // -------------------------------------------------------------------------
    // Validation Query 1: "Arduino Uno"
    const valTaskA = createTask("Validate candidate with Arduino Uno", "Arduino Uno");
    const valExecutionA = await runner.executeReplay(valTaskA, mockSkill, candidateAdapter);
    expect(valExecutionA.status).toBe("SUCCESS");
    const valResultA = validator.validateResult(valTaskA, valExecutionA, candidateAdapter);
    expect(valResultA.status).toBe("PASS");

    // Validation Query 2: "ESP32" (Distinct query!)
    const valTaskB = createTask("Validate candidate with ESP32", "ESP32");
    const valExecutionB = await runner.executeReplay(valTaskB, mockSkill, candidateAdapter);
    expect(valExecutionB.status).toBe("SUCCESS");
    const valResultB = validator.validateResult(valTaskB, valExecutionB, candidateAdapter);
    expect(valResultB.status).toBe("PASS");

    // Run Promotion Gate check
    const gateDecision = validator.validateCandidateForPromotion(candidateAdapter, [
      { query: "Arduino Uno", result: valResultA },
      { query: "ESP32", result: valResultB },
    ]);
    expect(gateDecision.eligible).toBe(true);

    // -------------------------------------------------------------------------
    // Phase 6: Atomic Promotion of v1.1.0 to ACTIVE
    // -------------------------------------------------------------------------
    repo.promoteSiteAdapter("localhost", "1.1.0");

    // Verify repository state
    const activeAdapter = repo.getActiveSiteAdapter("localhost");
    expect(activeAdapter?.adapterVersion).toBe("1.1.0");
    expect(activeAdapter?.status).toBe("ACTIVE");

    const retiredV1 = repo.getSiteAdapter("localhost", "1.0.0");
    expect(retiredV1?.status).toBe("RETIRED"); // V1 archived for rollback safety

    // -------------------------------------------------------------------------
    // Phase 7: Subsequent Fast Replay on Active v1.1.0 (Zero TinyFish calls)
    // -------------------------------------------------------------------------
    const task3 = createTask("Search for Raspberry Pi on healed v1.1.0 adapter", "Raspberry Pi");

    const replayResult3 = await runner.executeReplay(task3, mockSkill, activeAdapter!);
    expect(replayResult3.status).toBe("SUCCESS");
    expect(replayResult3.providerRunIds.tinyFishRunId).toBeUndefined(); // Zero Agent calls
    expect(replayResult3.durationMs).toBeLessThan(4000);

    const valResult3 = validator.validateResult(task3, replayResult3, activeAdapter!);
    expect(valResult3.status).toBe("PASS");
    expect(valResult3.checks.stepPostconditions.every((s) => s.passed)).toBe(true);

    // Reset DOM mutation for clean state
    server.domMutated = false;
  }, 30000);
});
