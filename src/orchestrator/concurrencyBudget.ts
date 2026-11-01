import { getEnv } from "../config/env.js";
import { logger } from "../utils/logger.js";

export class JobBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobBudgetExceededError";
  }
}

export class ConcurrencyLimiter {
  private maxConcurrency: number;
  private runningCount: number = 0;
  private waitQueue: Array<() => void> = [];

  constructor(maxConcurrency?: number) {
    this.maxConcurrency = maxConcurrency ?? getEnv().MAX_CONCURRENT_EXPLORERS;
  }

  async acquire(): Promise<() => void> {
    if (this.runningCount < this.maxConcurrency) {
      this.runningCount++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.release();
        }
      };
    }

    return new Promise<() => void>((resolve) => {
      this.waitQueue.push(() => {
        this.runningCount++;
        let released = false;
        resolve(() => {
          if (!released) {
            released = true;
            this.release();
          }
        });
      });
    });
  }

  private release(): void {
    this.runningCount--;
    if (this.waitQueue.length > 0 && this.runningCount < this.maxConcurrency) {
      const next = this.waitQueue.shift();
      if (next) {
        next();
      }
    }
  }

  get activeCount(): number {
    return this.runningCount;
  }
}

export class JobBudgetTracker {
  public jobId: string;
  public maxAgentCalls: number;
  public timeoutMs: number;
  public startTime: number;
  public agentCallsCount: number = 0;
  public totalEstimatedCostUsd: number = 0;

  constructor(jobId: string, maxAgentCalls?: number, timeoutSeconds?: number) {
    const env = getEnv();
    this.jobId = jobId;
    this.maxAgentCalls = maxAgentCalls ?? env.MAX_AGENT_RUNS_PER_JOB;
    this.timeoutMs = (timeoutSeconds ?? env.JOB_TIMEOUT_SECONDS) * 1000;
    this.startTime = Date.now();
  }

  get maxAgentRuns(): number {
    return this.maxAgentCalls;
  }

  canMakeAgentCall(): boolean {
    const elapsed = Date.now() - this.startTime;
    return this.agentCallsCount < this.maxAgentCalls && elapsed < this.timeoutMs;
  }

  recordAgentCall(estimatedCostUsd: number = 0.01): void {
    this.agentCallsCount++;
    this.totalEstimatedCostUsd += estimatedCostUsd;

    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.timeoutMs) {
      const msg = `Job ${this.jobId} exceeded maximum runtime of ${(this.timeoutMs / 1000).toFixed(0)}s (elapsed: ${(elapsed / 1000).toFixed(1)}s)`;
      logger.error(msg, { jobId: this.jobId, elapsedMs: elapsed });
      throw new JobBudgetExceededError(msg);
    }

    if (this.agentCallsCount > this.maxAgentCalls) {
      const msg = `Job ${this.jobId} exceeded maximum allowed agent invocations (${this.maxAgentCalls}). Halted to prevent unbounded agent loop.`;
      logger.error(msg, { jobId: this.jobId, calls: this.agentCallsCount });
      throw new JobBudgetExceededError(msg);
    }

    logger.debug("Job budget recorded agent call", {
      jobId: this.jobId,
      calls: this.agentCallsCount,
      maxCalls: this.maxAgentCalls,
      totalCostUsd: this.totalEstimatedCostUsd,
    });
  }

  checkTimeout(): void {
    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.timeoutMs) {
      throw new JobBudgetExceededError(
        `Job ${this.jobId} timed out after ${(elapsed / 1000).toFixed(1)}s`
      );
    }
  }
}

