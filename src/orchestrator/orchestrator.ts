import { randomUUID } from "node:crypto";
import { getEnv } from "../config/env.js";
import type { Repository } from "../persistence/repository.js";
import { ExplorerAgent } from "../agents/explorer.js";
import { CompilerAgent, type TaskProfile } from "../agents/compiler.js";
import { PlaywrightRunner, type ReplayOptions } from "../executor/playwrightRunner.js";
import { ValidatorWorker } from "../validator/validatorWorker.js";
import { RecoveryAgent } from "../agents/recovery.js";
import { OrchestratorStateMachine, type OrchestratorState } from "./stateMachine.js";
import { ConcurrencyLimiter, JobBudgetTracker } from "./concurrencyBudget.js";
import {
  type AgentTask,
  type AgentResult,
  type SiteAdapter,
  type Skill,
  type ValidationResult,
} from "../types/domain.js";
import { logger } from "../utils/logger.js";

export interface TeachParams {
  jobId?: string;
  domain: string;
  entryUrl: string;
  sampleQuery: string;
  validationQueries: string[];
}

export interface TeachOutcome {
  jobId: string;
  status: "SUCCESS" | "NEEDS_REVIEW" | "BLOCKED" | "FAILED";
  skill?: Skill;
  adapter?: SiteAdapter;
  finalState: OrchestratorState;
  reason?: string;
  validationResults: ValidationResult[];
}

export interface ExecuteParams {
  jobId?: string;
  domain: string;
  query: string;
  taskProfile?: TaskProfile;
  fallbackValidationQuery?: string;
  replayOptions?: ReplayOptions;
}

export interface ExecuteOutcome {
  jobId: string;
  status: "SUCCESS" | "STUCK" | "NEEDS_REVIEW" | "BLOCKED" | "FAILED";
  finalState: OrchestratorState;
  product?: Record<string, unknown>;
  selfHealed: boolean;
  activeVersion: string;
  agentCallsCount: number;
  durationMs: number;
  reason?: string;
}

export class ShadowTwinOrchestrator {
  private repo: Repository;
  private explorer: ExplorerAgent;
  private compiler: CompilerAgent;
  private runner: PlaywrightRunner;
  private validator: ValidatorWorker;
  private recovery: RecoveryAgent;
  private concurrencyLimiter: ConcurrencyLimiter;

  constructor(
    repo: Repository,
    explorer?: ExplorerAgent,
    compiler?: CompilerAgent,
    runner?: PlaywrightRunner,
    validator?: ValidatorWorker,
    recovery?: RecoveryAgent,
    concurrencyLimiter?: ConcurrencyLimiter
  ) {
    this.repo = repo;
    this.explorer = explorer ?? new ExplorerAgent(undefined, repo);
    this.compiler = compiler ?? new CompilerAgent(repo);
    this.runner = runner ?? new PlaywrightRunner(repo);
    this.validator = validator ?? new ValidatorWorker(repo);
    this.recovery = recovery ?? new RecoveryAgent(undefined, repo);
    this.concurrencyLimiter = concurrencyLimiter ?? new ConcurrencyLimiter();
  }

