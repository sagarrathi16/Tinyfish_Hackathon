/**
 * Product Identity and Semantic Matching Evaluator
 * Deterministic authority for product identity verification.
 */

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "for",
  "with",
  "and",
  "or",
  "in",
  "on",
  "at",
  "to",
  "of",
  "by",
  "buy",
  "online",
  "original",
  "best",
  "cheap",
]);

const ACCESSORY_TERMS = new Set([
  "cable",
  "strap",
  "case",
  "cover",
  "adapter",
  "battery",
  "charger",
  "shield",
  "stand",
  "mount",
  "sleeve",
  "protector",
  "film",
  "replacement",
  "holder",
  "clip",
  "connector",
  "cord",
  "band",
  "dock",
]);

export interface IdentityMatchResult {
  match: boolean;
  score: number;
  isAccessory: boolean;
  matchedTokens: string[];
  missingTokens: string[];
  reason: string;
}

export class IdentityChecker {
  /**
   * Deterministically verifies that an extracted product title matches the user's search query.
   * Rejects accessory items when the user searched for the primary product.
   */
  static verify(query: string, productTitle: string): IdentityMatchResult {
    if (!query || !query.trim()) {
      return {
        match: false,
        score: 0,
        isAccessory: false,
        matchedTokens: [],
        missingTokens: [],
        reason: "Search query is empty",
      };
    }

    if (!productTitle || !productTitle.trim()) {
      return {
        match: false,
        score: 0,
        isAccessory: false,
        matchedTokens: [],
        missingTokens: [],
        reason: "Product title is empty",
      };
    }

    const queryTokens = this.tokenize(query);
    const titleTokens = new Set(this.tokenize(productTitle));

    if (queryTokens.length === 0) {
      return {
        match: false,
        score: 0,
        isAccessory: false,
        matchedTokens: [],
        missingTokens: [],
        reason: "Query contains no meaningful keywords",
      };
    }

    // Check if user query explicitly asked for an accessory
    const queryAsksForAccessory = queryTokens.some((t) => ACCESSORY_TERMS.has(t));

    // Check if the product title is an accessory
    const titleHasAccessory = Array.from(titleTokens).some((t) => ACCESSORY_TERMS.has(t));
    const isAccessoryMismatch = !queryAsksForAccessory && titleHasAccessory;

    // Calculate token overlap
    const matchedTokens: string[] = [];
    const missingTokens: string[] = [];

    for (const token of queryTokens) {
      if (titleTokens.has(token)) {
        matchedTokens.push(token);
      } else {
        // Also check substring or prefix match (e.g. "watch" in "smartwatch")
        const partialMatch = Array.from(titleTokens).some(
          (tt) => tt.includes(token) || token.includes(tt)
        );
        if (partialMatch) {
          matchedTokens.push(token);
        } else {
          missingTokens.push(token);
        }
      }
    }

    const coverage = matchedTokens.length / queryTokens.length;

    // Severe penalty if it's an accessory mismatch
    const finalScore = isAccessoryMismatch ? Math.min(coverage * 0.3, 0.25) : coverage;

    if (isAccessoryMismatch) {
      return {
        match: false,
        score: Number(finalScore.toFixed(3)),
        isAccessory: true,
        matchedTokens,
        missingTokens,
        reason: `Extracted product is an accessory/complementary item, but user requested primary item '${query}'`,
      };
    }

    if (coverage < 0.5) {
      return {
        match: false,
        score: Number(finalScore.toFixed(3)),
        isAccessory: false,
        matchedTokens,
        missingTokens,
        reason: `Low query keyword coverage (${(coverage * 100).toFixed(0)}%). Missing: ${missingTokens.join(", ")}`,
      };
    }

    return {
      match: true,
      score: Number(finalScore.toFixed(3)),
      isAccessory: false,
      matchedTokens,
      missingTokens,
      reason: `Product identity verified with ${(coverage * 100).toFixed(0)}% query coverage`,
    };
  }

  private static tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  }
}

