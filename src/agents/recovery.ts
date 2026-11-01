import { randomUUID } from "node:crypto";
import { RunStatus } from "@tiny-fish/sdk";
import type { Repository } from "../persistence/repository.js";
import {
  SiteAdapterSchema,
  type AgentResult,
  type AgentTask,
  type SiteAdapter,
  type StepBinding,
} from "../types/domain.js";
import { TinyFishClient } from "./tinyfishClient.js";
import { logger } from "../utils/logger.js";

export interface RecoveryContext {
  task: AgentTask;
  activeAdapter: SiteAdapter;
  failingBindingKey: "SEARCH_INPUT" | "PRODUCT_CARD" | "PRODUCT_TITLE" | "PRODUCT_PRICE" | "OPEN";
  failureDetails: {
    code: string;
    message: string;
    currentUrl?: string;
  };
  query: string;
}

export const RECOVERY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    repaired_binding: {
      type: "object",
      properties: {
        semantic_role: { type: "string" },
        repaired_selector: { type: "string" },
        anchor_attribute: { type: "string" },
        explanation: { type: "string" },
      },
      required: [
        "semantic_role",
        "repaired_selector",
        "anchor_attribute",
        "explanation",
      ],
    },
    verification_product: {
      type: "object",
      properties: {
        title: { type: "string" },
        price: { type: "string" },
        product_url: { type: "string" },
      },
      required: ["title", "price", "product_url"],
    },
  },
  required: ["repaired_binding", "verification_product"],
};

export class RecoveryAgent {
  private client: TinyFishClient;
  private repo?: Repository;

  constructor(client?: TinyFishClient, repo?: Repository) {
    this.client = client ?? new TinyFishClient();
    this.repo = repo;
  }

