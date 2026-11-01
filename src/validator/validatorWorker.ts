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
  type IndividualCheckResult,
} from "../types/domain.js";
import { IdentityChecker, type IdentityMatchResult } from "./identityCheck.js";
import { PostconditionEvaluator } from "./postconditions.js";
import { logger } from "../utils/logger.js";

export interface CritiqueDiagnostic {
  summary: string;
  recommendedAction?: string;
}

export interface ValidateOptions {
  critiqueModelDiagnostic?: CritiqueDiagnostic;
  teachRunTimestamp?: string;
  groundTruth?: GroundTruthRecord;
  requireStepEvidence?: boolean;
}

export interface GroundTruthRecord {
  expectedProduct?: string;
  expectedVariant?: string;
  isAccessory?: boolean;
  minPrice?: number;
  maxPrice?: number;
  expectedCurrency?: string;
  allowedDomain?: string;
  isAdversarial?: boolean; // When true, the fixture is an invalid adversarial case that must never be marked PASS
  expectedStatus?: ValidationStatus;
}

/**
 * Computes whether a validation result is "silent-wrong".
 * A result is silent-wrong if it was marked PASS by the validator but is incorrect
 * or invalid against fixture ground truth.
 */
export function evaluateSilentWrong(
  validationResult: ValidationResult,
  groundTruth: GroundTruthRecord
): {
  isSilentWrong: boolean;
  reason?: string;
} {
  // If the validator rejected or flagged the result, it is not silent-wrong
  if (validationResult.status !== "PASS") {
    return { isSilentWrong: false };
  }

  // If status is PASS but the fixture is adversarial / expected to fail
  if (groundTruth.isAdversarial) {
    return {
      isSilentWrong: true,
      reason: "Adversarial fixture was mistakenly marked PASS by validator.",
    };
  }

  if (groundTruth.expectedStatus && groundTruth.expectedStatus !== "PASS") {
    return {
      isSilentWrong: true,
      reason: `Fixture expected status '${groundTruth.expectedStatus}', but was marked PASS.`,
    };
  }

  const output = (validationResult.verifiedOutput || {}) as Record<string, unknown>;

  // Check product title against expected product
  if (groundTruth.expectedProduct && typeof output.title === "string") {
    const titleLower = output.title.toLowerCase();
    const expLower = groundTruth.expectedProduct.toLowerCase();
    if (!titleLower.includes(expLower)) {
      return {
        isSilentWrong: true,
        reason: `Product title '${output.title}' does not match expected ground truth product '${groundTruth.expectedProduct}'.`,
      };
    }
  }

  // Check variant
  if (groundTruth.expectedVariant && typeof output.title === "string") {
    const titleLower = output.title.toLowerCase();
    const varLower = groundTruth.expectedVariant.toLowerCase();
    if (!titleLower.includes(varLower)) {
      return {
        isSilentWrong: true,
        reason: `Product title '${output.title}' lacks expected variant '${groundTruth.expectedVariant}'.`,
      };
    }
  }

  // Check price bounds
  if (groundTruth.minPrice !== undefined && typeof output.numericPrice === "number") {
    if (output.numericPrice < groundTruth.minPrice) {
      return {
        isSilentWrong: true,
        reason: `Numeric price ${output.numericPrice} is below ground truth minimum ${groundTruth.minPrice}.`,
      };
    }
  }

  if (groundTruth.maxPrice !== undefined && typeof output.numericPrice === "number") {
    if (output.numericPrice > groundTruth.maxPrice) {
      return {
        isSilentWrong: true,
        reason: `Numeric price ${output.numericPrice} exceeds ground truth maximum ${groundTruth.maxPrice}.`,
      };
    }
  }

  return { isSilentWrong: false };
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
    critiqueOrOptions?: CritiqueDiagnostic | ValidateOptions
  ): ValidationResult {
    // Normalize options
    let critiqueModelDiagnostic: CritiqueDiagnostic | undefined;
    let teachRunTimestamp: string | undefined;

    if (critiqueOrOptions) {
      if ("summary" in critiqueOrOptions && typeof critiqueOrOptions.summary === "string") {
        critiqueModelDiagnostic = critiqueOrOptions as CritiqueDiagnostic;
      } else {
        const opts = critiqueOrOptions as ValidateOptions;
        critiqueModelDiagnostic = opts.critiqueModelDiagnostic;
        teachRunTimestamp = opts.teachRunTimestamp;
      }
    }

    if (!teachRunTimestamp && task.inputPayload?.teachRunTimestamp) {
      teachRunTimestamp = String(task.inputPayload.teachRunTimestamp);
    }

    const query = (task.inputPayload?.query as string) || task.goal;
    const output = (result.structuredOutput || {}) as Record<string, unknown>;

    logger.info("Validator Worker evaluating execution outcome", {
      taskId: task.taskId,
      domain: adapter.domain,
      query,
      resultStatus: result.status,
    });

    const detailedChecks: IndividualCheckResult[] = [];

    // ------------------------------------------------------------------------
    // 1. Prompt Injection & Adversarial Content Detection
    // ------------------------------------------------------------------------
    const injectionCheck = this.checkPromptInjection(output);
    detailedChecks.push({
      checkName: "PROVENANCE_AND_INJECTION_DEFENSE",
      passed: !injectionCheck.detected,
      severity: "CRITICAL",
      observedEvidence: injectionCheck.observedEvidence,
      expected: "Extracted fields must be free of prompt injection instructions",
      diagnostic: injectionCheck.diagnostic,
    });

    // ------------------------------------------------------------------------
    // 2. Source URL & Domain Authorization Check
    // ------------------------------------------------------------------------
    const domainCheck = this.checkDomainAuthorization(adapter.domain, result, output);
    detailedChecks.push({
      checkName: "SOURCE_URL_VALIDATION",
      passed: domainCheck.authorized && domainCheck.urlSafe,
      severity: "CRITICAL",
      observedEvidence: domainCheck.observedEvidence,
      expected: `Secure HTTPS navigation within authorized target domain '${adapter.domain}'`,
      diagnostic: domainCheck.diagnostic,
    });

    // ------------------------------------------------------------------------
    // 3. Schema & Required Fields Check
    // ------------------------------------------------------------------------
    const schemaCheck = this.checkSchemaValid(result);
    detailedChecks.push({
      checkName: "SCHEMA_VALIDATION",
      passed: schemaCheck.valid,
      severity: "CRITICAL",
      observedEvidence: schemaCheck.observedEvidence,
      expected: "Mandatory fields: title, numericPrice/price, currency, productUrl, retrievedAt",
      diagnostic: schemaCheck.diagnostic,
    });

    // ------------------------------------------------------------------------
    // 4. Product Identity & Spec Token Matching Check
    // ------------------------------------------------------------------------
    const title = typeof output.title === "string" ? output.title : "";
    const identityResult = IdentityChecker.verify(query, title);
    const identityPassed = identityResult.match;

    detailedChecks.push({
      checkName: "PRODUCT_IDENTITY",
      passed: identityPassed,
      severity: "HIGH",
      observedEvidence: `Extracted title: '${title || "none"}' (coverage: ${(identityResult.score * 100).toFixed(0)}%)`,
      expected: `Product matching query '${query}' without accessory or spec conflict`,
      diagnostic: identityResult.reason,
    });

    // ------------------------------------------------------------------------
    // 5. Price Verification & Semantic Price Type Check
    // ------------------------------------------------------------------------
    const priceCheck = this.checkPriceValid(output);
    detailedChecks.push({
      checkName: "PRICE_VALIDATION",
      passed: priceCheck.valid,
      severity: "HIGH",
      observedEvidence: priceCheck.observedEvidence,
      expected: "Positive purchase price in valid currency; not an EMI installment or original MRP",
      diagnostic: priceCheck.diagnostic,
    });

    // ------------------------------------------------------------------------
    // 6. Freshness & Stale Data Check
    // ------------------------------------------------------------------------
    const freshnessCheck = this.checkFreshness(output, teachRunTimestamp);
    detailedChecks.push({
      checkName: "FRESHNESS_VERIFICATION",
      passed: freshnessCheck.valid,
      severity: "HIGH",
      observedEvidence: freshnessCheck.observedEvidence,
      expected: "Live ISO timestamp recorded at execution; strictly distinct from teach run",
      diagnostic: freshnessCheck.diagnostic,
    });

    // ------------------------------------------------------------------------
    // 7. Step Postconditions & Provenance Check
    // ------------------------------------------------------------------------
    const stepPostconditions = PostconditionEvaluator.evaluateSteps(result, adapter.domain);
    const allStepsPassed = stepPostconditions.every((sp) => sp.passed);
    const hasEvidence = (result.evidenceReferences && result.evidenceReferences.length > 0) || !!output.productUrl;

    detailedChecks.push({
      checkName: "STEP_POSTCONDITIONS",
      passed: allStepsPassed && hasEvidence,
      severity: "HIGH",
      observedEvidence: `Steps completed: ${stepPostconditions.filter((s) => s.passed).length}/5; Evidence URLs: ${result.evidenceReferences?.length ?? 0}`,
      expected: "All 5 steps verified with explicit DOM/navigation evidence",
      diagnostic: !allStepsPassed
        ? stepPostconditions.filter((s) => !s.passed).map((s) => s.message).join("; ")
        : (!hasEvidence ? "Missing execution evidence references" : undefined),
    });

    // ------------------------------------------------------------------------
    // Resolve Overall Status & Failure Category with Strict Precedence
    // ------------------------------------------------------------------------
    let status: ValidationStatus = "PASS";
    let failureCategory: FailureCategory = "NONE";

    if (injectionCheck.detected) {
      status = "FAIL";
      failureCategory = "PROMPT_INJECTION";
    } else if (result.status === "BLOCKED" || !domainCheck.authorized) {
      status = "BLOCKED";
      failureCategory = "BLOCKED";
    } else if (!domainCheck.urlSafe) {
      status = "FAIL";
      failureCategory = "UNSAFE_URL";
    } else if (result.status === "STUCK" || result.errors.some((e) => e.code === "BINDING_FAILED")) {
      status = "FAIL";
      failureCategory = "BINDING_FAILED";
    } else if (!schemaCheck.valid) {
      status = "FAIL";
      failureCategory = "SCHEMA_ERROR";
    } else if (!freshnessCheck.valid) {
      status = "FAIL";
      failureCategory = freshnessCheck.isStaleData ? "STALE_DATA" : "SCHEMA_ERROR";
    } else if (!priceCheck.valid) {
      status = "FAIL";
      failureCategory = "PRICE_ERROR";
    } else if (!allStepsPassed || !hasEvidence) {
      status = "FAIL";
      failureCategory = "BINDING_FAILED";
    } else if (!identityPassed) {
      if (identityResult.isAccessory || identityResult.isWrongVariant || identityResult.isAmbiguous) {
        status = "NEEDS_REVIEW";
        failureCategory = "MISMATCH";
      } else {
        // Complete mismatch (low coverage)
        status = "FAIL";
        failureCategory = "MISMATCH";
      }
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
        schemaValid: schemaCheck.valid,
        productIdentityMatch: identityPassed,
        priceParsedINR: priceCheck.valid,
        domainAuthorized: domainCheck.authorized && domainCheck.urlSafe,
        freshnessValid: freshnessCheck.valid,
        stepPostconditions,
      },
      detailedChecks,
      // ONLY PASS can be accepted as a verified result
      verifiedOutput: status === "PASS" ? output : undefined,
      validatedAt: new Date().toISOString(),
      modelCritiqueSupplements: critiqueModelDiagnostic?.summary,
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
        redactedError: status !== "PASS" ? `${failureCategory}: ${identityResult.reason || result.errors[0]?.message || detailedChecks.find((c) => !c.passed)?.diagnostic}` : undefined,
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

  private checkPromptInjection(output: Record<string, unknown>): {
    detected: boolean;
    observedEvidence: string;
    diagnostic?: string;
  } {
    const injectionPatterns = [
      /\bignore\s+(?:all\s+)?previous\s+instructions\b/i,
      /\bsystem\s+override\b/i,
      /\bmark\s+(?:status\s+)?pass\b/i,
      /\breturn\s+(?:status\s+)?pass\b/i,
      /\bvalidation:\s*passed\b/i,
      /\byou\s+are\s+now\s+in\s+(?:admin|debug|bypass)\s+mode\b/i,
      /\bassistant\s+instruction\b/i,
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    ];

    const stringFields = Object.values(output).filter(
      (v): v is string => typeof v === "string"
    );

    for (const text of stringFields) {
      for (const pattern of injectionPatterns) {
        if (pattern.test(text)) {
          const match = text.match(pattern)?.[0] || "injection pattern";
          return {
            detected: true,
            observedEvidence: `Untrusted text snippet: '${text.slice(0, 80)}...'`,
            diagnostic: `Prompt injection attack detected: '${match}'`,
          };
        }
      }
    }

    return {
      detected: false,
      observedEvidence: "Extracted output fields sanitized; zero injection indicators discovered",
    };
  }

  private checkDomainAuthorization(
    adapterDomain: string,
    result: AgentResult,
    output: Record<string, unknown>
  ): {
    authorized: boolean;
    urlSafe: boolean;
    observedEvidence: string;
    diagnostic?: string;
  } {
    const env = getEnv();
    const isDevOrTest = env.NODE_ENV !== "production" || process.env.VITEST === "true";

    // 1. Adapter domain check
    const allowed = env.ALLOWED_TARGET_DOMAINS.split(",").map((d) => d.trim().toLowerCase());
    const isAdapterAllowed =
      (isDevOrTest && (adapterDomain === "localhost" || adapterDomain === "127.0.0.1")) ||
      allowed.some((d) => adapterDomain.toLowerCase() === d || adapterDomain.toLowerCase().endsWith(`.${d}`) || d.includes(adapterDomain.toLowerCase()));

    if (!isAdapterAllowed) {
      return {
        authorized: false,
        urlSafe: true,
        observedEvidence: `Domain '${adapterDomain}' not in allowed allowlist`,
        diagnostic: `Target domain '${adapterDomain}' is unauthorized`,
      };
    }

    // 2. Product URL security check
    const productUrl = typeof output.productUrl === "string" ? output.productUrl.trim() : "";
    if (productUrl) {
      try {
        const parsed = new URL(productUrl);
        const protocol = parsed.protocol;
        if (protocol !== "https:" && !(isDevOrTest && protocol === "http:")) {
          return {
            authorized: true,
            urlSafe: false,
            observedEvidence: `Insecure URL protocol: '${protocol}'`,
            diagnostic: `Product URL scheme must be HTTPS (received '${protocol}')`,
          };
        }

        const hostname = parsed.hostname.toLowerCase();
        if (
          !isDevOrTest &&
          (hostname === "localhost" ||
            hostname.startsWith("127.") ||
            hostname.startsWith("10.") ||
            hostname.startsWith("192.168.") ||
            hostname.startsWith("169.254."))
        ) {
          return {
            authorized: false,
            urlSafe: false,
            observedEvidence: `SSRF target attempted: '${hostname}'`,
            diagnostic: `Private IP / localhost target disallowed in production`,
          };
        }

        // Hostname must match allowed domain or adapter domain
        const isHostAllowed =
          (isDevOrTest && (hostname === "localhost" || hostname === "127.0.0.1")) ||
          hostname === adapterDomain.toLowerCase() ||
          hostname.endsWith(`.${adapterDomain.toLowerCase()}`) ||
          allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`));

        if (!isHostAllowed) {
          return {
            authorized: false,
            urlSafe: true,
            observedEvidence: `Product URL points to foreign domain: '${hostname}'`,
            diagnostic: `URL destination '${hostname}' does not match allowed domain '${adapterDomain}'`,
          };
        }

        // Canonical product path check: must not be empty or root only
        if (parsed.pathname === "/" || !parsed.pathname) {
          return {
            authorized: true,
            urlSafe: false,
            observedEvidence: `Product URL path is root homepage ('/')`,
            diagnostic: "Product URL must point to a canonical listing/product path, not root homepage",
          };
        }
      } catch (err: unknown) {
        return {
          authorized: true,
          urlSafe: false,
          observedEvidence: `Malformed productUrl: '${productUrl}'`,
          diagnostic: `Failed to parse productUrl: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // 3. SSRF Check on evidenceReferences
    for (const ref of result.evidenceReferences || []) {
      try {
        const url = new URL(ref);
        if (url.protocol !== "https:" && !(isDevOrTest && url.protocol === "http:")) {
          return {
            authorized: true,
            urlSafe: false,
            observedEvidence: `Insecure reference protocol '${url.protocol}' in evidence`,
            diagnostic: "Evidence reference must use HTTPS",
          };
        }
        const hostname = url.hostname.toLowerCase();
        if (
          !isDevOrTest &&
          (hostname === "localhost" ||
            hostname.startsWith("127.") ||
            hostname.startsWith("10.") ||
            hostname.startsWith("192.168.") ||
            hostname.startsWith("169.254."))
        ) {
          return {
            authorized: false,
            urlSafe: false,
            observedEvidence: `SSRF target attempted in evidence: '${hostname}'`,
            diagnostic: "Private IP reference disallowed in evidence",
          };
        }
      } catch {
        return {
          authorized: true,
          urlSafe: false,
          observedEvidence: `Invalid evidence URL reference '${ref}'`,
          diagnostic: "Evidence references must be well-formed URLs",
        };
      }
    }

    return {
      authorized: true,
      urlSafe: true,
      observedEvidence: `Destination '${adapterDomain}' authorized and HTTPS-compliant`,
    };
  }

  private checkSchemaValid(result: AgentResult): {
    valid: boolean;
    observedEvidence: string;
    diagnostic?: string;
  } {
    if (!result.structuredOutput) {
      return {
        valid: false,
        observedEvidence: "Structured output object is null or undefined",
        diagnostic: "Missing structuredOutput payload",
      };
    }

    const out = result.structuredOutput as Record<string, unknown>;
    const missing: string[] = [];

    // Title
    if (typeof out.title !== "string" || out.title.trim().length < 2) {
      missing.push("title");
    }

    // Price
    const hasNumeric = typeof out.numericPrice === "number" && !isNaN(out.numericPrice) && out.numericPrice > 0;
    const hasRawPrice = typeof out.price === "string" && out.price.trim().length > 0;
    if (!hasNumeric && !hasRawPrice) {
      missing.push("numericPrice/price");
    }

    // Currency
    if (typeof out.currency !== "string" || !out.currency.trim()) {
      missing.push("currency");
    }

    // ProductUrl
    if (typeof out.productUrl !== "string" || !out.productUrl.trim()) {
      missing.push("productUrl");
    }

    // RetrievedAt / RetrievalTime
    const timeVal = out.retrievalTime || out.retrievedAt || out.timestamp;
    if (typeof timeVal !== "string" || !timeVal.trim()) {
      missing.push("retrievalTime");
    }

    if (missing.length > 0) {
      return {
        valid: false,
        observedEvidence: `Missing required schema fields: ${missing.join(", ")}`,
        diagnostic: `Incomplete output record: missing ${missing.join(", ")}`,
      };
    }

    return {
      valid: true,
      observedEvidence: "All required schema fields (title, price, currency, productUrl, retrievalTime) present",
    };
  }

  private checkPriceValid(output: Record<string, unknown>): {
    valid: boolean;
    observedEvidence: string;
    diagnostic?: string;
  } {
    // 1. Semantic Price Type Check: Rejection of EMI / monthly installment pricing
    const rawPrice = typeof output.price === "string" ? output.price : "";
    const priceType = typeof output.priceType === "string" ? output.priceType.toUpperCase() : "";
    const isEmiFlag = output.isEmi === true;

    const emiRegex = /\b(emi|per\s*month|\/mo|\/month|monthly|installment)\b/i;
    if (isEmiFlag || priceType === "EMI" || emiRegex.test(rawPrice)) {
      return {
        valid: false,
        observedEvidence: `Raw price '${rawPrice}' indicated EMI/installment`,
        diagnostic: `Semantic price error: EMI/installment selected as purchase price (${rawPrice})`,
      };
    }

    // 2. Rejection of original strikethrough MRP when discount was available
    if (priceType === "ORIGINAL_MRP" || output.isStrikethrough === true) {
      return {
        valid: false,
        observedEvidence: `Price marked as original MRP/strikethrough (${rawPrice})`,
        diagnostic: "Selected original strikethrough MRP instead of effective selling price",
      };
    }

    // 3. Numeric Amount Parsing & Sanity Bounds
    let numeric = 0;
    if (typeof output.numericPrice === "number") {
      numeric = output.numericPrice;
    } else if (rawPrice) {
      const match = rawPrice.replace(/,/g, "").match(/\d+(\.\d+)?/);
      if (match) {
        numeric = parseFloat(match[0]);
      }
    }

    if (isNaN(numeric) || numeric <= 0 || numeric > 100_000_000) {
      return {
        valid: false,
        observedEvidence: `Parsed numeric price: ${numeric}`,
        diagnostic: `Price amount ${numeric} is invalid (must be 0 < amount <= 100,000,000)`,
      };
    }

    // 4. Currency Verification
    const currency = typeof output.currency === "string" ? output.currency.trim().toUpperCase() : "";
    const knownCurrencies = ["INR", "₹", "RS", "RS.", "GBP", "£", "USD", "$", "EUR", "€"];
    const isKnownCurrency = knownCurrencies.some(
      (c) => currency === c || currency.includes(c)
    );

    if (!isKnownCurrency) {
      return {
        valid: false,
        observedEvidence: `Unknown currency: '${output.currency}'`,
        diagnostic: `Currency '${output.currency}' not recognized`,
      };
    }

    // 5. Card-to-Canonical Price Consistency (where both are provided)
    const cardPrice = typeof output.listingPrice === "number" ? output.listingPrice : (typeof output.cardPrice === "number" ? output.cardPrice : undefined);
    const canonicalPrice = typeof output.canonicalPrice === "number" ? output.canonicalPrice : (typeof output.productPagePrice === "number" ? output.productPagePrice : undefined);

    if (cardPrice !== undefined && canonicalPrice !== undefined && cardPrice > 0) {
      const priceDiffRatio = Math.abs(cardPrice - canonicalPrice) / cardPrice;
      if (priceDiffRatio > 0.05) {
        return {
          valid: false,
          observedEvidence: `Card price: ${cardPrice}, Canonical page price: ${canonicalPrice} (diff: ${(priceDiffRatio * 100).toFixed(1)}%)`,
          diagnostic: `Price inconsistency between listing card (${cardPrice}) and product canonical page (${canonicalPrice})`,
        };
      }
    }

    return {
      valid: true,
      observedEvidence: `Price parsed: ${currency}${numeric} (${priceType || "SELLING_PRICE"})`,
    };
  }

  private checkFreshness(
    output: Record<string, unknown>,
    teachRunTimestamp?: string
  ): {
    valid: boolean;
    isStaleData: boolean;
    observedEvidence: string;
    diagnostic?: string;
  } {
    const rawTime = output.retrievalTime || output.retrievedAt || output.timestamp;
    if (typeof rawTime !== "string") {
      return {
        valid: false,
        isStaleData: false,
        observedEvidence: "Missing timestamp in output",
        diagnostic: "Output missing retrieval timestamp",
      };
    }

    // Stale/reused teach run timestamp check
    if (teachRunTimestamp && (rawTime === teachRunTimestamp || output.isCached === true || output.source === "TEACH_CACHE")) {
      return {
        valid: false,
        isStaleData: true,
        observedEvidence: `Timestamp '${rawTime}' matches teach run timestamp '${teachRunTimestamp}'`,
        diagnostic: `Stale data detected: output reused timestamp from teach run. Current product facts must be re-fetched live at execution time.`,
      };
    }

    const parsed = Date.parse(rawTime);
    if (isNaN(parsed)) {
      return {
        valid: false,
        isStaleData: false,
        observedEvidence: `Malformed timestamp: '${rawTime}'`,
        diagnostic: "Timestamp is not a valid ISO-8601 date string",
      };
    }

    const now = Date.now();
    // Up to 2 minutes clock drift
    if (parsed > now + 120_000) {
      return {
        valid: false,
        isStaleData: false,
        observedEvidence: `Timestamp is in the future (${rawTime})`,
        diagnostic: "Timestamp is in the future",
      };
    }

    // Max 24 hours old
    if (now - parsed > 24 * 60 * 60 * 1000) {
      return {
        valid: false,
        isStaleData: true,
        observedEvidence: `Timestamp is older than 24 hours (${rawTime})`,
        diagnostic: "Data is stale (older than 24 hours)",
      };
    }

    return {
      valid: true,
      isStaleData: false,
      observedEvidence: `Execution timestamp: ${rawTime} (fresh)`,
    };
  }
}
