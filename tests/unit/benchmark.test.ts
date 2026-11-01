import { describe, it, expect, beforeEach, afterEach } from "vitest";
import DatabaseConstructor from "better-sqlite3";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import { BenchmarkWorker } from "../../src/benchmark/benchmarkWorker.js";

describe("Benchmark Worker & Telemetry Metrics", () => {
  let db: ReturnType<typeof DatabaseConstructor>;
  let repo: Repository;
  let benchmarkWorker: BenchmarkWorker;

  beforeEach(() => {
    db = new DatabaseConstructor(":memory:");
    initSchema(db);
    repo = new Repository(db);
    benchmarkWorker = new BenchmarkWorker(repo);
  });

  afterEach(() => {
    db.close();
  });

  it("records trials and persists them into SQLite database", () => {
    const record = benchmarkWorker.recordTrial({
      trialType: "COLD_AGENT",
      site: "robu.in",
      query: "Arduino Uno",
      agentInvocations: 1,
      agentSteps: 4,
      latencyMs: 16500,
      success: true,
      resultCorrectness: "CORRECT",
      costs: {
        agentCostUsd: 0.015,
        browserCostUsd: 0,
        totalCostUsd: 0.015,
      },
      unavailableMetrics: [],
    });

    expect(record.benchmarkId).toBeDefined();
    expect(record.latencyMs).toBe(16500);

    const stored = repo.listBenchmarks("robu.in");
    expect(stored.length).toBe(1);
    expect(stored[0].benchmarkId).toBe(record.benchmarkId);
  });

  it("computes aggregated summary metrics, speedup factor, and cost reduction", () => {
    // Record 2 Cold Agent runs (~16s latency, $0.015 cost)
    benchmarkWorker.recordTrial({
      trialType: "COLD_AGENT",
      site: "robu.in",
      query: "Arduino Uno",
      agentInvocations: 1,
      agentSteps: 4,
      latencyMs: 16000,
      success: true,
      resultCorrectness: "CORRECT",
      costs: { agentCostUsd: 0.015, browserCostUsd: 0, totalCostUsd: 0.015 },
      unavailableMetrics: [],
    });
    benchmarkWorker.recordTrial({
      trialType: "COLD_AGENT",
      site: "robu.in",
      query: "ESP32",
      agentInvocations: 1,
      agentSteps: 5,
      latencyMs: 18000,
      success: true,
      resultCorrectness: "CORRECT",
      costs: { agentCostUsd: 0.015, browserCostUsd: 0, totalCostUsd: 0.015 },
      unavailableMetrics: [],
    });

    // Record 2 Warm Playwright Replay runs (~1.2s latency, $0.000 cost, 0 agent calls)
    benchmarkWorker.recordTrial({
      trialType: "WARM_PLAYWRIGHT_REPLAY",
      site: "robu.in",
      query: "Arduino Uno",
      agentInvocations: 0,
      agentSteps: null,
      latencyMs: 1200,
      success: true,
      resultCorrectness: "CORRECT",
      costs: { agentCostUsd: 0, browserCostUsd: 0, totalCostUsd: 0 },
      unavailableMetrics: [],
    });
    benchmarkWorker.recordTrial({
      trialType: "WARM_PLAYWRIGHT_REPLAY",
      site: "robu.in",
      query: "Raspberry Pi",
      agentInvocations: 0,
      agentSteps: null,
      latencyMs: 1400,
      success: true,
      resultCorrectness: "CORRECT",
      costs: { agentCostUsd: 0, browserCostUsd: 0, totalCostUsd: 0 },
      unavailableMetrics: [],
    });

    const summary = benchmarkWorker.computeSummary();

    expect(summary.totalTrials).toBe(4);
    expect(summary.byTrialType.COLD_AGENT.avgLatencyMs).toBe(17000);
    expect(summary.byTrialType.WARM_PLAYWRIGHT_REPLAY.avgLatencyMs).toBe(1300);

    // Speedup: 17000 / 1300 = ~13.1x
    expect(summary.speedupFactor).toBeGreaterThanOrEqual(12);

    // Cost savings: 100% saved
    expect(summary.costSavingsPercent).toBe(100);

    // Zero silent wrong results
    expect(summary.zeroSilentWrong).toBe(true);
  });

  it("generates markdown report matching M1-M7 table structure", () => {
    benchmarkWorker.recordTrial({
      trialType: "WARM_PLAYWRIGHT_REPLAY",
      site: "robu.in",
      query: "Arduino Uno",
      agentInvocations: 0,
      agentSteps: null,
      latencyMs: 1250,
      success: true,
      resultCorrectness: "CORRECT",
      costs: { agentCostUsd: 0, browserCostUsd: 0, totalCostUsd: 0 },
      unavailableMetrics: [],
    });

    const md = benchmarkWorker.generateMarkdownReport();
    expect(md).toContain("# ShadowTwin Measured Benchmark & Reliability Report");
    expect(md).toContain("M1–M7 Telemetry Comparison Table");
    expect(md).toContain("Zero Agent calls");
  });
});