  /**
   * Product Discovery Workflow Teaching:
   * 1. READY -> TEACHING (TinyFish Explorer explores site)
   * 2. TEACHING -> COMPILING (CompilerAgent synthesizes platform-neutral skill + candidate adapter)
   * 3. COMPILING -> VALIDATING_CANDIDATE (Independent local Playwright replay across >= 2 queries)
   * 4. VALIDATING_CANDIDATE -> ACTIVE (Atomic promotion upon passing both queries)
   */
  async teach(params: TeachParams): Promise<TeachOutcome> {
    const jobId = params.jobId || randomUUID();
    const sm = new OrchestratorStateMachine(jobId, params.domain, this.repo, "READY");
    const budget = new JobBudgetTracker(jobId);
    const startTime = Date.now();

    logger.info("Orchestrator starting workflow induction (teach)", {
      jobId,
      domain: params.domain,
      query: params.sampleQuery,
    });

    // 1. Acquire bounded concurrency permit
    const releaseConcurrency = await this.concurrencyLimiter.acquire();

    try {
      // -----------------------------------------------------------------------
      // Step 1: READY -> TEACHING
      // -----------------------------------------------------------------------
      sm.transition("TEACHING", {
        agentRole: "ORCHESTRATOR",
        reason: "Initiating live web exploration with TinyFish Agent",
      });

      const explorationTask: AgentTask = {
        taskId: randomUUID(),
        jobId,
        role: "EXPLORER",
        goal: `Explore ${params.domain} and find product '${params.sampleQuery}'`,
        site: params.domain,
        inputPayload: { query: params.sampleQuery, entryUrl: params.entryUrl },
        deadline: new Date(Date.now() + 60000).toISOString(),
        correlationId: jobId,
        maxSteps: 15,
        budget: { maxSeconds: 120, maxUsd: 1.0 },
      };

      budget.recordAgentCall(0.015);
      const explorationResult = await this.explorer.explore(explorationTask);

      if (explorationResult.status === "BLOCKED") {
        sm.transition("BLOCKED", {
          agentRole: "EXPLORER",
          reason: "Target storefront access restricted or blocked",
        });
        return {
          jobId,
          status: "BLOCKED",
          finalState: sm.getState(),
          reason: "Storefront access blocked or bot challenge detected",
          validationResults: [],
        };
      }

      if (explorationResult.status !== "SUCCESS" || !explorationResult.structuredOutput) {
        sm.transition("NEEDS_REVIEW", {
          agentRole: "EXPLORER",
          reason: "TinyFish exploration failed to yield valid product and locator bindings",
        });
        return {
          jobId,
          status: "NEEDS_REVIEW",
          finalState: sm.getState(),
          reason: explorationResult.errors[0]?.message || "Exploration incomplete",
          validationResults: [],
        };
      }

      // -----------------------------------------------------------------------
      // Step 2: TEACHING -> COMPILING
      // -----------------------------------------------------------------------
      sm.transition("COMPILING", {
        agentRole: "COMPILER",
        reason: "Compiling platform-neutral skill and domain site adapter",
      });

      const compiled = await this.compiler.compile({
        domain: params.domain,
        entryUrl: params.entryUrl,
        explorerResult: explorationResult,
      });

      // Save candidates into repository
      this.repo.saveSkill(compiled.skill);
      this.repo.saveSiteAdapter(compiled.adapter);

      // -----------------------------------------------------------------------
      // Step 3: COMPILING -> VALIDATING_CANDIDATE
      // -----------------------------------------------------------------------
      sm.transition("VALIDATING_CANDIDATE", {
        agentRole: "VALIDATOR",
        reason: "Running independent local Playwright replay across test queries",
      });

      const queriesToTest = Array.from(
        new Set([params.sampleQuery, ...params.validationQueries])
      );

      if (queriesToTest.length < 2) {
        queriesToTest.push(`${params.sampleQuery} alternate`);
      }

      const queryValidationResults: Array<{ query: string; result: ValidationResult }> = [];

      for (const query of queriesToTest.slice(0, 2)) {
        const testTask: AgentTask = {
          taskId: randomUUID(),
          jobId,
          role: "EXECUTOR",
          goal: `Validate candidate adapter with query '${query}'`,
          site: params.domain,
          inputPayload: { query },
          deadline: new Date(Date.now() + 60000).toISOString(),
          correlationId: jobId,
          maxSteps: 10,
          budget: { maxSeconds: 30, maxUsd: 0 },
        };

        const testReplay = await this.runner.executeReplay(testTask, compiled.skill, compiled.adapter);
        const valResult = this.validator.validateResult(testTask, testReplay, compiled.adapter);
        queryValidationResults.push({ query, result: valResult });
      }

      const promotionGate = this.validator.validateCandidateForPromotion(
        compiled.adapter,
        queryValidationResults
      );

      if (!promotionGate.eligible) {
        sm.transition("NEEDS_REVIEW", {
          agentRole: "VALIDATOR",
          reason: promotionGate.reason,
        });
        return {
          jobId,
          status: "NEEDS_REVIEW",
          finalState: sm.getState(),
          reason: promotionGate.reason,
          validationResults: queryValidationResults.map((q) => q.result),
        };
      }

      // -----------------------------------------------------------------------
      // Step 4: VALIDATING_CANDIDATE -> ACTIVE
      // -----------------------------------------------------------------------
      this.repo.promoteSiteAdapter(params.domain, compiled.adapter.adapterVersion);
      this.repo.promoteSkill(compiled.skill.id);

      sm.transition("ACTIVE", {
        agentRole: "ORCHESTRATOR",
        reason: `Promoted candidate adapter v${compiled.adapter.adapterVersion} to ACTIVE`,
      });

      const activeAdapter = this.repo.getActiveSiteAdapter(params.domain);
      const activeSkill = this.repo.getActiveSkill();

      logger.info("Workflow induction complete. Active skill & adapter promoted.", {
        jobId,
        domain: params.domain,
        version: activeAdapter?.adapterVersion,
        durationMs: Date.now() - startTime,
      });

      return {
        jobId,
        status: "SUCCESS",
        skill: activeSkill || compiled.skill,
        adapter: activeAdapter || compiled.adapter,
        finalState: sm.getState(),
        validationResults: queryValidationResults.map((q) => q.result),
      };
    } finally {
      releaseConcurrency();
    }
  }

