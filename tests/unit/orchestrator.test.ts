import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { RunStatus } from "@tiny-fish/sdk";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import { OrchestratorStateMachine } from "../../src/orchestrator/stateMachine.js";
import { ConcurrencyLimiter, JobBudgetTracker, JobBudgetExceededError } from "../../src/orchestrator/concurrencyBudget.js";
import { ShadowTwinOrchestrator } from "../../src/orchestrator/orchestrator.js";
import { ExplorerAgent } from "../../src/agents/explorer.js";
import { CompilerAgent } from "../../src/agents/compiler.js";
import { PlaywrightRunner } from "../../src/executor/playwrightRunner.js";
import { ValidatorWorker } from "../../src/validator/validatorWorker.js";
import { RecoveryAgent } from "../../src/agents/recovery.js";
import type { AgentResult, SiteAdapter, Skill } from "../../src/types/domain.js";

describe("Deterministic Orchestrator & State Machine", () => {
  let db: ReturnType<typeof DatabaseConstructor>;
  let repo: Repository;

  beforeEach(() => {
    db = new DatabaseConstructor(":memory:");
    initSchema(db);
    repo = new Repository(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  describe("State Machine Transition Integrity", () => {
    it("allows valid forward induction transitions (READY -> TEACHING -> COMPILING -> VALIDATING_CANDIDATE -> ACTIVE)", () => {
      const sm = new OrchestratorStateMachine(randomUUID(), "robu.in", repo);
      expect(sm.getState()).toBe("READY");

      expect(sm.transition("TEACHING")).toBe("TEACHING");
      expect(sm.transition("COMPILING")).toBe("COMPILING");
      expect(sm.transition("VALIDATING_CANDIDATE")).toBe("VALIDATING_CANDIDATE");
      expect(sm.transition("ACTIVE")).toBe("ACTIVE");
    });

    it("allows recovery branch transitions (ACTIVE -> EXECUTING -> STUCK -> RECOVERING -> VALIDATING_CANDIDATE -> ACTIVE)", () => {
      const sm = new OrchestratorStateMachine(randomUUID(), "robu.in", repo, "ACTIVE");
      expect(sm.getState()).toBe("ACTIVE");

      expect(sm.transition("EXECUTING")).toBe("EXECUTING");
      expect(sm.transition("STUCK")).toBe("STUCK");
      expect(sm.transition("RECOVERING")).toBe("RECOVERING");
      expect(sm.transition("VALIDATING_CANDIDATE")).toBe("VALIDATING_CANDIDATE");
      expect(sm.transition("ACTIVE")).toBe("ACTIVE");
    });

    it("rejects illegal transitions and throws informative error (e.g. READY directly to ACTIVE)", () => {
      const sm = new OrchestratorStateMachine(randomUUID(), "robu.in", repo);
      expect(() => sm.transition("ACTIVE")).toThrow(
        "Illegal state machine transition: cannot move from 'READY' to 'ACTIVE'"
      );
    });

    it("persists all state transitions as events in SQLite repository", () => {
      const jobId = randomUUID();
      const sm = new OrchestratorStateMachine(jobId, "robu.in", repo);
      sm.transition("TEACHING", { reason: "Starting exploration" });
      sm.transition("COMPILING", { reason: "Synthesizing skill" });

      const events = repo.getEventsByJob(jobId);
      expect(events.length).toBe(2);
      expect(events[0].state).toBe("TEACHING");
      expect(events[1].state).toBe("COMPILING");
    });
  });

  describe("Concurrency Limiter & Job Budget Tracker", () => {
    it("bounds concurrency to max concurrent limit", async () => {
      const limiter = new ConcurrencyLimiter(2);
      const release1 = await limiter.acquire();
      const release2 = await limiter.acquire();
      expect(limiter.activeCount).toBe(2);

      let thirdAcquired = false;
      limiter.acquire().then(() => {
        thirdAcquired = true;
      });

      expect(thirdAcquired).toBe(false); // Waiting in queue
      release1(); // Release one permit
      await new Promise((r) => setTimeout(r, 10)); // Tick microtask
      expect(thirdAcquired).toBe(true);
    });

    it("enforces agent calls budget limit and halts when exceeded", () => {
      const tracker = new JobBudgetTracker(randomUUID(), 2, 60);
      tracker.recordAgentCall(0.01);
      tracker.recordAgentCall(0.01);

      expect(() => tracker.recordAgentCall(0.01)).toThrow(JobBudgetExceededError);
    });

    it("enforces job timeout and halts when exceeded", async () => {
      const tracker = new JobBudgetTracker(randomUUID(), 10, 0.05); // 50ms timeout
      await new Promise((r) => setTimeout(r, 80));
      expect(() => tracker.checkTimeout()).toThrow(JobBudgetExceededError);
    });
  });

  describe("Orchestrator Teach & Induction Flow", () => {
    it("executes induction: explores site, compiles skill, validates candidate, and promotes to ACTIVE", async () => {
      const mockExplorer = new ExplorerAgent(undefined, repo);
      const mockCompiler = new CompilerAgent(repo);
      const mockRunner = new PlaywrightRunner(repo);
      const mockValidator = new ValidatorWorker(repo);

      const runId = "tf-exploration-trace-001";
      vi.spyOn(mockExplorer, "explore").mockResolvedValueOnce({
        taskId: randomUUID(),
        jobId: randomUUID(),
        status: "SUCCESS",
        structuredOutput: {
          product: {
            title: "Arduino Uno R3 Board",
            numeric_price: 499,
            currency: "₹",
            product_url: "https://robu.in/product/arduino-uno",
            evidence_url: "https://robu.in",
            retrieval_time: new Date().toISOString(),
            evidence_explanation: "Extracted from search",
          },
          candidate_bindings: {
            search_input_selector: "input#search",
            search_input_anchor: "Search",
            product_card_selector: ".card",
            product_card_anchor: "card",
            title_selector: ".title",
            title_anchor: "title",
            price_selector: ".price",
            price_anchor: "price",
            evidence_explanation: "Stable attributes",
          },
        },
        evidenceReferences: ["https://robu.in/product/arduino-uno"],
        providerRunIds: { tinyFishRunId: runId },
        durationMs: 4000,
        errors: [],
        warnings: [],
        stepsUsage: null,
      });

      // Mock candidate query executions dynamically matching each query
      vi.spyOn(mockRunner, "executeReplay").mockImplementation(async (task) => {
        const q = (task.inputPayload?.query as string) || "Arduino Uno";
        return {
          taskId: task.taskId,
          jobId: task.jobId,
          status: "SUCCESS",
          structuredOutput: {
            title: q.includes("ESP32") ? "ESP32 DevKit V1 Board" : "Arduino Uno R3 Board",
            numericPrice: q.includes("ESP32") ? 350 : 499,
            currency: "₹",
            productUrl: `https://robu.in/product/${q.toLowerCase().replace(/\s+/g, "-")}`,
            retrievalTime: new Date().toISOString(),
          },
          evidenceReferences: ["https://robu.in"],
          providerRunIds: {},
          stepsUsage: { stepsCompleted: 5 },
          durationMs: 1200,
          errors: [],
          warnings: [],
        };
      });

      const orchestrator = new ShadowTwinOrchestrator(
        repo,
        mockExplorer,
        mockCompiler,
        mockRunner,
        mockValidator
      );

      const outcome = await orchestrator.teach({
        domain: "robu.in",
        entryUrl: "https://robu.in",
        sampleQuery: "Arduino Uno",
        validationQueries: ["ESP32 DevKit"],
      });

      expect(outcome.status).toBe("SUCCESS");
      expect(outcome.finalState).toBe("ACTIVE");

      // Verify active promotion in repository
      const activeAdapter = repo.getActiveSiteAdapter("robu.in");
      expect(activeAdapter).toBeDefined();
      expect(activeAdapter?.status).toBe("ACTIVE");

      const activeSkill = repo.getActiveSkill();
      expect(activeSkill).toBeDefined();
      expect(activeSkill?.status).toBe("ACTIVE");
    });
  });

  describe("Orchestrator Deterministic Replay & Self-Healing", () => {
    it("replays active workflow deterministically with strictly 0 TinyFish calls", async () => {
      const activeSkill: Skill = {
        id: randomUUID(),
        name: "Product Lookup",
        taskType: "PRODUCT_LOOKUP",
        version: "1.0.0",
        status: "ACTIVE",
        taskTemplate: [{ order: 1, stepName: "OPEN", description: "Open", postcondition: "Pass" }],
        outputSchema: {},
        postconditions: [],
        sourceRunIds: ["run-1"],
        tests: [],
        limitations: [],
        timestamps: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      };

      const activeAdapter: SiteAdapter = {
        domain: "robu.in",
        adapterVersion: "1.0.0",
        status: "ACTIVE",
        locatorBindings: {
          SEARCH_INPUT: {
            semanticRole: "SEARCH_INPUT",
            locatorStrategy: "css",
            locatorValue: "input#search",
            anchorEvidence: {},
            uniquenessExpectation: "SINGLE",
            provenance: "TINYFISH_EXPLORER",
            domain: "robu.in",
            version: "1.0.0",
          },
        },
        urlPatterns: { entryUrl: "https://robu.in" },
        evidence: {},
        source: "agent",
        validationQueries: [],
        validationResults: [],
        createdAt: new Date().toISOString(),
      };

      repo.saveSkill(activeSkill);
      repo.saveSiteAdapter(activeAdapter);

      const mockRunner = new PlaywrightRunner(repo);
      const mockValidator = new ValidatorWorker(repo);

      vi.spyOn(mockRunner, "executeReplay").mockResolvedValueOnce({
        taskId: randomUUID(),
        jobId: randomUUID(),
        status: "SUCCESS",
        structuredOutput: {
          title: "Raspberry Pi 5 Model B",
          numericPrice: 7999,
          currency: "₹",
          productUrl: "https://robu.in/product/pi-5",
          retrievalTime: new Date().toISOString(),
        },
        evidenceReferences: ["https://robu.in/product/pi-5"],
        providerRunIds: {},
        stepsUsage: { stepsCompleted: 5 },
        durationMs: 1400,
        errors: [],
        warnings: [],
      });

      const orchestrator = new ShadowTwinOrchestrator(
        repo,
        undefined,
        undefined,
        mockRunner,
        mockValidator
      );

      const outcome = await orchestrator.execute({
        domain: "robu.in",
        query: "Raspberry Pi 5",
      });

      expect(outcome.status).toBe("SUCCESS");
      expect(outcome.finalState).toBe("DONE");
      expect(outcome.agentCallsCount).toBe(0); // STRICT REPLAY PROOF: 0 TinyFish calls
      expect(outcome.selfHealed).toBe(false);
      expect(outcome.product?.title).toBe("Raspberry Pi 5 Model B");
    });
  });
});
