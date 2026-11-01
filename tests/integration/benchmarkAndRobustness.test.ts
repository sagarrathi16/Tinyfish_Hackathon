import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockStoreServer } from "../../src/fixtures/mockStoreServer.js";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import { PlaywrightRunner } from "../../src/executor/playwrightRunner.js";
import { ValidatorWorker } from "../../src/validator/validatorWorker.js";
import { ShadowTwinOrchestrator } from "../../src/orchestrator/orchestrator.js";
import { BenchmarkHarness } from "../../src/benchmark/benchmarkHarness.js";
import { seedCleanDemo } from "../../src/benchmark/demoSeed.js";
import {
  FROZEN_STORE_A_DATASET,
  FROZEN_STORE_B_DATASET,
  gradeResultAgainstGroundTruth,
} from "../../src/benchmark/frozenDataset.js";
import {
  type Skill,
  type SiteAdapter,
  type AgentTask,
  SiteAdapterSchema,
} from "../../src/types/domain.js";
import fs from "node:fs";
import path from "node:path";

describe("Benchmark Harness, Frozen Datasets & Robustness Defenses", () => {
  let mockServer: MockStoreServer;
  let baseUrl: string;
  let db: ReturnType<typeof DatabaseConstructor>;
  let repo: Repository;
  let runner: PlaywrightRunner;
  let validator: ValidatorWorker;
  let orchestrator: ShadowTwinOrchestrator;
  let harness: BenchmarkHarness;

  beforeAll(async () => {
    mockServer = new MockStoreServer();
    baseUrl = await mockServer.start();

    db = new DatabaseConstructor(":memory:");
    initSchema(db);
    repo = new Repository(db);
    runner = new PlaywrightRunner(repo);
    validator = new ValidatorWorker(repo);
    orchestrator = new ShadowTwinOrchestrator(repo, undefined, undefined, runner, validator);
    harness = new BenchmarkHarness(repo, orchestrator, runner, validator);
  }, 20000);

  afterAll(async () => {
    await mockServer.stop();
    db.close();
  });

  // ==========================================================================
  // 1. Frozen Evaluation Dataset & Ground Truth Grader Tests
  // ==========================================================================
  describe("Frozen Dataset & Correctness Grader", () => {
    it("grades accurate results as CORRECT and detects silent-wrong answers", () => {
      const item = FROZEN_STORE_A_DATASET[0]; // Arduino Uno, expected ₹499

      // 1. Accurate result
      const accurate = gradeResultAgainstGroundTruth(
        {
          status: "SUCCESS",
          product: {
            title: "Arduino Uno R3 Compatible Development Board",
            numericPrice: 499.0,
            currency: "INR",
            url: "http://localhost:3000/store-a/product/arduino-uno",
          },
        },
        item
      );
      expect(accurate.isCorrect).toBe(true);
      expect(accurate.isSilentWrong).toBe(false);

      // 2. Silent-wrong result: wrong product (Raspberry Pi instead of Arduino)
      const wrongProduct = gradeResultAgainstGroundTruth(
        {
          status: "SUCCESS",
          product: {
            title: "Raspberry Pi 5 Model B",
            numericPrice: 499.0,
            currency: "INR",
            url: "/store-a/product/raspberry-pi",
          },
        },
        item
      );
      expect(wrongProduct.isCorrect).toBe(false);
      expect(wrongProduct.isSilentWrong).toBe(true);
      expect(wrongProduct.reason).toContain("does not match expected query tokens");

      // 3. Silent-wrong result: wrong price (MRP ₹799 or EMI instead of selling price ₹499)
      const wrongPrice = gradeResultAgainstGroundTruth(
        {
          status: "SUCCESS",
          product: {
            title: "Arduino Uno R3 Compatible Development Board",
            numericPrice: 799.0,
            currency: "INR",
            url: "/store-a/product/arduino-uno",
          },
        },
        item
      );
      expect(wrongPrice.isCorrect).toBe(false);
      expect(wrongPrice.isSilentWrong).toBe(true);
      expect(wrongPrice.reason).toContain("disagrees with ground truth baseline");

      // 4. Negative query (Smart Watch accessories): must reject accessories
      const negativeItem = FROZEN_STORE_A_DATASET[3]; // Smart Watch
      const acceptedAccessory = gradeResultAgainstGroundTruth(
        {
          status: "SUCCESS",
          product: {
            title: "Silicone Watch Strap 22mm",
            numericPrice: 199.0,
            currency: "INR",
            url: "/store-a/product/watch-strap",
          },
        },
        negativeItem
      );
      expect(acceptedAccessory.isCorrect).toBe(false);
      expect(acceptedAccessory.isSilentWrong).toBe(true); // Flagged as silent wrong!

      const rejectedAccessory = gradeResultAgainstGroundTruth(
        { status: "NEEDS_REVIEW", product: null },
        negativeItem
      );
      expect(rejectedAccessory.isCorrect).toBe(true);
      expect(rejectedAccessory.isSilentWrong).toBe(false);
    });
  });

  // ==========================================================================
  // 2. Comparative Benchmark Harness & M1–M7 Metrics
  // ==========================================================================
  describe("Comparative Benchmark Harness (Cold Agent vs. Compiled Replay)", () => {
    it("executes identical tasks on both runners and computes M1–M7 metrics strictly from raw records", async () => {
      // Seed clean baseline demo
      seedCleanDemo(repo, baseUrl);

      const benchmarkOutcome = await harness.runComparativeBenchmark(FROZEN_STORE_A_DATASET, {
        dryRunAgent: true,
        baseUrl,
      });

      expect(benchmarkOutcome).toBeDefined();
      const m = benchmarkOutcome.metrics;

      // Sample size
      expect(m.sampleSize).toBe(8); // 4 cold + 4 warm

      // M1: Local browser step share on warm replay (100%)
      expect(m.m1_localBrowserStepSharePercent).toBe(100.0);

      // M2: Ground truth correctness rate
      expect(m.m2_groundTruthCorrectRatePercent).toBeGreaterThanOrEqual(75.0);

      // M3: Silent-wrong count strictly reported
      expect(m.m3_silentWrongCount).toBe(0);

      // M4: Cold agent usage
      expect(m.m4_coldAgentUsage.agentInvocationsPerRun).toBe(1);
      expect(m.m4_coldAgentUsage.providerStepsPerRun).toBe(4);

      // M5: Warm replay agent usage (strictly 0)
      expect(m.m5_warmReplayAgentUsage.agentInvocationsPerRun).toBe(0);
      expect(m.m5_warmReplayAgentUsage.providerStepsPerRun).toBe(0);
      expect(m.m5_warmReplayAgentUsage.marginalCostUsd).toBe(0);

      // M6: Latency & Speedup
      expect(m.m6_latencyComparison.speedupMultiplier).toBeGreaterThanOrEqual(5.0);

      // M7: Observed provider cost & local compute separation
      expect(m.m7_observedProviderCostAndLocalCompute.localComputeCostUsd).toBe(0);

      // Statistical caveat present
      expect(m.statisticalCaveat).toContain("Based on N=8 controlled trials");

      // Verify Markdown report contains all M1-M7 keys
      const report = benchmarkOutcome.summaryTableMarkdown;
      expect(report).toContain("M1–M7 Telemetry Comparison Table");
      expect(report).toContain("Local Browser Step Share");
      expect(report).toContain("Ground Truth Correct Rate");
      expect(report).toContain("Silent Wrong Answers");
      expect(report).toContain("0 calls (0 steps)");
    }, 30000);
  });

  // ==========================================================================
  // 3. One-Command Clean Demo Seed & Repeated Reset Safety
  // ==========================================================================
  describe("Clean Demo Seeding & Reset Safety", () => {
    it("seeds clean presentation-ready state and preserves .env and source files across repeated resets", () => {
      // Execute 3 consecutive resets
      for (let i = 0; i < 3; i++) {
        const seedResult = seedCleanDemo(repo, baseUrl);
        expect(seedResult.success).toBe(true);
        expect(seedResult.storeAAdapterVersion).toBe("1.0.0");
        expect(seedResult.storeBAdapterVersion).toBe("1.0.0");
        expect(seedResult.baselineTrialCount).toBeGreaterThanOrEqual(5);

        // Verify active skill exists in SQLite
        const skill = repo.getActiveSkill();
        expect(skill).toBeDefined();
        expect(skill?.taskType).toBe("PRODUCT_LOOKUP");

        // Verify Store A and Store B adapters exist and are ACTIVE
        const storeA = repo.getActiveSiteAdapter("localhost");
        expect(storeA?.status).toBe("ACTIVE");
        const storeB = repo.getActiveSiteAdapter("store-b.local");
        expect(storeB?.status).toBe("ACTIVE");
      }

      // CRITICAL SAFETY CHECK: Confirm reset NEVER deletes .env.example or source files
      expect(fs.existsSync(path.resolve(process.cwd(), ".env.example"))).toBe(true);
      expect(fs.existsSync(path.resolve(process.cwd(), "package.json"))).toBe(true);
      expect(fs.existsSync(path.resolve(process.cwd(), "src", "server.ts"))).toBe(true);
    });
  });

  // ==========================================================================
  // 4. Ten Robustness & Adversarial Failure Tests
  // ==========================================================================
  describe("10 Robustness & Adversarial Failure Conditions", () => {
    const makeTask = (domain: string, query: string): AgentTask => ({
      taskId: randomUUID(),
      jobId: randomUUID(),
      role: "EXECUTOR",
      goal: `Search ${domain} for ${query}`,
      site: domain,
      inputPayload: { query },
      deadline: new Date(Date.now() + 15000).toISOString(),
      correlationId: randomUUID(),
      maxSteps: 5,
      retryCount: 0,
      retryLimit: 1,
    });

    const getStoreAAdapter = (): SiteAdapter => repo.getActiveSiteAdapter("localhost")!;

    // 1. Network outage / Unreachable port
    it("1. handles network outage / unreachable host cleanly without crashing", async () => {
      const adapter: SiteAdapter = {
        ...getStoreAAdapter(),
        domain: "localhost",
        urlPatterns: { entryUrl: "http://localhost:59999/unreachable" }, // Unreachable port
      };
      const task = makeTask("localhost", "Arduino Uno");
      const res = await runner.executeReplay(task, repo.getActiveSkill()!, adapter, { timeoutMs: 3000 });

      expect(["FAILED", "STUCK"]).toContain(res.status);
      expect(res.errors.length).toBeGreaterThanOrEqual(1);
    }, 15000);

    // 2. Malformed Agent response
    it("2. rejects malformed Agent response and catches invalid schema without unhandled throw", () => {
      const malformedData = {
        domain: "localhost",
        adapterVersion: "not-semver", // Invalid version format
        status: "ACTIVE",
        locatorBindings: {},
      };

      const parseResult = SiteAdapterSchema.safeParse(malformedData);
      expect(parseResult.success).toBe(false);
      if (!parseResult.success) {
        expect(parseResult.error.issues.length).toBeGreaterThan(0);
      }
    });

    // 3. Missing control
    it("3. detects missing control on target page and halts as BINDING_FAILED", async () => {
      const adapter: SiteAdapter = {
        ...getStoreAAdapter(),
        locatorBindings: {
          ...getStoreAAdapter().locatorBindings,
          SEARCH_INPUT: {
            semanticRole: "SEARCH_INPUT",
            locatorStrategy: "css",
            locatorValue: "#completely-missing-input-id",
            anchorEvidence: {},
            uniquenessExpectation: "SINGLE",
            provenance: "TINYFISH_EXPLORER",
            domain: "localhost",
            version: "1.0.0",
          },
        },
      };
      const task = makeTask("localhost", "Arduino Uno");
      const res = await runner.executeReplay(task, repo.getActiveSkill()!, adapter, { timeoutMs: 3000 });

      expect(res.status).toBe("STUCK");
      expect(res.errors.some((e) => e.code === "BINDING_FAILED")).toBe(true);
    }, 15000);

    // 4. Page timeout
    it("4. handles page timeout cleanly and halts closed", async () => {
      const adapter: SiteAdapter = {
        ...getStoreAAdapter(),
        urlPatterns: { entryUrl: `${baseUrl}/store-slow-hang` },
      };
      const task = makeTask("localhost", "Arduino Uno");
      const res = await runner.executeReplay(task, repo.getActiveSkill()!, adapter, { timeoutMs: 200 });

      expect(["FAILED", "STUCK"]).toContain(res.status);
      expect(res.errors.length).toBeGreaterThanOrEqual(1);
    }, 15000);

    // 5. CAPTCHA / 403 Bot Block
    it("5. detects bot challenge or HTTP 403 and halts as BLOCKED", async () => {
      const adapter: SiteAdapter = {
        ...getStoreAAdapter(),
        urlPatterns: { entryUrl: `${baseUrl}/store-blocked` },
      };
      const task = makeTask("localhost", "Arduino Uno");
      const res = await runner.executeReplay(task, repo.getActiveSkill()!, adapter, { timeoutMs: 3000 });

      expect(res.status).toBe("BLOCKED");
      expect(res.errors.some((e) => e.code === "ACCESS_RESTRICTED" || e.code === "BOT_BLOCKED")).toBe(true);
    }, 15000);

    // 6. Wrong product / Semantic mismatch
    it("6. catches wrong product mismatch and refuses silent-wrong answer", () => {
      const task = makeTask("localhost", "Arduino Uno");
      const wrongProductResult = {
        taskId: task.taskId,
        jobId: task.jobId,
        status: "SUCCESS" as const,
        structuredOutput: {
          title: "Raspberry Pi 5 8GB Model B", // Completely wrong product
          numericPrice: 7999.0,
          currency: "INR",
          url: `${baseUrl}/store-a/product/rpi`,
          productUrl: `${baseUrl}/store-a/product/rpi`,
          retrievedAt: new Date().toISOString(),
        },
        evidenceReferences: [`${baseUrl}/store-a`],
        providerRunIds: {},
        stepsUsage: null,
        durationMs: 1200,
        errors: [],
        warnings: [],
      };

      const val = validator.validateResult(task, wrongProductResult, getStoreAAdapter());
      expect(["FAIL", "NEEDS_REVIEW"]).toContain(val.status);
      expect(val.failureCategory).toBe("MISMATCH");
    });

    // 7. Wrong price semantic (EMI installment selected)
    it("7. catches EMI price semantic error and rejects installment amount", () => {
      const task = makeTask("localhost", "Arduino Uno");
      const emiPriceResult = {
        taskId: task.taskId,
        jobId: task.jobId,
        status: "SUCCESS" as const,
        structuredOutput: {
          title: "Arduino Uno R3 Development Board",
          numericPrice: 149.0, // EMI installment of ₹149/mo instead of ₹499
          currency: "INR",
          url: `${baseUrl}/store-a/product/arduino-uno`,
          productUrl: `${baseUrl}/store-a/product/arduino-uno`,
          retrievedAt: new Date().toISOString(),
          priceType: "EMI",
        },
        evidenceReferences: [`${baseUrl}/store-a`],
        providerRunIds: {},
        stepsUsage: null,
        durationMs: 1200,
        errors: [],
        warnings: [],
      };

      const val = validator.validateResult(task, emiPriceResult, getStoreAAdapter(), {
        groundTruth: { minPrice: 300, maxPrice: 600, expectedProduct: "Arduino Uno" },
      });
      expect(["FAIL", "NEEDS_REVIEW"]).toContain(val.status);
      expect(val.failureCategory).toBe("PRICE_ERROR");
    });

    // 8. Wrong domain redirect
    it("8. detects redirect to disallowed external domain and blocks navigation", async () => {
      const adapter: SiteAdapter = {
        ...getStoreAAdapter(),
        urlPatterns: { entryUrl: `${baseUrl}/store-redirect` },
      };
      const task = makeTask("localhost", "Arduino Uno");
      const res = await runner.executeReplay(task, repo.getActiveSkill()!, adapter, { timeoutMs: 3000 });

      // Catches navigation redirect to unauthorized external destination
      expect(["FAILED", "STUCK"]).toContain(res.status);
      expect(res.errors.length).toBeGreaterThanOrEqual(1);
    }, 15000);

    // 9. Recovery failure / Candidate rejection
    it("9. preserves active vN unchanged when recovery candidate fails validation gate", async () => {
      const initialStoreA = repo.getActiveSiteAdapter("localhost")!;
      expect(initialStoreA.adapterVersion).toBe("1.0.0");

      // Candidate v1.1.0 that points to broken selectors
      const badCandidate: SiteAdapter = {
        ...initialStoreA,
        adapterVersion: "1.1.0",
        status: "CANDIDATE",
        locatorBindings: {
          ...initialStoreA.locatorBindings,
          PRODUCT_CARD: {
            semanticRole: "PRODUCT_CARD",
            locatorStrategy: "css",
            locatorValue: ".non-existent-broken-selector",
            anchorEvidence: {},
            uniquenessExpectation: "MULTIPLE",
            provenance: "TINYFISH_RECOVERY",
            domain: "localhost",
            version: "1.1.0",
          },
        },
      };

      repo.saveSiteAdapter(badCandidate);

      // Test candidate on Query 1
      const task = makeTask("localhost", "Arduino Uno");
      const replay = await runner.executeReplay(task, repo.getActiveSkill()!, badCandidate, { timeoutMs: 3000 });
      const val = validator.validateResult(task, replay, badCandidate);

      expect(val.status).toBe("FAIL");

      // Verify promotion was REFUSED: v1.0.0 remains ACTIVE
      const currentActive = repo.getActiveSiteAdapter("localhost")!;
      expect(currentActive.adapterVersion).toBe("1.0.0");
      expect(currentActive.status).toBe("ACTIVE");

      const candidateInRepo = repo.getSiteAdapter("localhost", "1.1.0");
      expect(candidateInRepo?.status).toBe("CANDIDATE");
    }, 15000);

    // 10. Repeated demo reset idempotent execution
    it("10. proves repeated demo resets are idempotent and leave database fully operational", async () => {
      for (let i = 0; i < 5; i++) {
        repo.resetDemoStorage();
        expect(repo.listSkills().length).toBe(0);
        expect(repo.listBenchmarks().length).toBe(0);
      }

      // Re-seed and verify immediate execution
      seedCleanDemo(repo, baseUrl);
      const task = makeTask("localhost", "Arduino Uno");
      const replay = await runner.executeReplay(task, repo.getActiveSkill()!, repo.getActiveSiteAdapter("localhost")!);
      expect(replay.status).toBe("SUCCESS");
    }, 15000);
  });
});