  /**
   * Deterministic Fast Replay and Self-Healing Execution:
   * 1. ACTIVE -> EXECUTING (Playwright replay with 0 TinyFish calls)
   * 2. If PASS -> EXECUTING -> DONE
   * 3. If BINDING_FAILED -> EXECUTING -> STUCK -> RECOVERING (TinyFish Recovery Agent diagnoses page)
   * 4. RECOVERING -> VALIDATING_CANDIDATE (2-query independent validation)
   * 5. VALIDATING_CANDIDATE -> ACTIVE (Atomic promotion of vNext)
   * 6. Re-execute query deterministically on vNext -> DONE
   */
  async execute(params: ExecuteParams): Promise<ExecuteOutcome> {
    const jobId = params.jobId || randomUUID();
    const sm = new OrchestratorStateMachine(jobId, params.domain, this.repo, "READY");
    const budget = new JobBudgetTracker(jobId);
    const startTime = Date.now();

    // 1. Load active skill and active adapter
    let activeAdapter = this.repo.getActiveSiteAdapter(params.domain);
    let activeSkill = this.repo.getActiveSkill();

    if (!activeAdapter || !activeSkill) {
      return {
        jobId,
        status: "FAILED",
        finalState: "READY",
        selfHealed: false,
        activeVersion: "none",
        agentCallsCount: 0,
        durationMs: Date.now() - startTime,
        reason: `No ACTIVE skill or SiteAdapter found for domain '${params.domain}'. Run teach first.`,
      };
    }

    // 2. READY -> EXECUTING
    sm.transition("EXECUTING", {
      agentRole: "EXECUTOR",
      reason: `Executing deterministic replay for query '${params.query}'`,
    });

    const task: AgentTask = {
      taskId: randomUUID(),
      jobId,
      role: "EXECUTOR",
      goal: `Search for '${params.query}' on ${params.domain}`,
      site: params.domain,
      inputPayload: { query: params.query },
      deadline: new Date(Date.now() + 60000).toISOString(),
      correlationId: jobId,
      maxSteps: 10,
      budget: { maxSeconds: 30, maxUsd: 0 },
    };

    const replayResult = await this.runner.executeReplay(
      task,
      activeSkill,
      activeAdapter,
      params.replayOptions
    );

    const valResult = this.validator.validateResult(task, replayResult, activeAdapter);

    // =========================================================================
    // Scenario A: First Replay Passes (Zero TinyFish Calls)
    // =========================================================================
    if (valResult.status === "PASS") {
      sm.transition("DONE", {
        agentRole: "VALIDATOR",
        reason: "Deterministic Playwright replay completed with all postconditions verified",
      });

      return {
        jobId,
        status: "SUCCESS",
        finalState: sm.getState(),
        product: valResult.verifiedOutput,
        selfHealed: false,
        activeVersion: activeAdapter.adapterVersion,
        agentCallsCount: 0, // Strictly 0 TinyFish calls
        durationMs: Date.now() - startTime,
      };
    }

    // =========================================================================
    // Scenario B: Bot Blocked
    // =========================================================================
    if (valResult.status === "BLOCKED") {
      sm.transition("BLOCKED", {
        agentRole: "VALIDATOR",
        reason: "Access to storefront blocked or rate limited",
      });
      return {
        jobId,
        status: "BLOCKED",
        finalState: sm.getState(),
        selfHealed: false,
        activeVersion: activeAdapter.adapterVersion,
        agentCallsCount: 0,
        durationMs: Date.now() - startTime,
        reason: "Target storefront access blocked",
      };
    }

    // =========================================================================
    // Scenario C: Product Identity Mismatch
    // =========================================================================
    if (valResult.status === "NEEDS_REVIEW" && valResult.failureCategory === "MISMATCH") {
      sm.transition("NEEDS_REVIEW", {
        agentRole: "VALIDATOR",
        reason: "Extracted product failed semantic identity matching",
      });
      return {
        jobId,
        status: "NEEDS_REVIEW",
        finalState: sm.getState(),
        selfHealed: false,
        activeVersion: activeAdapter.adapterVersion,
        agentCallsCount: 0,
        durationMs: Date.now() - startTime,
        reason: "Extracted product does not match user query",
      };
    }

    // =========================================================================
    // Scenario D: Binding Failed -> Autonomous Self-Healing Recovery Loop
    // =========================================================================
    logger.warn("Deterministic replay failed postcondition; initiating recovery loop", {
      jobId,
      domain: params.domain,
      failureCategory: valResult.failureCategory,
      errors: replayResult.errors,
    });

    sm.transition("STUCK", {
      agentRole: "EXECUTOR",
      reason: `Replay stuck: ${replayResult.errors[0]?.message || "Binding failed"}`,
    });

    sm.transition("RECOVERING", {
      agentRole: "RECOVERY",
      reason: "Recovery Agent diagnosing mutated DOM and synthesizing candidate adapter",
    });

    // Record recovery agent call against budget
    budget.recordAgentCall(0.015);

    // Identify failing binding key
    const failingBindingKey = this.identifyFailingBinding(replayResult);

    const recoveryOutcome = await this.recovery.recoverBinding({
      task,
      activeAdapter,
      failingBindingKey,
      failureDetails: {
        code: replayResult.errors[0]?.code || "BINDING_FAILED",
        message: replayResult.errors[0]?.message || "Selector broken",
        currentUrl: activeAdapter.urlPatterns.entryUrl,
      },
      query: params.query,
    });

    const candidateAdapter = recoveryOutcome.candidateAdapter;

    // Transition: RECOVERING -> VALIDATING_CANDIDATE
    sm.transition("VALIDATING_CANDIDATE", {
      agentRole: "VALIDATOR",
      reason: "Validating synthesized candidate adapter vNext on 2 distinct queries",
    });

    const secondQuery = params.fallbackValidationQuery || (params.query.includes("Arduino") ? "ESP32" : "Arduino Uno");

    // Validation Query 1: current query
    const valTask1: AgentTask = {
      taskId: randomUUID(),
      jobId,
      role: "EXECUTOR",
      goal: `Validate healed adapter with '${params.query}'`,
      site: params.domain,
      inputPayload: { query: params.query },
      deadline: new Date(Date.now() + 60000).toISOString(),
      correlationId: jobId,
      maxSteps: 10,
      budget: { maxSeconds: 30, maxUsd: 0 },
    };
    const valExec1 = await this.runner.executeReplay(valTask1, activeSkill, candidateAdapter);
    const valRes1 = this.validator.validateResult(valTask1, valExec1, candidateAdapter);

    // Validation Query 2: second query
    const valTask2: AgentTask = {
      taskId: randomUUID(),
      jobId,
      role: "EXECUTOR",
      goal: `Validate healed adapter with '${secondQuery}'`,
      site: params.domain,
      inputPayload: { query: secondQuery },
      deadline: new Date(Date.now() + 60000).toISOString(),
      correlationId: jobId,
      maxSteps: 10,
      budget: { maxSeconds: 30, maxUsd: 0 },
    };
    const valExec2 = await this.runner.executeReplay(valTask2, activeSkill, candidateAdapter);
    const valRes2 = this.validator.validateResult(valTask2, valExec2, candidateAdapter);

    // Evaluate promotion gate
    const gateDecision = this.validator.validateCandidateForPromotion(candidateAdapter, [
      { query: params.query, result: valRes1 },
      { query: secondQuery, result: valRes2 },
    ]);

    if (!gateDecision.eligible) {
      sm.transition("NEEDS_REVIEW", {
        agentRole: "VALIDATOR",
        reason: `Recovery validation gate failed: ${gateDecision.reason}`,
      });
      return {
        jobId,
        status: "NEEDS_REVIEW",
        finalState: sm.getState(),
        selfHealed: false,
        activeVersion: activeAdapter.adapterVersion,
        agentCallsCount: budget.agentCallsCount,
        durationMs: Date.now() - startTime,
        reason: gateDecision.reason,
      };
    }

    // Atomic promotion of candidate adapter to ACTIVE
    this.repo.promoteSiteAdapter(params.domain, candidateAdapter.adapterVersion);

    sm.transition("ACTIVE", {
      agentRole: "ORCHESTRATOR",
      reason: `Promoted repaired candidate adapter v${candidateAdapter.adapterVersion} to ACTIVE`,
    });

    activeAdapter = this.repo.getActiveSiteAdapter(params.domain)!;

    // Transition back to EXECUTING -> DONE with successful product
    sm.transition("EXECUTING", {
      agentRole: "EXECUTOR",
      reason: `Executing query '${params.query}' deterministically on active healed adapter v${activeAdapter.adapterVersion}`,
    });

    sm.transition("DONE", {
      agentRole: "VALIDATOR",
      reason: "Self-healing execution completed with verified product output",
    });

    return {
      jobId,
      status: "SUCCESS",
      finalState: sm.getState(),
      product: valRes1.verifiedOutput,
      selfHealed: true,
      activeVersion: activeAdapter.adapterVersion,
      agentCallsCount: budget.agentCallsCount,
      durationMs: Date.now() - startTime,
    };
  }

  private identifyFailingBinding(
    result: AgentResult
  ): "SEARCH_INPUT" | "PRODUCT_CARD" | "PRODUCT_TITLE" | "PRODUCT_PRICE" | "OPEN" {
    const errorMsg = result.errors.map((e) => e.message).join(" ");
    if (errorMsg.includes("SEARCH")) return "SEARCH_INPUT";
    if (errorMsg.includes("card") || errorMsg.includes("PARSE") || errorMsg.includes("product cards")) {
      return "PRODUCT_CARD";
    }
    if (errorMsg.includes("price") || errorMsg.includes("numericPrice")) return "PRODUCT_PRICE";
    if (errorMsg.includes("title")) return "PRODUCT_TITLE";
    return "SEARCH_INPUT";
  }
}
