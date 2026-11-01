import type { Locator, Page } from "playwright";
import type { StepBinding } from "../types/domain.js";
import { logger } from "../utils/logger.js";

export interface LocatorResolutionResult {
  locator: Locator | null;
  strategyUsed: string;
  matchedCount: number;
  error?: string;
}

export class DomAnchors {
  /**
   * Resolves a Playwright Locator using resilient semantic anchors first,
   * falling back to scoped CSS/XPath locators from the verified binding.
   */
  static async resolve(
    page: Page,
    binding: StepBinding,
    timeoutMs: number = 8000
  ): Promise<LocatorResolutionResult> {
    const anchors = binding.anchorEvidence || {};

    // 1. Semantic Placeholder resolution
    if (anchors.placeholder) {
      try {
        const loc = page.getByPlaceholder(anchors.placeholder);
        const count = await loc.count();
        if (count > 0) {
          return this.checkUniqueness(loc, count, binding, "semantic_placeholder");
        }
      } catch {
        // Fallback to next strategy
      }
    }

    // 2. Accessible Label resolution
    if (anchors.label) {
      try {
        const loc = page.getByLabel(anchors.label);
        const count = await loc.count();
        if (count > 0) {
          return this.checkUniqueness(loc, count, binding, "accessible_label");
        }
      } catch {
        // Fallback to next strategy
      }
    }

    // 3. Test ID resolution
    if (anchors.testid) {
      try {
        const loc = page.getByTestId(anchors.testid);
        const count = await loc.count();
        if (count > 0) {
          return this.checkUniqueness(loc, count, binding, "test_id");
        }
      } catch {
        // Fallback to next strategy
      }
    }

    // 4. Exact visible text resolution (for titles or buttons)
    if (anchors.text) {
      try {
        const loc = page.getByText(anchors.text, { exact: false });
        const count = await loc.count();
        if (count > 0) {
          return this.checkUniqueness(loc, count, binding, "visible_text");
        }
      } catch {
        // Fallback to next strategy
      }
    }

    // 5. Verified CSS/XPath locator fallback
    try {
      const loc = page.locator(binding.locatorValue);
      // Wait up to timeoutMs for at least one element to be attached
      await loc.first().waitFor({ state: "attached", timeout: timeoutMs });
      const count = await loc.count();
      return this.checkUniqueness(loc, count, binding, `scoped_${binding.locatorStrategy}`);
    } catch (err: unknown) {
      logger.debug("Locator resolution failed", {
        semanticRole: binding.semanticRole,
        locatorValue: binding.locatorValue,
      });
      return {
        locator: null,
        strategyUsed: "none",
        matchedCount: 0,
        error: `Element for role '${binding.semanticRole}' not found with selector '${binding.locatorValue}'`,
      };
    }
  }

  private static checkUniqueness(
    locator: Locator,
    count: number,
    binding: StepBinding,
    strategy: string
  ): LocatorResolutionResult {
    if (binding.uniquenessExpectation === "SINGLE" && count > 1) {
      return {
        locator: locator.first(),
        strategyUsed: strategy,
        matchedCount: count,
        error: `Ambiguous control: Expected single element for '${binding.semanticRole}' but found ${count} matching elements`,
      };
    }

    return {
      locator,
      strategyUsed: strategy,
      matchedCount: count,
    };
  }
}

