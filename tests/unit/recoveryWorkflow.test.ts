import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { RunStatus } from "@tiny-fish/sdk";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import { ShadowTwinOrchestrator } from "../../src/orchestrator/orchestrator.js";
import { PlaywrightRunner } from "../../src/executor/playwrightRunner.js";
import { ValidatorWorker } from "../../src/validator/validatorWorker.js";
import { RecoveryAgent } from "../../src/agents/recovery.js";
import { TinyFishClient } from "../../src/agents/tinyfishClient.js";
import type { AgentResult, SiteAdapter, Skill } from "../../src/types/domain.js";

describe("Recovery Agent & Promotion Workflow", () => {
  let db: ReturnType<typeof DatabaseConstructor>;
  let repo: Repository;
  let mockClient: TinyFishClient;
  let recoveryAgent: RecoveryAgent;
  let runner: PlaywrightRunner;
  let validator: ValidatorWorker;
  let orchestrator: ShadowTwinOrchestrator;

  const activeSkill: Skill = {
    id: randomUUID(),
    name: "Product Discovery Skill",
    taskType: "PRODUCT_LOOKUP",
    version: "1.0.0",
    status: "ACTIVE",
    taskTemplate: [
      { order: 1, stepName: "OPEN", description: "Open", postcondition: "PAGE_LOADED" },
      { order: 2, stepName: "SEARCH", description: "Search", postcondition: "SEARCH_SUBMITTED" },
      { order: 3, stepName: "PARSE", description: "Parse", postcondition: "ITEMS_FOUND" },
      { order: 4, stepName: "SELECT", description: "Select", postcondition: "ITEM_SELECTED" },
      { order: 5, stepName: "CONFIRM", description: "Confirm", postcondition: "PRODUCT_VERIFIED" },
    ],
    outputSchema: { type: "object" },
    postconditions: [],
    sourceRunIds: ["initial-run"],
    tests: [],
    limitations: [],
    timestamps: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      promotedAt: new Date().toISOString(),
    },
  };

  const initialV1Adapter: SiteAdapter = {
    domain: "robu.in",
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
        domain: "robu.in",
        version: "1.0.0",
      },
      SEARCH_INPUT: {
        semanticRole: "SEARCH_INPUT",
        locatorStrategy: "css",
        locatorValue: "input#search-box",
        anchorEvidence: { text: "Search" },
        uniquenessExpectation: "SINGLE",
        provenance: "TINYFISH_EXPLORER",
        domain: "robu.in",
        version: "1.0.0",
      },
      PRODUCT_CARD: {
        semanticRole: "PRODUCT_CARD",
        locatorStrategy: "css",
        locatorValue: ".product-item-old", // Broken selector
        anchorEvidence: {},
        uniquenessExpectation: "MULTIPLE",
        provenance: "TINYFISH_EXPLORER",
        domain: "robu.in",
        version: "1.0.0",
      },
      PRODUCT_TITLE: {
        semanticRole: "PRODUCT_TITLE",
        locatorStrategy: "css",
        locatorValue: ".title",
        anchorEvidence: {},
        uniquenessExpectation: "SINGLE",
        provenance: "TINYFISH_EXPLORER",
        domain: "robu.in",
        version: "1.0.0",
      },
      PRODUCT_PRICE: {
        semanticRole: "PRODUCT_PRICE",
        locatorStrategy: "css",
        locatorValue: ".price",
        anchorEvidence: {},
        uniquenessExpectation: "SINGLE",
        provenance: "TINYFISH_EXPLORER",
        domain: "robu.in",
        version: "1.0.0",
      },
    },
    urlPatterns: {
      entryUrl: "https://robu.in",
      searchUrlTemplate: "https://robu.in/?s={query}",
    },
    evidence: { traceId: "initial-trace-1" },
    source: "agent",
    validationQueries: ["Arduino Uno", "ESP32"],
    validationResults: [],
    createdAt: new Date().toISOString(),
    promotedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    db = new DatabaseConstructor(":memory:");
    initSchema(db);
    repo = new Repository(db);

    repo.saveSkill(activeSkill);
    repo.saveSiteAdapter(initialV1Adapter);

    mockClient = new TinyFishClient();
    recoveryAgent = new RecoveryAgent(mockClient, repo);
    runner = new PlaywrightRunner(repo);
    validator = new ValidatorWorker(repo);

    orchestrator = new ShadowTwinOrchestrator(
      repo,
      undefined,
      undefined,
      runner,
      validator,
      recoveryAgent
    );
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Successful Recovery & Atomic Promotion
  // ==========================================================================
  it("executes successful self-healing recovery, 2-query validation gate, atomic promotion, and zero-agent subsequent run", async () => {
    const recoveryRunId = "tf-recovery-trace-42";

    // 1. Initial replay fails on broken selector
    vi.spyOn(runner, "executeReplay")
      .mockResolvedValueOnce({
        taskId: randomUUID(),
        jobId: randomUUID(),
        status: "STUCK",
        structuredOutput: undefined,
        evidenceReferences: ["https://robu.in"],
        providerRunIds: {},
        stepsUsage: { stepsCompleted: 2 },
        durationMs: 1500,
        errors: [{ code: "BINDING_FAILED", message: "Step PARSE failed: Selector .product-item-old not found" }],
        warnings: [],
      })
      // 2. Validation Query 1 on candidate adapter succeeds
      .mockResolvedValueOnce({
        taskId: randomUUID(),
        jobId: randomUUID(),
        status: "SUCCESS",
        structuredOutput: {
          title: "Arduino Uno R3 Compatible Board",
          numericPrice: 499,
          currency: "₹",
          price: "₹499.00",
          productUrl: "https://robu.in/product/arduino-uno-r3",
          retrievalTime: new Date().toISOString(),
        },
        evidenceReferences: ["https://robu.in/product/arduino-uno-r3"],
        providerRunIds: {},
        stepsUsage: { stepsCompleted: 5 },
        durationMs: 1100,
        errors: [],
        warnings: [],
      })
      // 3. Validation Query 2 on candidate adapter succeeds
      .mockResolvedValueOnce({
        taskId: randomUUID(),
        jobId: randomUUID(),
        status: "SUCCESS",
        structuredOutput: {
          title: "ESP32 NodeMCU WiFi Development Board",
          numericPrice: 320,
          currency: "₹",
          price: "₹320.00",
          productUrl: "https://robu.in/product/esp32-nodemcu",
          retrievalTime: new Date().toISOString(),
        },
        evidenceReferences: ["https://robu.in/product/esp32-nodemcu"],
        providerRunIds: {},
        stepsUsage: { stepsCompleted: 5 },
        durationMs: 1150,
        errors: [],
        warnings: [],
      });

    // Mock TinyFish Recovery Agent proposing resilient selector
    const recoverySpy = vi.spyOn(mockClient, "runAutomation").mockResolvedValueOnce({
      runId: recoveryRunId,
      status: RunStatus.COMPLETED,
      durationMs: 3200,
      numOfSteps: 3,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: {
        repaired_binding: {
          semantic_role: "PRODUCT_CARD",
          locator_strategy: "css",
          repaired_selector: ".mutated-card-node",
          anchor_evidence: {
            role: "article",
            label: "Product Card",
            nearby_structure: "div.product-grid",
          },
          explanation: "Site updated container from .product-item-old to .mutated-card-node",
        },
        verification_product: {
          title: "Arduino Uno R3 Compatible Board",
          price: "₹499.00",
          product_url: "https://robu.in/product/arduino-uno-r3",
        },
      },
    });

    const outcome = await orchestrator.execute({
      domain: "robu.in",
      query: "Arduino Uno",
      fallbackValidationQuery: "ESP32",
    });

    // Verify recovery outcome
    expect(outcome.status).toBe("SUCCESS");
    expect(outcome.selfHealed).toBe(true);
    expect(outcome.activeVersion).toBe("1.1.0");
    expect(outcome.agentCallsCount).toBe(1); // Exactly 1 TinyFish recovery call

    // Verify atomic promotion in SQLite repository
    const activeAdapter = repo.getActiveSiteAdapter("robu.in");
    expect(activeAdapter).toBeDefined();
    expect(activeAdapter?.adapterVersion).toBe("1.1.0");
    expect(activeAdapter?.status).toBe("ACTIVE");
    expect(activeAdapter?.locatorBindings.PRODUCT_CARD.locatorValue).toBe(".mutated-card-node");

    // Verify previous version was retired atomically
    const v1 = repo.getSiteAdapter("robu.in", "1.0.0");
    expect(v1?.status).toBe("RETIRED");

    // Verify persisted trace record with diff
    const traces = repo.getTracesByJob(outcome.jobId);
    expect(traces.length).toBeGreaterThanOrEqual(1);
    const recoveryTrace = traces.find((t) => t.traceType === "RECOVERY_PROMOTION");
    expect(recoveryTrace).toBeDefined();
    expect((recoveryTrace?.data as any).beforeBinding).toBe(".product-item-old");
    expect((recoveryTrace?.data as any).afterBinding).toBe(".mutated-card-node");
    expect((recoveryTrace?.data as any).recoveryRunId).toBe(recoveryRunId);

    // 4. Verify subsequent execution runs with ZERO TinyFish calls
    vi.spyOn(runner, "executeReplay").mockResolvedValueOnce({
      taskId: randomUUID(),
      jobId: randomUUID(),
      status: "SUCCESS",
      structuredOutput: {
        title: "Raspberry Pi 5 Board",
        numericPrice: 7999,
        currency: "₹",
        price: "₹7999.00",
        productUrl: "https://robu.in/product/pi-5",
        retrievalTime: new Date().toISOString(),
      },
      evidenceReferences: ["https://robu.in/product/pi-5"],
      providerRunIds: {},
      stepsUsage: { stepsCompleted: 5 },
      durationMs: 1200,
      errors: [],
      warnings: [],
    });

    const subsequentOutcome = await orchestrator.execute({
      domain: "robu.in",
      query: "Raspberry Pi 5",
    });

    expect(subsequentOutcome.status).toBe("SUCCESS");
    expect(subsequentOutcome.selfHealed).toBe(false);
    expect(subsequentOutcome.activeVersion).toBe("1.1.0");
    expect(subsequentOutcome.agentCallsCount).toBe(0); // STRICT REPLAY PROOF: 0 Agent calls
  });

  // ==========================================================================
  // 2. Bad Proposed Selector Rejection
  // ==========================================================================
  it("rejects candidate adapter when proposed selector fails query validation and retains active v1.0.0", async () => {
    // Replay fails
    vi.spyOn(runner, "executeReplay")
      .mockResolvedValueOnce({
        taskId: randomUUID(),
        jobId: randomUUID(),
        status: "STUCK",
        structuredOutput: undefined,
        evidenceReferences: ["https://robu.in"],
        providerRunIds: {},
        stepsUsage: { stepsCompleted: 2 },
        durationMs: 1500,
        errors: [{ code: "BINDING_FAILED", message: "Step PARSE failed: missing cards" }],
        warnings: [],
      })
      // Candidate replay query 1 also fails because selector is bad
      .mockResolvedValueOnce({
        taskId: randomUUID(),
        jobId: randomUUID(),
        status: "STUCK",
        structuredOutput: undefined,
        evidenceReferences: ["https://robu.in"],
        providerRunIds: {},
        stepsUsage: { stepsCompleted: 2 },
        durationMs: 1500,
        errors: [{ code: "BINDING_FAILED", message: "Step PARSE failed: #non-existent-broken-selector not found" }],
        warnings: [],
      })
      // Candidate replay query 2 fails
      .mockResolvedValueOnce({
        taskId: randomUUID(),
        jobId: randomUUID(),
        status: "STUCK",
        structuredOutput: undefined,
        evidenceReferences: ["https://robu.in"],
        providerRunIds: {},
        stepsUsage: { stepsCompleted: 2 },
        durationMs: 1500,
        errors: [{ code: "BINDING_FAILED", message: "Step PARSE failed" }],
        warnings: [],
      });

    vi.spyOn(mockClient, "runAutomation").mockResolvedValueOnce({
      runId: "bad-selector-run",
      status: RunStatus.COMPLETED,
      durationMs: 2000,
      numOfSteps: 2,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: {
        repaired_binding: {
          semantic_role: "PRODUCT_CARD",
          locator_strategy: "css",
          repaired_selector: "#non-existent-broken-selector",
          anchor_evidence: {},
          explanation: "Guessed selector",
        },
        verification_product: {
          title: "Test",
          price: "100",
          product_url: "https://robu.in/p",
        },
      },
    });

    const outcome = await orchestrator.execute({
      domain: "robu.in",
      query: "Arduino Uno",
    });

    // Result must end in NEEDS_REVIEW
    expect(outcome.status).toBe("NEEDS_REVIEW");
    expect(outcome.selfHealed).toBe(false);

    // Active version MUST remain v1.0.0
    const active = repo.getActiveSiteAdapter("robu.in");
    expect(active?.adapterVersion).toBe("1.0.0");
    expect(active?.status).toBe("ACTIVE");

    // Candidate v1.1.0 must NOT be ACTIVE
    const candidate = repo.getSiteAdapter("robu.in", "1.1.0");
    expect(candidate?.status).toBe("CANDIDATE");
  });

  // ==========================================================================
  // 3. Only-One-Query-Pass (2-Query Gate Enforcement)
  // ==========================================================================
  it("rejects candidate when only 1 of 2 queries passes validation and moves job to NEEDS_REVIEW", async () => {
    vi.spyOn(runner, "executeReplay")
      .mockResolvedValueOnce({
        taskId: randomUUID(),
        jobId: randomUUID(),
        status: "STUCK",
        structuredOutput: undefined,
        evidenceReferences: ["https://robu.in"],
        providerRunIds: {},
        stepsUsage: { stepsCompleted: 2 },
        durationMs: 1500,
        errors: [{ code: "BINDING_FAILED", message: "Step PARSE failed" }],
        warnings: [],
      })
      // Query 1 passes
      .mockResolvedValueOnce({
        taskId: randomUUID(),
        jobId: randomUUID(),
        status: "SUCCESS",
        structuredOutput: {
          title: "Arduino Uno R3 Compatible Board",
          numericPrice: 499,
          currency: "₹",
          price: "₹499.00",
          productUrl: "https://robu.in/product/arduino-uno-r3",
          retrievalTime: new Date().toISOString(),
        },
        evidenceReferences: ["https://robu.in/product/arduino-uno-r3"],
        providerRunIds: {},
        stepsUsage: { stepsCompleted: 5 },
        durationMs: 1100,
        errors: [],
        warnings: [],
      })
      // Query 2 FAILS (e.g. wrong product / low coverage)
      .mockResolvedValueOnce({
        taskId: randomUUID(),
        jobId: randomUUID(),
        status: "SUCCESS",
        structuredOutput: {
          title: "Unrelated Sensor Cable for Arduino", // Accessory mismatch for ESP32!
          numericPrice: 99,
          currency: "₹",
          price: "₹99.00",
          productUrl: "https://robu.in/product/cable",
          retrievalTime: new Date().toISOString(),
        },
        evidenceReferences: ["https://robu.in/product/cable"],
        providerRunIds: {},
        stepsUsage: { stepsCompleted: 5 },
        durationMs: 1100,
        errors: [],
        warnings: [],
      });

    vi.spyOn(mockClient, "runAutomation").mockResolvedValueOnce({
      runId: "semi-working-run",
      status: RunStatus.COMPLETED,
      durationMs: 2500,
      numOfSteps: 3,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: {
        repaired_binding: {
          semantic_role: "PRODUCT_CARD",
          locator_strategy: "css",
          repaired_selector: ".fragile-item-node",
          anchor_evidence: {},
          explanation: "Fixed selector for Arduino only",
        },
        verification_product: {
          title: "Arduino Uno",
          price: "₹499",
          product_url: "https://robu.in/p",
        },
      },
    });

    const outcome = await orchestrator.execute({
      domain: "robu.in",
      query: "Arduino Uno",
      fallbackValidationQuery: "ESP32",
    });

    expect(outcome.status).toBe("NEEDS_REVIEW");
    expect(outcome.reason).toContain("failed");

    // Active version remains v1.0.0
    const active = repo.getActiveSiteAdapter("robu.in");
    expect(active?.adapterVersion).toBe("1.0.0");
  });

  // ==========================================================================
  // 4. Agent Timeout Safety
  // ==========================================================================
  it("handles Recovery Agent timeout gracefully without crashing and preserves active v1.0.0", async () => {
    vi.spyOn(runner, "executeReplay").mockResolvedValueOnce({
      taskId: randomUUID(),
      jobId: randomUUID(),
      status: "STUCK",
      structuredOutput: undefined,
      evidenceReferences: ["https://robu.in"],
      providerRunIds: {},
      stepsUsage: { stepsCompleted: 2 },
      durationMs: 1500,
      errors: [{ code: "BINDING_FAILED", message: "Step PARSE failed" }],
      warnings: [],
    });

    // Mock TinyFish timing out
    vi.spyOn(mockClient, "runAutomation").mockRejectedValueOnce(
      new Error("TinyFish Agent operation timed out after 60000ms")
    );

    const outcome = await orchestrator.execute({
      domain: "robu.in",
      query: "Arduino Uno",
    });

    expect(outcome.status).toBe("NEEDS_REVIEW");
    expect(outcome.reason).toContain("timed out");
    expect(outcome.selfHealed).toBe(false);

    // Active adapter unchanged
    const active = repo.getActiveSiteAdapter("robu.in");
    expect(active?.adapterVersion).toBe("1.0.0");
  });

  // ==========================================================================
  // 5. Budget Exceeded Safety
  // ==========================================================================
  it("aborts recovery immediately when agent run budget is already exhausted", async () => {
    vi.spyOn(runner, "executeReplay").mockResolvedValueOnce({
      taskId: randomUUID(),
      jobId: randomUUID(),
      status: "STUCK",
      structuredOutput: undefined,
      evidenceReferences: ["https://robu.in"],
      providerRunIds: {},
      stepsUsage: { stepsCompleted: 2 },
      durationMs: 1500,
      errors: [{ code: "BINDING_FAILED", message: "Step PARSE failed" }],
      warnings: [],
    });

    const agentCallSpy = vi.spyOn(mockClient, "runAutomation");

    // Pass maxAgentRuns: 0 to simulate exhausted budget
    const outcome = await orchestrator.execute({
      domain: "robu.in",
      query: "Arduino Uno",
      budget: { maxAgentRuns: 0, maxCostUsd: 0 },
    });

    expect(outcome.status).toBe("NEEDS_REVIEW");
    expect(outcome.reason).toContain("budget exhausted");
    expect(agentCallSpy).not.toHaveBeenCalled(); // ZERO agent calls allowed!

    // Active adapter remains v1.0.0
    const active = repo.getActiveSiteAdapter("robu.in");
    expect(active?.adapterVersion).toBe("1.0.0");
  });

  // ==========================================================================
  // 6. Blocked Site Non-Recoverable Failure
  // ==========================================================================
  it("does not trigger recovery when the replay failure is BLOCKED (Cloudflare / CAPTCHA)", async () => {
    vi.spyOn(runner, "executeReplay").mockResolvedValueOnce({
      taskId: randomUUID(),
      jobId: randomUUID(),
      status: "BLOCKED",
      structuredOutput: undefined,
      evidenceReferences: ["https://robu.in"],
      providerRunIds: {},
      stepsUsage: { stepsCompleted: 1 },
      durationMs: 800,
      errors: [{ code: "BOT_DETECTED", message: "Cloudflare Turnstile challenge presented" }],
      warnings: [],
    });

    const agentCallSpy = vi.spyOn(mockClient, "runAutomation");

    const outcome = await orchestrator.execute({
      domain: "robu.in",
      query: "Arduino Uno",
    });

    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toContain("blocked");
    expect(agentCallSpy).not.toHaveBeenCalled(); // Prohibited from triggering recovery!

    const active = repo.getActiveSiteAdapter("robu.in");
    expect(active?.adapterVersion).toBe("1.0.0");
  });

  // ==========================================================================
  // 7. Rollback & Immutability Guarantee
  // ==========================================================================
  it("guarantees Recovery Agent never marks candidate ACTIVE directly, and supports atomic rollback", async () => {
    // 1. Manually run Recovery Agent
    vi.spyOn(mockClient, "runAutomation").mockResolvedValueOnce({
      runId: "candidate-immutability-run",
      status: RunStatus.COMPLETED,
      durationMs: 2000,
      numOfSteps: 2,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: {
        repaired_binding: {
          semantic_role: "PRODUCT_CARD",
          locator_strategy: "css",
          repaired_selector: ".candidate-card",
          anchor_evidence: {},
          explanation: "Fixed",
        },
        verification_product: {
          title: "Arduino",
          price: "499",
          product_url: "https://robu.in/p",
        },
      },
    });

    const recoveryOutcome = await recoveryAgent.recoverBinding({
      task: {
        taskId: randomUUID(),
        jobId: randomUUID(),
        role: "RECOVERY",
        goal: "Repair card",
        site: "robu.in",
        deadline: new Date(Date.now() + 60000).toISOString(),
        correlationId: randomUUID(),
      },
      activeAdapter: initialV1Adapter,
      failingBindingKey: "PRODUCT_CARD",
      failureDetails: { code: "BINDING_FAILED", message: "Missing card" },
      query: "Arduino Uno",
    });

    // Guardrail check: candidate must be CANDIDATE, never ACTIVE
    expect(recoveryOutcome.candidateAdapter.status).toBe("CANDIDATE");
    const activeInRepo = repo.getActiveSiteAdapter("robu.in");
    expect(activeInRepo?.adapterVersion).toBe("1.0.0");
    expect(activeInRepo?.status).toBe("ACTIVE");

    // 2. Promote to 1.1.0
    repo.promoteSiteAdapter("robu.in", "1.1.0");
    const newActive = repo.getActiveSiteAdapter("robu.in");
    expect(newActive?.adapterVersion).toBe("1.1.0");
    expect(newActive?.status).toBe("ACTIVE");

    // 3. Rollback to 1.0.0 atomically
    const rolledBack = repo.rollbackSiteAdapter("robu.in", "1.0.0");
    expect(rolledBack.adapterVersion).toBe("1.0.0");
    expect(rolledBack.status).toBe("ACTIVE");

    // Super-check: 1.1.0 is now RETIRED
    const retiredV11 = repo.getSiteAdapter("robu.in", "1.1.0");
    expect(retiredV11?.status).toBe("RETIRED");
  });
});

