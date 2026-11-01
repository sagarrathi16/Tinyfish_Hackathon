import { randomUUID } from "node:crypto";
import { ConcurrencyLimiter, JobBudgetTracker, JobBudgetExceededError } from "./concurrencyBudget.js";
import type { Repository } from "../persistence/repository.js";
import {
  type AgentTask,
  type AgentResult,
  AgentTaskSchema,
  AgentResultSchema,
} from "../types/domain.js";
import { logger } from "../utils/logger.js";

export class DependencyDeadlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyDeadlockError";
  }
}

export type TaskHandler = (
  task: AgentTask,
  dependencyResults: Map<string, AgentResult>
) => Promise<AgentResult>;

export interface DAGTaskNode {
  task: AgentTask;
  dependencies: string[]; // List of taskIds that must be COMPLETED before execution
  handler: TaskHandler;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED" | "SKIPPED";
  result?: AgentResult;
  retryCount: number;
  retryLimit: number;
}

export class DagScheduler {
  private nodes: Map<string, DAGTaskNode> = new Map();
  private processedMessages: Map<string, AgentResult> = new Map();
  private repo?: Repository;
  private limiter: ConcurrencyLimiter;
  private budgetTracker?: JobBudgetTracker;

  constructor(options?: {
    concurrency?: number;
    repo?: Repository;
    budgetTracker?: JobBudgetTracker;
  }) {
    this.limiter = new ConcurrencyLimiter(options?.concurrency ?? 2);
    this.repo = options?.repo;
    this.budgetTracker = options?.budgetTracker;
  }

  /**
   * Registers a task node in the DAG with its dependencies and execution handler.
   */
  addTask(
    task: AgentTask,
    dependencies: string[] = [],
    handler: TaskHandler,
    retryLimit: number = 2
  ): void {
    const validated = AgentTaskSchema.parse(task);

    this.nodes.set(validated.taskId, {
      task: validated,
      dependencies,
      handler,
      status: "PENDING",
      retryCount: validated.retryCount || 0,
      retryLimit: validated.retryLimit ?? retryLimit,
    });
  }

  /**
   * Detects cycles and non-existent dependencies in the DAG before running.
   * Throws DependencyDeadlockError if a cycle or deadlocked structure is found.
   */
  detectDeadlocks(): void {
    // 1. Verify all dependencies exist in the graph
    for (const [taskId, node] of this.nodes.entries()) {
      for (const depId of node.dependencies) {
        if (!this.nodes.has(depId)) {
          throw new DependencyDeadlockError(
            `Task '${taskId}' depends on non-existent prerequisite task '${depId}'`
          );
        }
      }
    }

    // 2. Cycle detection via standard DFS with 3-color visiting state
    // 0: unvisited, 1: visiting (in current path), 2: visited (finished)
    const state = new Map<string, number>();

    const checkCycle = (currId: string, path: string[]): void => {
      state.set(currId, 1); // visiting
      path.push(currId);

      const node = this.nodes.get(currId);
      if (node) {
        for (const depId of node.dependencies) {
          const depState = state.get(depId) ?? 0;
          if (depState === 1) {
            // Cycle detected!
            const cyclePath = [...path, depId].join(" -> ");
            throw new DependencyDeadlockError(
              `Dependency deadlock detected: cycle discovered involving tasks [${cyclePath}]`
            );
          }
          if (depState === 0) {
            checkCycle(depId, path);
          }
        }
      }

      path.pop();
      state.set(currId, 2); // visited
    };

    for (const taskId of this.nodes.keys()) {
      if ((state.get(taskId) ?? 0) === 0) {
        checkCycle(taskId, []);
      }
    }
  }

  /**
   * Executes the DAG with bounded concurrency, respecting dependency barriers and retries.
   */
  async run(): Promise<Map<string, AgentResult>> {
    // Verify no deadlocks before commencing
    this.detectDeadlocks();

    const results = new Map<string, AgentResult>();
    for (const node of this.nodes.values()) {
      if (node.status === "COMPLETED" && node.result) {
        results.set(node.task.taskId, node.result);
      }
    }
    const inFlightPromises = new Map<string, Promise<void>>();

    // Helper to evaluate if node can be launched
    const canLaunch = (node: DAGTaskNode): boolean => {
      if (node.status !== "PENDING") return false;
      // All dependencies must be COMPLETED
      return node.dependencies.every((depId) => {
        const depNode = this.nodes.get(depId);
        return depNode && depNode.status === "COMPLETED";
      });
    };

    // Helper to check if any dependency has permanently failed
    const hasFailedDependency = (node: DAGTaskNode): boolean => {
      return node.dependencies.some((depId) => {
        const depNode = this.nodes.get(depId);
        return depNode && (depNode.status === "FAILED" || depNode.status === "BLOCKED" || depNode.status === "SKIPPED");
      });
    };

    while (true) {
      // Check time budget if active
      if (this.budgetTracker) {
        this.budgetTracker.checkTimeout();
      }

      // Check for nodes whose dependencies failed -> mark SKIPPED
      for (const [taskId, node] of this.nodes.entries()) {
        if (node.status === "PENDING" && hasFailedDependency(node)) {
          logger.warn(`Dependency failed for task '${taskId}'; marking SKIPPED`, {
            taskId,
            role: node.task.role,
          });
          node.status = "SKIPPED";
        }
      }

      // Find all ready nodes
      const readyNodes: DAGTaskNode[] = [];
      for (const node of this.nodes.values()) {
        if (canLaunch(node)) {
          readyNodes.push(node);
        }
      }

      // Launch all ready nodes (concurrency is bounded by ConcurrencyLimiter inside executeNode)
      for (const node of readyNodes) {
        node.status = "RUNNING";
        const taskPromise = this.executeNodeWithRetry(node, results).finally(() => {
          inFlightPromises.delete(node.task.taskId);
        });
        inFlightPromises.set(node.task.taskId, taskPromise);
      }

      if (inFlightPromises.size === 0) {
        // Nothing running and nothing ready
        break;
      }

      // Wait for at least one in-flight task to finish before next scheduling tick
      await Promise.race(Array.from(inFlightPromises.values()));
    }

    return results;
  }

