import { randomUUID } from "node:crypto";
import { RunStatus } from "@tiny-fish/sdk";
import type { Repository } from "../persistence/repository.js";
import {
  AgentResultSchema,
  type AgentResult,
  type AgentTask,
  type RunEvent,
} from "../types/domain.js";
import { TinyFishClient, type ProviderExecutionSummary } from "./tinyfishClient.js";
import { logger } from "../utils/logger.js";

/**
 * Strict JSON Schema passed to TinyFish Agent for structured extraction.
 * Complies with TinyFish keywords allowlist (no additionalProperties, no oneOf).
 */
export const EXPLORER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    product: {
      type: "object",
      properties: {
        title: { type: "string" },
        model_sku: { type: "string", nullable: true },
        numeric_price: { type: "number" },
        currency: { type: "string" },
        product_url: { type: "string" },
        evidence_url: { type: "string" },
        retrieval_time: { type: "string" },
        evidence_explanation: { type: "string" },
      },
      required: [
        "title",
        "model_sku",
        "numeric_price",
        "currency",
        "product_url",
        "evidence_url",
        "retrieval_time",
        "evidence_explanation",
      ],
    },
    candidate_bindings: {
      type: "object",
      properties: {
        search_input_selector: { type: "string" },
        search_input_anchor: { type: "string" },
        product_card_selector: { type: "string" },
        product_card_anchor: { type: "string" },
        title_selector: { type: "string" },
        title_anchor: { type: "string" },
        price_selector: { type: "string" },
        price_anchor: { type: "string" },
        evidence_explanation: { type: "string" },
      },
      required: [
        "search_input_selector",
        "search_input_anchor",
        "product_card_selector",
        "product_card_anchor",
        "title_selector",
        "title_anchor",
        "price_selector",
        "price_anchor",
        "evidence_explanation",
      ],
    },
  },
  required: ["product", "candidate_bindings"],
};

export class ExplorerAgent {
  private client: TinyFishClient;
  private repo?: Repository;

  constructor(client?: TinyFishClient, repo?: Repository) {
    this.client = client ?? new TinyFishClient();
    this.repo = repo;
  }

