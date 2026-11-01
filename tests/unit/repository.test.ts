import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDatabase } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import {
  AgentResultSchema,
  AgentTaskSchema,
  BenchmarkRecordSchema,
  RunEventSchema,
  SiteAdapterSchema,
  SkillSchema,
  StepBindingSchema,
  ValidationResultSchema,
  type AgentResult,
  type AgentTask,
  type BenchmarkRecord,
  type RunEvent,
  type SiteAdapter,
  type Skill,
  type StepBinding,
  type ValidationResult,
} from "../../src/types/domain.js";

describe("Domain Schemas & Persistence Repository", () => {
  let repo: Repository;
  let inMemoryDb: ReturnType<typeof DatabaseConstructor>;

  beforeEach(() => {
    // Isolated in-memory database for each test
    inMemoryDb = new DatabaseConstructor(":memory:");
    inMemoryDb.pragma("journal_mode = WAL");
    inMemoryDb.pragma("foreign_keys = ON");

    // Initialize tables using database helper logic
    const db = getDatabase(":memory:");
    repo = new Repository(db);
  });

  afterEach(() => {
    repo.resetDemoStorage();
  });

  // ==========================================================================
  // 1. Schema Validation Tests
  // ==========================================================================
  describe("Domain Schema Validation", () => {
    it("validates a compliant AgentTask and rejects empty goals", () => {
      const validTask: AgentTask = {
        taskId: "11111111-1111-4111-8111-111111111111",
        jobId: "22222222-2222-4222-8222-222222222222",
        role: "EXPLORER",
        goal: "Find Arduino Uno on Robu.in and extract price",
        site: "robu.in",
        inputPayload: { query: "Arduino Uno" },
        deadline: new Date().toISOString(),
        maxSteps: 15,
        budget: { maxSeconds: 90, maxUsd: 0.5 },
        correlationId: "corr-12345",
      };

      expect(() => AgentTaskSchema.parse(validTask)).not.toThrow();

      // Reject empty goal
      expect(() =>
        AgentTaskSchema.parse({ ...validTask, goal: "" })
      ).toThrowError(/Goal cannot be empty/i);
    });

    it("validates AgentResult with null stepsUsage and structured errors", () => {
      const result: AgentResult = {
        taskId: "11111111-1111-4111-8111-111111111111",
        jobId: "22222222-2222-4222-8222-222222222222",
        status: "SUCCESS",
        structuredOutput: { title: "Arduino Uno R3", price: 499, currency: "INR" },
        evidenceReferences: ["https://robu.in/product/arduino-uno-r3"],
        providerRunIds: { tinyFishRunId: "tf_run_98765" },
        stepsUsage: null, // explicit null allowed when provider doesn't report
        durationMs: 14200,
        errors: [],
        warnings: [],
      };

      expect(() => AgentResultSchema.parse(result)).not.toThrow();
    });

    it("validates StepBinding semantic role and SemVer version regex", () => {
      const binding: StepBinding = {
        semanticRole: "SEARCH_INPUT",
        locatorStrategy: "css",
        locatorValue: "input[type='search'], input[name='s']",
        anchorEvidence: { placeholder: "Search for products", role: "searchbox" },
        uniquenessExpectation: "SINGLE",
        domain: "robu.in",
        version: "1.0.0",
      };

      expect(() => StepBindingSchema.parse(binding)).not.toThrow();

      // Reject invalid semver
      expect(() =>
        StepBindingSchema.parse({ ...binding, version: "v1_invalid" })
      ).toThrowError(/SemVer/i);
    });

    it("validates ValidationResult status values including NEEDS_REVIEW and BLOCKED", () => {
      const valResult: ValidationResult = {
        validationId: "33333333-3333-4333-8333-333333333333",
        status: "NEEDS_REVIEW",
        failureCategory: "MISMATCH",
        checks: {
          schemaValid: true,
          productIdentityMatch: false,
          priceParsedINR: true,
          domainAuthorized: true,
          freshnessValid: true,
          stepPostconditions: [
            { stepName: "SELECT", passed: false, message: "Title score below threshold" },
          ],
        },
        validatedAt: new Date().toISOString(),
      };

      expect(() => ValidationResultSchema.parse(valResult)).not.toThrow();
    });

    it("validates BenchmarkRecord with null agentSteps and explicit costs", () => {
      const bench: BenchmarkRecord = {
        benchmarkId: "44444444-4444-4444-8444-444444444444",
        trialType: "WARM_PLAYWRIGHT_REPLAY",
        site: "robu.in",
        query: "Raspberry Pi Pico",
        agentInvocations: 0,
        agentSteps: null,
        latencyMs: 780,
        success: true,
        resultCorrectness: "CORRECT",
        costs: {
          agentCostUsd: 0.0,
          browserCostUsd: 0.0,
          totalCostUsd: 0.0,
        },
        unavailableMetrics: ["agent_token_count"],
        executedAt: new Date().toISOString(),
      };

      expect(() => BenchmarkRecordSchema.parse(bench)).not.toThrow();
    });
  });

  // ==========================================================================
  // 2. Versioning & Atomic Promotion Tests
  // ==========================================================================
  describe("Site Adapter Versioning & Atomic Promotion", () => {
    const domain = "robu.in";

    const createSampleAdapter = (version: string, status: "CANDIDATE" | "ACTIVE"): SiteAdapter => ({
      domain,
      adapterVersion: version,
      status,
      locatorBindings: {
        SEARCH_INPUT: {
          semanticRole: "SEARCH_INPUT",
          locatorStrategy: "css",
          locatorValue: `input.search-${version}`,
          anchorEvidence: { placeholder: "Search" },
          uniquenessExpectation: "SINGLE",
          domain,
          version,
        },
      },
      urlPatterns: { entryUrl: "https://robu.in" },
      evidence: { traceId: `trace-${version}` },
      source: "agent",
      validationQueries: ["query1", "query2"],
      validationResults: [{ query: "query1", passed: true }],
      createdAt: new Date().toISOString(),
    });

    it("saves and retrieves candidate site adapters", () => {
      const adapterV1 = createSampleAdapter("1.0.0", "CANDIDATE");
      repo.saveSiteAdapter(adapterV1);

      const retrieved = repo.getSiteAdapter(domain, "1.0.0");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.adapterVersion).toBe("1.0.0");
      expect(retrieved?.status).toBe("CANDIDATE");
    });

    it("atomically promotes a candidate version and retires the previous active version", () => {
      // 1. Create and promote v1.0.0
      const v1 = createSampleAdapter("1.0.0", "CANDIDATE");
      repo.saveSiteAdapter(v1);
      repo.promoteSiteAdapter(domain, "1.0.0");

      let active = repo.getActiveSiteAdapter(domain);
      expect(active?.adapterVersion).toBe("1.0.0");
      expect(active?.status).toBe("ACTIVE");

      // 2. Create candidate v1.1.0 (self-healed version)
      const v11 = createSampleAdapter("1.1.0", "CANDIDATE");
      repo.saveSiteAdapter(v11);

      // Verify v1.0.0 is still active before promotion
      expect(repo.getActiveSiteAdapter(domain)?.adapterVersion).toBe("1.0.0");

      // 3. Atomically promote v1.1.0
      repo.promoteSiteAdapter(domain, "1.1.0");

      // 4. Verify v1.1.0 is now ACTIVE
      active = repo.getActiveSiteAdapter(domain);
      expect(active?.adapterVersion).toBe("1.1.0");
      expect(active?.status).toBe("ACTIVE");
      expect(active?.promotedAt).toBeDefined();

      // 5. Verify v1.0.0 was atomically retired (Rollback Lookup)
      const historicalV1 = repo.getSiteAdapter(domain, "1.0.0");
      expect(historicalV1?.status).toBe("RETIRED");
    });

    it("fails promotion if candidate adapter does not exist", () => {
      expect(() => repo.promoteSiteAdapter("unknown.com", "9.9.9")).toThrowError(
        /Cannot promote non-existent adapter/i
      );
    });
  });

  // ==========================================================================
  // 3. Skill Versioning & Atomic Promotion
  // ==========================================================================
  describe("Skill Versioning & Promotion", () => {
    it("promotes skills atomically and retires older versions", () => {
      const skill1: Skill = {
        id: "55555555-5555-4555-8555-555555555555",
        name: "E-Commerce Product Lookup",
        taskType: "PRODUCT_LOOKUP",
        version: "1.0.0",
        status: "CANDIDATE",
        taskTemplate: [
          {
            order: 1,
            stepName: "OPEN",
            description: "Open home page",
            postcondition: "Search input visible",
          },
        ],
        outputSchema: { type: "object" },
        postconditions: [{ name: "price_numeric", rule: "price > 0", required: true }],
        sourceRunIds: ["run-1"],
        tests: [{ query: "Arduino Uno", expectedFields: ["title", "price"] }],
        limitations: ["Indian electronics sites only"],
        timestamps: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };

      repo.saveSkill(skill1);
      repo.promoteSkill(skill1.id);

      expect(repo.getActiveSkill("PRODUCT_LOOKUP")?.version).toBe("1.0.0");

      // Create skill v1.1.0
      const skill2: Skill = {
        ...skill1,
        id: "66666666-6666-4666-8666-666666666666",
        version: "1.1.0",
        status: "CANDIDATE",
      };

      repo.saveSkill(skill2);
      repo.promoteSkill(skill2.id);

      expect(repo.getActiveSkill("PRODUCT_LOOKUP")?.version).toBe("1.1.0");
      expect(repo.getSkill(skill1.id)?.status).toBe("RETIRED");
    });
  });

  // ==========================================================================
  // 4. Event Ordering & Concurrency Safety
  // ==========================================================================
  describe("Run Events & Concurrent Safety", () => {
    it("preserves strict sequence ordering for run events", () => {
      const jobId = randomUUID();
      const states = ["READY", "TEACHING", "COMPILING", "VALIDATING_CANDIDATE", "ACTIVE"];

      for (let i = 0; i < states.length; i++) {
        const event: RunEvent = {
          eventId: randomUUID(),
          jobId,
          runId: randomUUID(),
          agentRole: "ORCHESTRATOR",
          state: states[i],
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          site: "robu.in",
          stepId: `step-${i}`,
          payloadSummary: { index: i },
        };
        repo.logEvent(event);
      }

      const events = repo.getEventsByJob(jobId);
      expect(events).toHaveLength(5);
      expect(events.map((e) => e.state)).toEqual(states);
    });

    it("handles concurrent writes safely without table lock errors", async () => {
      const writePromises = Array.from({ length: 25 }, async (_, i) => {
        const bench: BenchmarkRecord = {
          benchmarkId: randomUUID(),
          trialType: "WARM_PLAYWRIGHT_REPLAY",
          site: "robu.in",
          query: `Query #${i}`,
          agentInvocations: 0,
          agentSteps: null,
          latencyMs: 500 + i * 10,
          success: true,
          resultCorrectness: "CORRECT",
          costs: { agentCostUsd: 0, browserCostUsd: 0, totalCostUsd: 0 },
          unavailableMetrics: [],
          executedAt: new Date().toISOString(),
        };
        repo.saveBenchmark(bench);
      });

      await expect(Promise.all(writePromises)).resolves.not.toThrow();

      const benchmarks = repo.listBenchmarks("robu.in");
      expect(benchmarks).toHaveLength(25);
    });
  });

  // ==========================================================================
  // 5. Safe Demo Storage Reset
  // ==========================================================================
  describe("Safe Demo Storage Reset", () => {
    it("clears database tables completely while leaving code intact", () => {
      const jobId = randomUUID();
      const event: RunEvent = {
        eventId: randomUUID(),
        jobId,
        runId: randomUUID(),
        agentRole: "ORCHESTRATOR",
        state: "TEACHING",
        timestamp: new Date().toISOString(),
        site: "robu.in",
        payloadSummary: {},
      };
      repo.logEvent(event);

      expect(repo.getEventsByJob(jobId)).toHaveLength(1);

      // Perform demo reset
      repo.resetDemoStorage();

      // Verify all tables purged
      expect(repo.getEventsByJob(jobId)).toHaveLength(0);
      expect(repo.listSiteAdapters("robu.in")).toHaveLength(0);
      expect(repo.listSkills()).toHaveLength(0);
      expect(repo.listBenchmarks()).toHaveLength(0);
    });
  });
});
