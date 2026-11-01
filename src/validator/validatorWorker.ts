import { randomUUID } from "node:crypto";
import { getEnv } from "../config/env.js";
import type { Repository } from "../persistence/repository.js";
import {
  ValidationResultSchema,
  type AgentResult,
  type AgentTask,
  type SiteAdapter,
  type ValidationResult,
  type ValidationStatus,
  type FailureCategory,
} from "../types/domain.js";
import { IdentityChecker } from "./identityCheck.js";
import { PostconditionEvaluator } from "./postconditions.js";
import { logger } from "../utils/logger.js";

export interface CritiqueDiagnostic {
  summary: string;
  recommendedAction?: string;
}

export class ValidatorWorker {
  private repo?: Repository;

  constructor(repo?: Repository) {
    this.repo = repo;
  }

  /**
   * Deterministically validates an execution result from TinyFish Explorer or Playwright Replay.
   * Authority for PASS / FAIL / NEEDS_REVIEW / BLOCKED.
   * Critique model diagnostics may accompany the result, but CANNOT override deterministic failures.
   */
  validateResult(
    task: AgentTask,
    result: AgentResult,
    adapter: SiteAdapter,
    critiqueModelDiagnostic?: CritiqueDiagnostic
  ): ValidationResult {
    const query = (task.inputPayload?.query as string) || task.goal;
    const output = (result.structuredOutput || {}) as Record<string, unknown>;

    logger.info("Validator Worker evaluating execution outcome", {
      taskId: task.taskId,
      domain: adapter.domain,
      query,
      resultStatus: result.status,
    });

    // 1. Domain Authorization & SSRF Check
    const domainAuthorized = this.checkDomainAuthorization(adapter.domain, result);

    // 2. Schema Validation Check
    const schemaValid = this.checkSchemaValid(result);

    // 3. Product Identity Match Check
    const title = typeof output.title === "string" ? output.title : "";
    const identityResult = IdentityChecker.verify(query, title);
    const productIdentityMatch = identityResult.match;

    // 4. Price Parsing & Currency Check
    const priceParsedINR = this.checkPriceValid(output);

    // 5. Freshness Timestamp Check
    const freshnessValid = this.checkFreshness(output);

    // 6. Step Postconditions
    const stepPostconditions = PostconditionEvaluator.evaluateSteps(result, adapter.domain);
    const allStepsPassed = stepPostconditions.every((sp) => sp.passed);

    // Compute Overall Status and Failure Category
    let status: ValidationStatus = "PASS";
    let failureCategory: FailureCategory = "NONE";

    if (result.status === "BLOCKED" || !domainAuthorized) {
      status = "BLOCKED";
      failureCategory = "BLOCKED";
    } else if (result.status === "STUCK" || result.errors.some((e) => e.code === "BINDING_FAILED")) {
      status = "FAIL";
      failureCategory = "BINDING_FAILED";
    } else if (!schemaValid) {
      status = "FAIL";
      failureCategory = "SCHEMA_ERROR";
    } else if (!productIdentityMatch) {
      status = "NEEDS_REVIEW";
      failureCategory = "MISMATCH";
    } else if (!priceParsedINR || !freshnessValid || !allStepsPassed) {
      status = "FAIL";
      failureCategory = !allStepsPassed ? "BINDING_FAILED" : "SCHEMA_ERROR";
    }

    // CRITICAL GUARDRAIL: Critique model CANNOT override deterministic checks
    // If critique model exists, it can only enrich logs/diagnostics, never turn a FAIL into a PASS.
    if (critiqueModelDiagnostic && status !== "PASS") {
      logger.info("Critique model provided failure diagnostic (deterministic authority preserved)", {
        diagnostic: critiqueModelDiagnostic.summary,
        recommendedAction: critiqueModelDiagnostic.recommendedAction,
      });
    }

    const validationResult: ValidationResult = {
      validationId: randomUUID(),
      status,
      failureCategory,
      checks: {
        schemaValid,
        productIdentityMatch,
        priceParsedINR,
        domainAuthorized,
        freshnessValid,
        stepPostconditions,
      },
      verifiedOutput: status === "PASS" ? output : undefined,
      validatedAt: new Date().toISOString(),
    };

    const parsed = ValidationResultSchema.parse(validationResult);

    // Persist event and validation status
    if (this.repo) {
      this.repo.logEvent({
        eventId: randomUUID(),
        jobId: task.jobId,
        runId: task.taskId,
        agentRole: "VALIDATOR",
        state: status === "PASS" ? "DONE" : status,
        site: adapter.domain,
        timestamp: new Date().toISOString(),
        payloadSummary: {
          validationId: parsed.validationId,
          status: parsed.status,
          failureCategory: parsed.failureCategory,
          identityScore: identityResult.score,
          identityReason: identityResult.reason,
          critique: critiqueModelDiagnostic?.summary,
        },
        redactedError: status !== "PASS" ? `${failureCategory}: ${identityResult.reason || result.errors[0]?.message}` : undefined,
      });
    }

    return parsed;
  }

