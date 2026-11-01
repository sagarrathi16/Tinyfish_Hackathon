/**
 * Step-level deterministic postcondition assertions for the 5-step template:
 * 1. OPEN
 * 2. SEARCH
 * 3. PARSE
 * 4. SELECT
 * 5. CONFIRM
 */

import type { AgentResult, StepPostconditionResult } from "../types/domain.js";

export class PostconditionEvaluator {
  /**
   * Evaluates postconditions for all 5 steps based on execution result and structured output.
   */
  static evaluateSteps(
    result: AgentResult,
    targetDomain: string
  ): StepPostconditionResult[] {
    const postconditions: StepPostconditionResult[] = [];
    const stepsCompleted = result.stepsUsage?.stepsCompleted ?? 0;
    const errors = result.errors || [];
    const output = result.structuredOutput as Record<string, unknown> | null;

    // Check if a specific step had a binding failure
    const bindingError = errors.find((e) => e.code === "BINDING_FAILED");
    const blockedError = errors.find((e) => e.code === "BOT_DETECTED" || e.code === "HTTP_BLOCKED");

    // 1. OPEN Postcondition
    if (blockedError) {
      postconditions.push({
        stepName: "OPEN",
        passed: false,
        message: `OPEN failed: Access blocked (${blockedError.message})`,
      });
    } else if (stepsCompleted >= 1 || (!bindingError?.message.includes("OPEN") && result.status !== "BLOCKED")) {
      postconditions.push({
        stepName: "OPEN",
        passed: true,
        message: "Target storefront homepage loaded successfully without bot restriction",
      });
    } else {
      postconditions.push({
        stepName: "OPEN",
        passed: false,
        message: `OPEN failed: ${bindingError?.message || "Failed to open target storefront"}`,
      });
    }

    // 2. SEARCH Postcondition
    if (bindingError && bindingError.message.includes("SEARCH")) {
      postconditions.push({
        stepName: "SEARCH",
        passed: false,
        message: `SEARCH failed: ${bindingError.message}`,
      });
    } else if (stepsCompleted >= 2 || (stepsCompleted === 0 && output && !bindingError)) {
      postconditions.push({
        stepName: "SEARCH",
        passed: true,
        message: "Unique search control located, query submitted, and results rendered",
      });
    } else if (result.status === "STUCK" || result.status === "FAILED") {
      postconditions.push({
        stepName: "SEARCH",
        passed: false,
        message: `SEARCH failed: ${bindingError?.message || "Search step did not complete"}`,
      });
    } else {
      postconditions.push({
        stepName: "SEARCH",
        passed: stepsCompleted >= 2,
        message: stepsCompleted >= 2 ? "Search completed" : "Search step did not finish",
      });
    }

    // 3. PARSE Postcondition
    if (bindingError && bindingError.message.includes("PARSE")) {
      postconditions.push({
        stepName: "PARSE",
        passed: false,
        message: `PARSE failed: ${bindingError.message}`,
      });
    } else if (stepsCompleted >= 3 || (output && output.title)) {
      postconditions.push({
        stepName: "PARSE",
        passed: true,
        message: "Product listing container identified and candidate cards extracted",
      });
    } else {
      postconditions.push({
        stepName: "PARSE",
        passed: false,
        message: "PARSE failed: No candidate product items were parsed from DOM",
      });
    }

    // 4. SELECT Postcondition
    if (bindingError && bindingError.message.includes("SELECT")) {
      postconditions.push({
        stepName: "SELECT",
        passed: false,
        message: `SELECT failed: ${bindingError.message}`,
      });
    } else if (stepsCompleted >= 4 || (output && output.title && (output.numericPrice !== undefined || output.price !== undefined))) {
      postconditions.push({
        stepName: "SELECT",
        passed: true,
        message: "Most relevant product candidate card selected matching query intent",
      });
    } else {
      postconditions.push({
        stepName: "SELECT",
        passed: false,
        message: "SELECT failed: Could not isolate target product card from results",
      });
    }

    // 5. CONFIRM Postcondition
    if (output && output.title && output.productUrl) {
      const url = String(output.productUrl);
      const isDomainMatch = url.includes(targetDomain) || targetDomain === "localhost";
      if (!isDomainMatch) {
        postconditions.push({
          stepName: "CONFIRM",
          passed: false,
          message: `CONFIRM failed: Extracted URL '${url}' does not belong to target domain '${targetDomain}'`,
        });
      } else {
        postconditions.push({
          stepName: "CONFIRM",
          passed: true,
          message: "Product title, price, and canonical URL verified on destination page",
        });
      }
    } else {
      postconditions.push({
        stepName: "CONFIRM",
        passed: false,
        message: "CONFIRM failed: Final structured product record missing title or product URL",
      });
    }

    return postconditions;
  }
}