  /**
   * Autonomous self-healing recovery:
   * When an execution fails with BINDING_FAILED or STUCK, Recovery Agent runs
   * TinyFish on the reconstructible URL, inspects mutated DOM, and synthesizes a
   * CANDIDATE SiteAdapter vNext for independent 2-query validation.
   *
   * CRITICAL: Never modifies active skill/adapter directly. Status is always CANDIDATE.
   */
  async recoverBinding(context: RecoveryContext): Promise<{
    candidateAdapter: SiteAdapter;
    recoveryRunId: string;
    diagnosis: string;
  }> {
    const { task, activeAdapter, failingBindingKey, failureDetails, query } = context;
    const oldBinding = activeAdapter.locatorBindings[failingBindingKey];
    const targetUrl = failureDetails.currentUrl || activeAdapter.urlPatterns.entryUrl;

    logger.info("Recovery Agent initiating autonomous self-healing diagnosis", {
      taskId: task.taskId,
      domain: activeAdapter.domain,
      failingBinding: failingBindingKey,
      previousSelector: oldBinding?.locatorValue,
      targetUrl,
    });

    if (this.repo) {
      this.repo.logEvent({
        eventId: randomUUID(),
        jobId: task.jobId,
        runId: task.taskId,
        agentRole: "RECOVERY",
        state: "RECOVERING",
        site: activeAdapter.domain,
        timestamp: new Date().toISOString(),
        payloadSummary: {
          failingBindingKey,
          oldSelector: oldBinding?.locatorValue,
          failureMessage: failureDetails.message,
          targetUrl,
        },
      });
    }

    const recoveryGoal = `
The website at ${targetUrl} had a layout change.
The step '${failingBindingKey}' failed using selector '${oldBinding?.locatorValue || "unknown"}'.
Failure details: ${failureDetails.message}

Please inspect the current page:
1. Identify the updated, working locator for '${failingBindingKey}'.
2. Find resilient anchor attributes (role, aria-label, placeholder, testid, text).
3. Search for product '${query}' and extract the product title, price, and product_url to prove the repaired locator functions properly.
`.trim();

    // Call TinyFish Agent to inspect live mutated page
    const providerResult = await this.client.runAutomation({
      url: targetUrl,
      goal: recoveryGoal,
      outputSchema: RECOVERY_OUTPUT_SCHEMA,
    });

    if (providerResult.status !== RunStatus.COMPLETED || !providerResult.result) {
      const errorMsg = `TinyFish Recovery Agent failed to diagnose DOM mutation: ${providerResult.error?.message || "No result produced"}`;
      logger.error(errorMsg, { taskId: task.taskId, status: providerResult.status });
      throw new Error(errorMsg);
    }

    const rawOutput = providerResult.result as {
      repaired_binding: {
        semantic_role: string;
        repaired_selector: string;
        anchor_attribute: string;
        explanation: string;
      };
      verification_product: {
        title: string;
        price: string;
        product_url: string;
      };
    };

    const repairedBinding = rawOutput.repaired_binding;
    if (!repairedBinding?.repaired_selector || !repairedBinding.repaired_selector.trim()) {
      throw new Error("TinyFish Recovery Agent returned empty repaired selector");
    }

    // Increment SemVer version cleanly (e.g. 1.0.0 -> 1.1.0)
    const nextVersion = this.incrementSemver(activeAdapter.adapterVersion);

    // Build the updated StepBinding with provenance and fallback
    const updatedStepBinding: StepBinding = {
      semanticRole: oldBinding ? oldBinding.semanticRole : "SEARCH_INPUT",
      locatorStrategy: "css",
      locatorValue: repairedBinding.repaired_selector.trim(),
      anchorEvidence: {
        text: repairedBinding.anchor_attribute,
        placeholder: repairedBinding.anchor_attribute,
      },
      uniquenessExpectation: oldBinding ? oldBinding.uniquenessExpectation : "SINGLE",
      provenance: "TINYFISH_RECOVERY",
      sourceRunId: providerResult.runId ?? undefined,
      domain: activeAdapter.domain,
      version: nextVersion,
    };

    // Create Candidate Replacement Adapter
    const candidateAdapter: SiteAdapter = {
      ...activeAdapter,
      adapterVersion: nextVersion,
      status: "CANDIDATE", // CRITICAL: NEVER mark ACTIVE here
      locatorBindings: {
        ...activeAdapter.locatorBindings,
        [failingBindingKey]: updatedStepBinding,
      },
      evidence: {
        ...activeAdapter.evidence,
        traceId: providerResult.runId ?? undefined,
        sampleProductUrl: rawOutput.verification_product.product_url,
      },
      source: "agent",
      validationQueries: [],
      validationResults: [],
      createdAt: new Date().toISOString(),
      promotedAt: undefined,
    };

    const validatedCandidate = SiteAdapterSchema.parse(candidateAdapter);

    if (this.repo) {
      this.repo.saveSiteAdapter(validatedCandidate);
      this.repo.logEvent({
        eventId: randomUUID(),
        jobId: task.jobId,
        runId: task.taskId,
        agentRole: "RECOVERY",
        state: "VALIDATING_CANDIDATE",
        site: activeAdapter.domain,
        timestamp: new Date().toISOString(),
        payloadSummary: {
          previousVersion: activeAdapter.adapterVersion,
          candidateVersion: nextVersion,
          repairedBindingKey: failingBindingKey,
          repairedSelector: repairedBinding.repaired_selector,
          explanation: repairedBinding.explanation,
        },
      });
    }

    logger.info("Recovery Agent synthesized candidate SiteAdapter vNext", {
      domain: activeAdapter.domain,
      previousVersion: activeAdapter.adapterVersion,
      candidateVersion: nextVersion,
      repairedBindingKey: failingBindingKey,
    });

    return {
      candidateAdapter: validatedCandidate,
      recoveryRunId: providerResult.runId || randomUUID(),
      diagnosis: repairedBinding.explanation || `Repaired ${failingBindingKey} with selector '${repairedBinding.repaired_selector}'`,
    };
  }

  private incrementSemver(currentVersion: string): string {
    const parts = currentVersion.split(".").map(Number);
    if (parts.length === 3 && parts.every((p) => !isNaN(p))) {
      return `${parts[0]}.${parts[1] + 1}.0`;
    }
    return "1.1.0";
  }
}
