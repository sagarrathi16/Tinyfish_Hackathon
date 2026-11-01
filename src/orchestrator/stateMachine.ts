import { randomUUID } from "node:crypto";
import type { Repository } from "../persistence/repository.js";
import { logger } from "../utils/logger.js";

export type OrchestratorState =
  | "READY"
  | "TEACHING"
  | "COMPILING"
  | "VALIDATING_CANDIDATE"
  | "ACTIVE"
  | "EXECUTING"
  | "DONE"
  | "STUCK"
  | "RECOVERING"
  | "NEEDS_REVIEW"
  | "BLOCKED"
  | "FAILED";

const VALID_TRANSITIONS: Record<OrchestratorState, OrchestratorState[]> = {
  READY: ["TEACHING", "EXECUTING", "BLOCKED", "FAILED"],
  TEACHING: ["COMPILING", "BLOCKED", "NEEDS_REVIEW", "FAILED"],
  COMPILING: ["VALIDATING_CANDIDATE", "NEEDS_REVIEW", "FAILED"],
  VALIDATING_CANDIDATE: ["ACTIVE", "NEEDS_REVIEW", "BLOCKED", "FAILED"],
  ACTIVE: ["EXECUTING", "READY"],
  EXECUTING: ["DONE", "STUCK", "NEEDS_REVIEW", "BLOCKED", "FAILED"],
  STUCK: ["RECOVERING", "NEEDS_REVIEW", "BLOCKED", "FAILED"],
  RECOVERING: ["VALIDATING_CANDIDATE", "NEEDS_REVIEW", "BLOCKED", "FAILED"],
  DONE: ["READY", "EXECUTING"],
  NEEDS_REVIEW: ["READY", "TEACHING", "RECOVERING", "FAILED"],
  BLOCKED: ["READY"],
  FAILED: ["READY", "TEACHING"],
};

export class OrchestratorStateMachine {
  private currentState: OrchestratorState;
  private jobId: string;
  private domain: string;
  private repo?: Repository;

  constructor(jobId: string, domain: string, repo?: Repository, initialState: OrchestratorState = "READY") {
    this.jobId = jobId;
    this.domain = domain;
    this.repo = repo;
    this.currentState = initialState;
  }

  getState(): OrchestratorState {
    return this.currentState;
  }

  transition(
    nextState: OrchestratorState,
    context?: {
      agentRole?: "ORCHESTRATOR" | "EXPLORER" | "COMPILER" | "EXECUTOR" | "VALIDATOR" | "RECOVERY" | "BENCHMARK";
      stepId?: string;
      reason?: string;
      details?: Record<string, unknown>;
    }
  ): OrchestratorState {
    const allowed = VALID_TRANSITIONS[this.currentState] || [];
    if (!allowed.includes(nextState)) {
      const errorMsg = `Illegal state machine transition: cannot move from '${this.currentState}' to '${nextState}' for job ${this.jobId}. Allowed transitions: ${allowed.join(", ") || "none"}`;
      logger.error(errorMsg, { jobId: this.jobId, currentState: this.currentState, attemptedState: nextState });
      throw new Error(errorMsg);
    }

    const previousState = this.currentState;
    this.currentState = nextState;

    logger.info("Orchestrator state transition", {
      jobId: this.jobId,
      domain: this.domain,
      from: previousState,
      to: nextState,
      reason: context?.reason,
    });

    if (this.repo) {
      this.repo.logEvent({
        eventId: randomUUID(),
        jobId: this.jobId,
        runId: this.jobId,
        agentRole: context?.agentRole ?? "ORCHESTRATOR",
        state: nextState,
        site: this.domain,
        stepId: context?.stepId,
        timestamp: new Date().toISOString(),
        payloadSummary: {
          previousState,
          newState: nextState,
          reason: context?.reason,
          ...(context?.details || {}),
        },
      });
    }

    return this.currentState;
  }
}

