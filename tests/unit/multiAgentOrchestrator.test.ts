import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import { OrchestratorStateMachine } from "../../src/orchestrator/stateMachine.js";
import { JobBudgetTracker, JobBudgetExceededError } from "../../src/orchestrator/concurrencyBudget.js";
import {
  DagScheduler,
  DependencyDeadlockError,
} from "../../src/orchestrator/dagScheduler.js";
import { ShadowTwinOrchestrator } from "../../src/orchestrator/orchestrator.js";
import { ExplorerAgent } from "../../src/agents/explorer.js";
import { CompilerAgent } from "../../src/agents/compiler.js";
import { PlaywrightRunner } from "../../src/executor/playwrightRunner.js";
import { ValidatorWorker } from "../../src/validator/validatorWorker.js";
import { RecoveryAgent } from "../../src/agents/recovery.js";
import type { AgentTask, AgentResult, SiteAdapter, Skill } from "../../src/types/domain.js";

describe("Multi-Agent Deterministic Orchestration & DAG Scheduling", () => {
  let db: ReturnType<typeof DatabaseConstructor>;
  let repo: Repository;

  const createTask = (
    role: AgentTask["role"],
    site: string,
    goal: string,
    correlationId: string = randomUUID()
  ): AgentTask => ({
    taskId: randomUUID(),
    jobId: randomUUID(),
    role,
    goal,
    site,
    inputPayload: { goal },
    deadline: new Date(Date.now() + 60000).toISOString(),
    maxSteps: 10,
    retryCount: 0,
    retryLimit: 2,
    correlationId,
  });

  const createSuccessResult = (task: AgentTask, output: Record<string, unknown> = {}): AgentResult => ({
    taskId: task.taskId,
    jobId: task.jobId,
    status: "SUCCESS",
    structuredOutput: output,
    evidenceReferences: [`https://${task.site}`],
    providerRunIds: { tinyFishRunId: `tf-run-${task.taskId.slice(0, 8)}` },
    stepsUsage: { stepsCompleted: 3 },
    durationMs: 50,
    errors: [],
    warnings: [],
  });

  beforeEach(() => {
    db = new DatabaseConstructor(":memory:");
    initSchema(db);
    repo = new Repository(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Concurrency Cap (Default Concurrency = 2)
  // ==========================================================================
  it("enforces strict concurrency cap: at most 2 tasks execute concurrently", async () => {
    const scheduler = new DagScheduler({ concurrency: 2, repo });
    let activeCount = 0;
    let maxObservedActive = 0;

    // Create 4 independent tasks
    for (let i = 0; i < 4; i++) {
      const task = createTask("EXPLORER", `store-${i}.com`, `Explore store ${i}`);
      scheduler.addTask(task, [], async (t) => {
        activeCount++;
        maxObservedActive = Math.max(maxObservedActive, activeCount);
        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 30));
        activeCount--;
        return createSuccessResult(t);
      });
    }

    const results = await scheduler.run();

    expect(results.size).toBe(4);
    // Bounded concurrency guarantee
    expect(maxObservedActive).toBeLessThanOrEqual(2);
    expect(maxObservedActive).toBe(2);
  });

  // ==========================================================================
  // 2. Parallel Independent Explore Tasks (Store A & Store B)
  // ==========================================================================
  it("executes independent Store A and Store B explorations in parallel", async () => {
    const scheduler = new DagScheduler({ concurrency: 2, repo });
    const taskA = createTask("EXPLORER", "store-a.com", "Explore Store A");
    const taskB = createTask("EXPLORER", "store-b.com", "Explore Store B");

    let taskAStartedAt = 0;
    let taskBStartedAt = 0;

    scheduler.addTask(taskA, [], async (t) => {
      taskAStartedAt = Date.now();
      await new Promise((r) => setTimeout(r, 40));
      return createSuccessResult(t, { domain: "store-a.com" });
    });

    scheduler.addTask(taskB, [], async (t) => {
      taskBStartedAt = Date.now();
      await new Promise((r) => setTimeout(r, 40));
      return createSuccessResult(t, { domain: "store-b.com" });
    });

    const results = await scheduler.run();

    expect(results.get(taskA.taskId)?.status).toBe("SUCCESS");
    expect(results.get(taskB.taskId)?.status).toBe("SUCCESS");

    // Both tasks started roughly at the same time (parallel execution)
    const startDifference = Math.abs(taskAStartedAt - taskBStartedAt);
    expect(startDifference).toBeLessThan(25);
  });

  // ==========================================================================
  // 3. Compiler Dependency Barrier
  // ==========================================================================
  it("enforces compiler dependency barrier: Compiler waits for Explorer to complete first", async () => {
    const scheduler = new DagScheduler({ concurrency: 2, repo });
    const exploreTask = createTask("EXPLORER", "robu.in", "Explore robu.in");
    const compileTask = createTask("COMPILER", "robu.in", "Compile robu.in");

    let exploreFinished = false;
    let compilerRanAfterExplorer = false;

    // Explorer runs first
    scheduler.addTask(exploreTask, [], async (t) => {
      await new Promise((r) => setTimeout(r, 40));
      exploreFinished = true;
      return createSuccessResult(t, { traceId: "exp-1" });
    });

    // Compiler depends on Explorer
    scheduler.addTask(compileTask, [exploreTask.taskId], async (t, depResults) => {
      if (exploreFinished && depResults.has(exploreTask.taskId)) {
        compilerRanAfterExplorer = true;
      }
      return createSuccessResult(t, { skillCompiled: true });
    });

    const results = await scheduler.run();

    expect(results.get(exploreTask.taskId)?.status).toBe("SUCCESS");
    expect(results.get(compileTask.taskId)?.status).toBe("SUCCESS");
    expect(compilerRanAfterExplorer).toBe(true);
  });

  // ==========================================================================
  // 4. Failed Explorer (Dependency Barrier Fails Closed)
  // ==========================================================================
  it("fails closed when Explorer fails: Compiler never executes and does not invent facts", async () => {
    const scheduler = new DagScheduler({ concurrency: 2, repo });
    const exploreTask = createTask("EXPLORER", "broken-site.com", "Explore broken site");
    const compileTask = createTask("COMPILER", "broken-site.com", "Compile broken site");

    let compilerExecuted = false;

    scheduler.addTask(exploreTask, [], async (t) => {
      return {
        taskId: t.taskId,
        jobId: t.jobId,
        status: "FAILED",
        structuredOutput: null,
        evidenceReferences: [],
        providerRunIds: {},
        stepsUsage: null,
        durationMs: 10,
        errors: [{ code: "SITE_UNAVAILABLE", message: "DNS resolution failed" }],
        warnings: [],
      };
    });

    scheduler.addTask(compileTask, [exploreTask.taskId], async (t) => {
      compilerExecuted = true;
      return createSuccessResult(t);
    });

    const results = await scheduler.run();

    // Explorer failed
    expect(results.get(exploreTask.taskId)?.status).toBe("FAILED");
    // Compiler was skipped / never executed
    expect(compilerExecuted).toBe(false);
    expect(scheduler.getNode(compileTask.taskId)?.status).toBe("SKIPPED");
  });

  // ==========================================================================
  // 5. Job Timeout Budget Exceeded
  // ==========================================================================
  it("halts execution when job-level time budget expires", async () => {
    const budget = new JobBudgetTracker(randomUUID(), 10, 0.05); // 50ms budget
    const scheduler = new DagScheduler({ concurrency: 2, repo, budgetTracker: budget });

    const slowTask = createTask("EXPLORER", "slow-site.com", "Slow task");
    scheduler.addTask(slowTask, [], async (t) => {
      await new Promise((r) => setTimeout(r, 80)); // Exceeds 50ms timeout
      return createSuccessResult(t);
    });

    await expect(scheduler.run()).rejects.toThrow(JobBudgetExceededError);
  });

  // ==========================================================================
  // 6. Retry Limit & Bounded Retries
  // ==========================================================================
  it("retries failed task up to retryLimit and halts without infinite loop", async () => {
    const scheduler = new DagScheduler({ concurrency: 2, repo });
    const flakyTask = createTask("EXPLORER", "flaky-site.com", "Flaky task");
    let executionAttempts = 0;

    scheduler.addTask(
      flakyTask,
      [],
      async (t) => {
        executionAttempts++;
        return {
          taskId: t.taskId,
          jobId: t.jobId,
          status: "FAILED",
          structuredOutput: null,
          evidenceReferences: [],
          providerRunIds: {},
          stepsUsage: null,
          durationMs: 10,
          errors: [{ code: "NETWORK_ERROR", message: "Temporary socket error" }],
          warnings: [],
        };
      },
      2 // retryLimit = 2
    );

    const results = await scheduler.run();

    // Initial attempt (0) + 2 retries = 3 attempts total
    expect(executionAttempts).toBe(3);
    expect(results.get(flakyTask.taskId)?.status).toBe("FAILED");
  });

  // ==========================================================================
  // 7. Duplicate Messages / Idempotent Execution
  // ==========================================================================
  it("handles duplicate task messages idempotently without re-execution", async () => {
    const scheduler = new DagScheduler({ concurrency: 2, repo });
    const correlationId = "corr-12345";
    const task = createTask("EXPLORER", "robu.in", "Explore", correlationId);

    let handlerExecutionCount = 0;
    const handler = async (t: AgentTask) => {
      handlerExecutionCount++;
      return createSuccessResult(t, { executed: true });
    };

    scheduler.addTask(task, [], handler);
    const results1 = await scheduler.run();
    expect(results1.get(task.taskId)?.status).toBe("SUCCESS");
    expect(handlerExecutionCount).toBe(1);

    // Run identical task envelope again (simulating duplicate message queue delivery)
    const results2 = await scheduler.run();
    expect(results2.get(task.taskId)?.status).toBe("SUCCESS");
    // Handler must NOT have executed a second time
    expect(handlerExecutionCount).toBe(1);
  });

  // ==========================================================================
  // 8. Interrupted Job Recovery
  // ==========================================================================
  it("resumes interrupted job from persisted SQLite repository without re-running completed tasks", async () => {
    const jobId = randomUUID();
    const exploreTask = { ...createTask("EXPLORER", "robu.in", "Explore robu.in"), jobId };
    const compileTask = { ...createTask("COMPILER", "robu.in", "Compile robu.in"), jobId };

    // Simulate prior run where exploreTask already completed and was saved to SQLite
    const priorExploreResult = createSuccessResult(exploreTask, { traceId: "prior-trace-999" });
    repo.saveTask(exploreTask);
    repo.saveResult(priorExploreResult);

    const scheduler = new DagScheduler({ concurrency: 2, repo });
    let explorerReExecuted = false;
    let compilerExecuted = false;

    scheduler.addTask(exploreTask, [], async (t) => {
      explorerReExecuted = true;
      return createSuccessResult(t);
    });

    scheduler.addTask(compileTask, [exploreTask.taskId], async (t, depResults) => {
      compilerExecuted = true;
      const expRes = depResults.get(exploreTask.taskId);
      return createSuccessResult(t, { compiledFrom: expRes?.structuredOutput });
    });

    // Resume from repository
    scheduler.resumeFromRepository(jobId);

    const results = await scheduler.run();

    // Explorer was loaded as COMPLETED, so handler was NOT re-executed
    expect(explorerReExecuted).toBe(false);
    // Compiler ran successfully using the restored dependency result
    expect(compilerExecuted).toBe(true);
    expect(results.get(compileTask.taskId)?.status).toBe("SUCCESS");
    expect((results.get(compileTask.taskId)?.structuredOutput as any).compiledFrom.traceId).toBe(
      "prior-trace-999"
    );
  });

  // ==========================================================================
  // 9. State Machine Illegal Transitions & Audit Logging
  // ==========================================================================
  it("rejects illegal state transitions and persists valid transitions in SQLite", () => {
    const jobId = randomUUID();
    const sm = new OrchestratorStateMachine(jobId, "robu.in", repo, "READY");

    // Illegal: READY directly to ACTIVE
    expect(() => sm.transition("ACTIVE")).toThrow("Illegal state machine transition");

    // Illegal: COMPILING directly to DONE
    sm.transition("TEACHING");
    sm.transition("COMPILING");
    expect(() => sm.transition("DONE")).toThrow("Illegal state machine transition");

    // Allowed: COMPILING -> FAILED -> READY
    sm.transition("FAILED");
    expect(sm.getState()).toBe("FAILED");
    sm.transition("READY");
    expect(sm.getState()).toBe("READY");

    // Verify events logged in SQLite
    const events = repo.getEventsByJob(jobId);
    expect(events.length).toBe(4); // TEACHING, COMPILING, FAILED, READY
  });

  // ==========================================================================
  // 10. Atomic & Idempotent Version Promotion
  // ==========================================================================
  it("ensures atomic version promotion and prevents duplicate promotions on job retry", () => {
    const adapter1: SiteAdapter = {
      domain: "robu.in",
      adapterVersion: "1.0.0",
      status: "CANDIDATE",
      locatorBindings: {},
      urlPatterns: { entryUrl: "https://robu.in" },
      evidence: {},
      source: "agent",
      validationQueries: [],
      validationResults: [],
      createdAt: new Date().toISOString(),
    };

    repo.saveSiteAdapter(adapter1);

    // Initial promotion
    const promoted1 = repo.promoteSiteAdapter("robu.in", "1.0.0");
    expect(promoted1.status).toBe("ACTIVE");
    expect(repo.getActiveSiteAdapter("robu.in")?.adapterVersion).toBe("1.0.0");

    // Idempotent re-promotion (simulating job retry)
    const rePromoted = repo.promoteSiteAdapter("robu.in", "1.0.0");
    expect(rePromoted.status).toBe("ACTIVE");

    // Exactly one active version exists
    const active = repo.getActiveSiteAdapter("robu.in");
    expect(active?.adapterVersion).toBe("1.0.0");
    expect(active?.status).toBe("ACTIVE");
  });

  // ==========================================================================
  // 11. Dependency Deadlock Detection
  // ==========================================================================
  it("detects dependency cycles upfront and throws DependencyDeadlockError", () => {
    const scheduler = new DagScheduler({ concurrency: 2 });
    const taskA = createTask("EXPLORER", "robu.in", "Task A");
    const taskB = createTask("COMPILER", "robu.in", "Task B");

    // Circular dependency: Task A depends on Task B, Task B depends on Task A
    scheduler.addTask(taskA, [taskB.taskId], async (t) => createSuccessResult(t));
    scheduler.addTask(taskB, [taskA.taskId], async (t) => createSuccessResult(t));

    expect(() => scheduler.detectDeadlocks()).toThrow(DependencyDeadlockError);
    expect(() => scheduler.detectDeadlocks()).toThrow(/cycle discovered/);
  });

  it("detects non-existent dependency references and throws DependencyDeadlockError", () => {
    const scheduler = new DagScheduler({ concurrency: 2 });
    const taskA = createTask("EXPLORER", "robu.in", "Task A");
    const ghostId = randomUUID();

    scheduler.addTask(taskA, [ghostId], async (t) => createSuccessResult(t));

    expect(() => scheduler.detectDeadlocks()).toThrow(DependencyDeadlockError);
    expect(() => scheduler.detectDeadlocks()).toThrow(/non-existent prerequisite task/);
  });
});