  /**
   * Executes an individual node with idempotent message deduplication and bounded retries.
   */
  private async executeNodeWithRetry(
    node: DAGTaskNode,
    results: Map<string, AgentResult>
  ): Promise<void> {
    const task = node.task;
    const dedupeKey = `${task.correlationId}:${task.taskId}:${node.retryCount}`;

    // Idempotent duplicate message check
    if (this.processedMessages.has(dedupeKey)) {
      logger.info(`Idempotent task execution: reusing result for '${task.taskId}'`, {
        taskId: task.taskId,
        correlationId: task.correlationId,
      });
      const cachedResult = this.processedMessages.get(dedupeKey)!;
      node.result = cachedResult;
      node.status = cachedResult.status === "SUCCESS" ? "COMPLETED" : "FAILED";
      results.set(task.taskId, cachedResult);
      return;
    }

    // Acquire permit from bounded concurrency limiter
    const releasePermit = await this.limiter.acquire();

    try {
      if (this.budgetTracker) {
        this.budgetTracker.checkTimeout();
      }

      // Prepare dependency results
      const depResults = new Map<string, AgentResult>();
      for (const depId of node.dependencies) {
        const depRes = results.get(depId);
        if (depRes) {
          depResults.set(depId, depRes);
        }
      }

      // Execute task handler
      const result = await node.handler(task, depResults);
      const validatedResult = AgentResultSchema.parse(result);

      if (validatedResult.status === "SUCCESS") {
        node.status = "COMPLETED";
        node.result = validatedResult;
        results.set(task.taskId, validatedResult);
        this.processedMessages.set(dedupeKey, validatedResult);

        // Persist to repository if available
        if (this.repo) {
          this.repo.saveRun(task, validatedResult);
        }
      } else {
        // Check if retry is allowed
        if (node.retryCount < node.retryLimit) {
          node.retryCount++;
          node.status = "PENDING"; // Retry on next loop tick
          logger.warn(`Task '${task.taskId}' failed; scheduling retry ${node.retryCount}/${node.retryLimit}`, {
            taskId: task.taskId,
            retryCount: node.retryCount,
          });
        } else {
          node.status = validatedResult.status === "BLOCKED" ? "BLOCKED" : "FAILED";
          node.result = validatedResult;
          results.set(task.taskId, validatedResult);
          this.processedMessages.set(dedupeKey, validatedResult);

          if (this.repo) {
            this.repo.saveRun(task, validatedResult);
          }
        }
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Exception during task '${task.taskId}' execution`, {
        taskId: task.taskId,
        error: errorMsg,
      });

      if (node.retryCount < node.retryLimit) {
        node.retryCount++;
        node.status = "PENDING";
      } else {
        node.status = "FAILED";
        const failureResult: AgentResult = {
          taskId: task.taskId,
          jobId: task.jobId,
          status: "FAILED",
          structuredOutput: null,
          evidenceReferences: [],
          providerRunIds: {},
          stepsUsage: null,
          durationMs: 0,
          errors: [{ code: "TASK_EXCEPTION", message: errorMsg }],
          warnings: [],
        };
        node.result = failureResult;
        results.set(task.taskId, failureResult);
        this.processedMessages.set(dedupeKey, failureResult);

        if (this.repo) {
          this.repo.saveRun(task, failureResult);
        }
      }
    } finally {
      releasePermit();
    }
  }

  /**
   * Resumes an interrupted job from persisted database runs.
   * Completed tasks are loaded as COMPLETED, allowing remaining pending tasks to proceed.
   */
  resumeFromRepository(jobId: string): void {
    if (!this.repo) return;

    const runs = this.repo.getRunsByJob(jobId);
    for (const run of runs) {
      if (this.nodes.has(run.taskId) && run.status === "SUCCESS" && run.result) {
        const node = this.nodes.get(run.taskId)!;
        node.status = "COMPLETED";
        node.result = run.result;
        this.processedMessages.set(
          `${node.task.correlationId}:${node.task.taskId}:${node.retryCount}`,
          run.result
        );
        logger.info(`Resumed completed task '${run.taskId}' from persisted repository run`, {
          jobId,
          taskId: run.taskId,
        });
      }
    }
  }

  getNode(taskId: string): DAGTaskNode | undefined {
    return this.nodes.get(taskId);
  }
}