  /**
   * Explores a target site to discover a product and induce candidate locator bindings.
   */
  async explore(task: AgentTask): Promise<AgentResult> {
    const correlationId = task.correlationId || randomUUID();
    const query = (task.inputPayload?.query as string) || task.goal;

    logger.info("Explorer Agent initiating live exploration", {
      taskId: task.taskId,
      site: task.site,
      query,
    });

    if (this.repo) {
      this.repo.saveTask(task);
      this.repo.logEvent({
        eventId: randomUUID(),
        jobId: task.jobId,
        runId: task.taskId,
        agentRole: "EXPLORER",
        state: "TEACHING",
        site: task.site,
        timestamp: new Date().toISOString(),
        payloadSummary: { query, goal: task.goal },
      });
    }

    // Precise, unambiguous goal prompt (as specified in TinyFish goals reference)
    const goal = [
      `Perform a read-only search and product extraction for: "${query}".`,
      `Target URL: ${task.site}.`,
      `1. Navigate to the search input. Record its CSS/XPath selector and stable anchor attributes (role, aria-label, placeholder, or name).`,
      `2. Search for the query and observe the results page. Record the repeating product card container selector and its structural pattern.`,
      `3. Select the best matching listing for "${query}". Extract the title, model/SKU if visible (otherwise null), numeric price only, currency, and product URL.`,
      `4. Record candidate selectors and semantic anchor attributes for the title and price elements within the selected card.`,
      `5. Provide explicit evidence explanations for every extracted field and selector.`,
      `Guardrails: Do not add items to cart, do not click buy, do not attempt login. Strictly read-only product discovery.`,
    ].join("\n");

    let providerSummary: ProviderExecutionSummary;
    try {
      providerSummary = await this.client.runAutomation({
        url: task.site.startsWith("http") ? task.site : `https://${task.site}`,
        goal,
        outputSchema: EXPLORER_OUTPUT_SCHEMA,
        browserProfile: "stealth",
        maxSteps: task.maxSteps || 25,
        maxDurationSeconds: task.budget?.maxSeconds || 120,
        sessionId: randomUUID(),
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.handleExecutionFailure(task, errMsg);
    }

    const normalized = this.normalizeProviderResponse(task, providerSummary);

    if (this.repo) {
      this.repo.saveResult(normalized);
      this.repo.logEvent({
        eventId: randomUUID(),
        jobId: task.jobId,
        runId: task.taskId,
        agentRole: "EXPLORER",
        state: normalized.status === "SUCCESS" ? "COMPILING" : normalized.status,
        site: task.site,
        timestamp: new Date().toISOString(),
        payloadSummary: {
          status: normalized.status,
          stepsCompleted: normalized.stepsUsage?.stepsCompleted ?? 0,
          durationMs: normalized.durationMs,
        },
        redactedError: normalized.errors[0]?.message,
      });
    }

    return normalized;
  }

  /**
   * Normalizes raw TinyFish provider output into the ShadowTwin typed AgentResult.
   */
  normalizeProviderResponse(
    task: AgentTask,
    summary: ProviderExecutionSummary
  ): AgentResult {
    const rawResult = summary.result as Record<string, unknown> | null;
    const errors: Array<{ code: string; message: string; stepId?: string }> = [];
    const warnings: string[] = [];
    const evidenceReferences: string[] = [];

    let status: "SUCCESS" | "FAILED" | "STUCK" | "NEEDS_REVIEW" | "BLOCKED" = "NEEDS_REVIEW";

    // 1. Check for provider-level failures or blocks
    if (summary.status === RunStatus.FAILED || summary.error) {
      const errMsg = summary.error?.message || "TinyFish automation failed";
      const isBlock =
        errMsg.toLowerCase().includes("blocked") ||
        errMsg.toLowerCase().includes("captcha") ||
        errMsg.toLowerCase().includes("403") ||
        errMsg.toLowerCase().includes("access denied");

      status = isBlock ? "BLOCKED" : "FAILED";
      errors.push({
        code: summary.error?.code || (isBlock ? "BOT_BLOCKED" : "PROVIDER_ERROR"),
        message: errMsg,
      });
    } else if (summary.status === RunStatus.COMPLETED) {
      // 2. Validate extracted content
      if (!rawResult || Object.keys(rawResult).length === 0) {
        status = "NEEDS_REVIEW";
        errors.push({
          code: "EMPTY_RESULT",
          message: "TinyFish completed but returned an empty result object",
        });
      } else {
        const product = rawResult.product as Record<string, unknown> | undefined;
        const bindings = rawResult.candidate_bindings as Record<string, unknown> | undefined;

        if (!product || !bindings) {
          status = "NEEDS_REVIEW";
          errors.push({
            code: "INCOMPLETE_SCHEMA",
            message: "Missing product or candidate_bindings section in extracted result",
          });
        } else {
          // Verify critical fields
          const title = String(product.title || "").trim();
          const price = Number(product.numeric_price);
          const productUrl = String(product.product_url || "");

          if (!title || isNaN(price) || price <= 0 || !productUrl) {
            status = "NEEDS_REVIEW";
            warnings.push("Extracted product has missing title, non-positive price, or empty URL");
          } else {
            status = "SUCCESS";
            if (productUrl) evidenceReferences.push(productUrl);
            if (product.evidence_url) evidenceReferences.push(String(product.evidence_url));
          }
        }
      }
    }

    const agentResult: AgentResult = {
      taskId: task.taskId,
      jobId: task.jobId,
      status,
      structuredOutput: rawResult,
      evidenceReferences,
      providerRunIds: {
        tinyFishRunId: summary.runId ?? undefined,
      },
      stepsUsage:
        summary.numOfSteps !== null
          ? {
              stepsCompleted: summary.numOfSteps,
            }
          : null,
      durationMs: summary.durationMs,
      errors,
      warnings,
    };

    return AgentResultSchema.parse(agentResult);
  }

  private handleExecutionFailure(task: AgentTask, errorMsg: string): AgentResult {
    const isBlock =
      errorMsg.toLowerCase().includes("blocked") ||
      errorMsg.toLowerCase().includes("captcha") ||
      errorMsg.toLowerCase().includes("403");

    const agentResult: AgentResult = {
      taskId: task.taskId,
      jobId: task.jobId,
      status: isBlock ? "BLOCKED" : "FAILED",
      structuredOutput: null,
      evidenceReferences: [],
      providerRunIds: {},
      stepsUsage: null,
      durationMs: 0,
      errors: [
        {
          code: isBlock ? "BOT_BLOCKED" : "EXECUTION_ERROR",
          message: errorMsg,
        },
      ],
      warnings: [],
    };

    return AgentResultSchema.parse(agentResult);
  }
}