  /**
   * Candidate Promotion Gate:
   * Enforces the hard rule that candidate site adapters MUST pass deterministic validation
   * on at least TWO distinct queries before they can be promoted to ACTIVE.
   */
  validateCandidateForPromotion(
    adapter: SiteAdapter,
    validationResults: Array<{ query: string; result: ValidationResult }>
  ): { eligible: boolean; reason: string } {
    if (adapter.status === "ACTIVE") {
      return { eligible: true, reason: "SiteAdapter is already ACTIVE" };
    }

    const uniqueQueries = new Set(
      validationResults.map((v) => v.query.trim().toLowerCase())
    );

    if (uniqueQueries.size < 2) {
      return {
        eligible: false,
        reason: `Promotion gate failed: Requires at least 2 distinct queries, but only ${uniqueQueries.size} provided (${Array.from(uniqueQueries).join(", ") || "none"})`,
      };
    }

    const failedChecks = validationResults.filter((v) => v.result.status !== "PASS");
    if (failedChecks.length > 0) {
      const failDetails = failedChecks
        .map((f) => `'${f.query}' -> ${f.result.status} (${f.result.failureCategory})`)
        .join("; ");
      return {
        eligible: false,
        reason: `Promotion gate failed: ${failedChecks.length} query validations failed: ${failDetails}`,
      };
    }

    return {
      eligible: true,
      reason: `Promotion gate passed: Verified across ${uniqueQueries.size} distinct queries (${Array.from(uniqueQueries).join(", ")})`,
    };
  }

  private checkDomainAuthorization(domain: string, result: AgentResult): boolean {
    const env = getEnv();
    const isTestMode = env.NODE_ENV === "test" || process.env.VITEST === "true";

    if (isTestMode && (domain === "localhost" || domain === "127.0.0.1")) {
      return true;
    }

    const allowed = env.ALLOWED_TARGET_DOMAINS.split(",").map((d) => d.trim().toLowerCase());
    const isDomainAllowed = allowed.some(
      (d) => domain.toLowerCase() === d || domain.toLowerCase().endsWith(`.${d}`) || d.includes(domain.toLowerCase())
    );

    if (!isDomainAllowed) {
      return false;
    }

    // SSRF Check on evidenceReferences
    for (const ref of result.evidenceReferences) {
      try {
        const url = new URL(ref);
        if (url.protocol !== "https:" && !(isTestMode && url.protocol === "http:")) {
          return false;
        }
        // Block private IP ranges
        const hostname = url.hostname;
        if (
          !isTestMode &&
          (hostname === "localhost" ||
            hostname.startsWith("127.") ||
            hostname.startsWith("10.") ||
            hostname.startsWith("192.168.") ||
            hostname.startsWith("169.254."))
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }

    return true;
  }

  private checkSchemaValid(result: AgentResult): boolean {
    if (!result.structuredOutput) {
      return false;
    }

    const out = result.structuredOutput as Record<string, unknown>;

    // Must have non-empty title
    if (typeof out.title !== "string" || !out.title.trim()) {
      return false;
    }

    // Must have valid price
    const hasNumeric = typeof out.numericPrice === "number" && !isNaN(out.numericPrice) && out.numericPrice > 0;
    const hasRawPrice = typeof out.price === "string" && out.price.trim().length > 0;
    if (!hasNumeric && !hasRawPrice) {
      return false;
    }

    // Must have currency
    if (typeof out.currency !== "string" || !out.currency.trim()) {
      return false;
    }

    // Must have productUrl
    if (typeof out.productUrl !== "string" || !out.productUrl.trim()) {
      return false;
    }
    try {
      new URL(out.productUrl);
    } catch {
      return false;
    }

    return true;
  }

  private checkPriceValid(output: Record<string, unknown>): boolean {
    let numeric = 0;
    if (typeof output.numericPrice === "number") {
      numeric = output.numericPrice;
    } else if (typeof output.price === "string") {
      const match = output.price.replace(/,/g, "").match(/\d+(\.\d+)?/);
      if (match) {
        numeric = parseFloat(match[0]);
      }
    }

    if (isNaN(numeric) || numeric <= 0 || numeric > 100_000_000) {
      return false;
    }

    const currency = typeof output.currency === "string" ? output.currency.trim().toUpperCase() : "";
    const knownCurrencies = ["INR", "₹", "RS", "RS.", "GBP", "£", "USD", "$", "EUR", "€"];
    const isKnownCurrency = knownCurrencies.some(
      (c) => currency === c || currency.includes(c)
    );

    return isKnownCurrency;
  }

  private checkFreshness(output: Record<string, unknown>): boolean {
    const rawTime = output.retrievalTime || output.timestamp;
    if (typeof rawTime !== "string") {
      return false;
    }

    const parsed = Date.parse(rawTime);
    if (isNaN(parsed)) {
      return false;
    }

    const now = Date.now();
    // Allow up to 2 minutes into future for clock drift
    if (parsed > now + 120_000) {
      return false;
    }

    // Should not be older than 24 hours
    if (now - parsed > 24 * 60 * 60 * 1000) {
      return false;
    }

    return true;
  }
}
