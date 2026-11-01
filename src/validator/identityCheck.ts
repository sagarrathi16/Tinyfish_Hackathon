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
  "stylus",
  "keychain",
  "pouch",
  "bag",
]);

export interface ConflictingSpec {
  category: "RAM_STORAGE" | "REVISION" | "MODEL_TIER";
  querySpec: string;
  foundSpec: string;
}

export interface IdentityMatchResult {
  match: boolean;
  score: number;
  isAccessory: boolean;
  isWrongVariant: boolean;
  isAmbiguous: boolean;
  matchedTokens: string[];
  missingTokens: string[];
  conflictingSpecs: ConflictingSpec[];
  reason: string;
}

export class IdentityChecker {
  /**
   * Deterministically verifies that an extracted product title matches the user's search query.
   * - Enforces model/spec tokens (e.g. 8GB vs 4GB, R3 vs R2, Pro vs Lite).
   * - Rejects accessory items when the user searched for the primary product.
   * - Flags ambiguous partial matches for human/agent review.
   */
  static verify(query: string, productTitle: string): IdentityMatchResult {
    if (!query || !query.trim()) {
      return {
        match: false,
        score: 0,
        isAccessory: false,
        isWrongVariant: false,
        isAmbiguous: false,
        matchedTokens: [],
        missingTokens: [],
        conflictingSpecs: [],
        reason: "Search query is empty",
      };
    }

    if (!productTitle || !productTitle.trim()) {
      return {
        match: false,
        score: 0,
        isAccessory: false,
        isWrongVariant: false,
        isAmbiguous: false,
        matchedTokens: [],
        missingTokens: [],
        conflictingSpecs: [],
        reason: "Product title is empty",
      };
    }

    const queryTokens = this.tokenize(query);
    const titleTokensList = this.tokenize(productTitle);
    const titleTokens = new Set(titleTokensList);

    if (queryTokens.length === 0) {
      return {
        match: false,
        score: 0,
        isAccessory: false,
        isWrongVariant: false,
        isAmbiguous: false,
        matchedTokens: [],
        missingTokens: [],
        conflictingSpecs: [],
        reason: "Query contains no meaningful keywords",
      };
    }

    // 1. Accessory Mismatch Check
    const queryAsksForAccessory = queryTokens.some((t) => ACCESSORY_TERMS.has(t));
    const titleHasAccessory = titleTokensList.some((t) => ACCESSORY_TERMS.has(t));
    const isAccessoryMismatch = !queryAsksForAccessory && titleHasAccessory;

    // 2. Spec / Model Token Conflict Check (RAM/Storage, Revisions, Tiers)
    const conflictingSpecs = this.detectSpecConflicts(query, productTitle);
    const isWrongVariant = conflictingSpecs.length > 0;

    // 3. Token Overlap Calculation
    const matchedTokens: string[] = [];
    const missingTokens: string[] = [];

    for (const token of queryTokens) {
      if (titleTokens.has(token)) {
        matchedTokens.push(token);
      } else {
        // Substring / prefix check (e.g. "watch" in "smartwatch")
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

    // Severe penalty if accessory mismatch
    if (isAccessoryMismatch) {
      const finalScore = Number(Math.min(coverage * 0.25, 0.25).toFixed(3));
      return {
        match: false,
        score: finalScore,
        isAccessory: true,
        isWrongVariant: false,
        isAmbiguous: true,
        matchedTokens,
        missingTokens,
        conflictingSpecs: [],
        reason: `Extracted product is an accessory/complementary item, but user requested primary item '${query}'`,
      };
    }

    // Wrong Variant (e.g. 4GB instead of 8GB, or V1 instead of V3)
    if (isWrongVariant) {
      const conflictsSummary = conflictingSpecs
        .map((c) => `expected '${c.querySpec}', found '${c.foundSpec}'`)
        .join("; ");
      const finalScore = Number((coverage * 0.45).toFixed(3));
      return {
        match: false,
        score: finalScore,
        isAccessory: false,
        isWrongVariant: true,
        isAmbiguous: true,
        matchedTokens,
        missingTokens,
        conflictingSpecs,
        reason: `Product variant mismatch: ${conflictsSummary}`,
      };
    }

    // Low coverage: Unrelated product
    if (coverage < 0.35) {
      return {
        match: false,
        score: Number(coverage.toFixed(3)),
        isAccessory: false,
        isWrongVariant: false,
        isAmbiguous: false,
        matchedTokens,
        missingTokens,
        conflictingSpecs: [],
        reason: `Low query keyword coverage (${(coverage * 100).toFixed(0)}%). Missing: ${missingTokens.join(", ")}`,
      };
    }

    // Partial/Ambiguous coverage (between 35% and 65%)
    if (coverage < 0.65) {
      return {
        match: false,
        score: Number(coverage.toFixed(3)),
        isAccessory: false,
        isWrongVariant: false,
        isAmbiguous: true,
        matchedTokens,
        missingTokens,
        conflictingSpecs: [],
        reason: `Ambiguous match with ${(coverage * 100).toFixed(0)}% coverage. Missing: ${missingTokens.join(", ")}`,
      };
    }

    // Valid Match
    return {
      match: true,
      score: Number(coverage.toFixed(3)),
      isAccessory: false,
      isWrongVariant: false,
      isAmbiguous: false,
      matchedTokens,
      missingTokens,
      conflictingSpecs: [],
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

  /**
   * Detects explicit spec conflicts between query and product title.
   * e.g. Query specifies "8GB", title specifies "4GB" (RAM/Storage conflict)
   */
  private static detectSpecConflicts(query: string, title: string): ConflictingSpec[] {
    const conflicts: ConflictingSpec[] = [];

    // RAM/Storage spec patterns: e.g. 2gb, 4gb, 8gb, 16gb, 32gb, 64gb, 128gb, 256gb
    const ramPattern = /\b(\d+)\s*(?:gb|mb|tb)\b/gi;
    const queryRamMatches = Array.from(query.matchAll(ramPattern)).map((m) =>
      m[0].toLowerCase().replace(/\s+/g, "")
    );
    const titleRamMatches = Array.from(title.matchAll(ramPattern)).map((m) =>
      m[0].toLowerCase().replace(/\s+/g, "")
    );

    if (queryRamMatches.length > 0 && titleRamMatches.length > 0) {
      for (const qRam of queryRamMatches) {
        if (!titleRamMatches.includes(qRam)) {
          conflicts.push({
            category: "RAM_STORAGE",
            querySpec: qRam,
            foundSpec: titleRamMatches.join(", "),
          });
        }
      }
    }

    // Revision / Version patterns: e.g. r2, r3, rev3, v1, v2, v3
    const revPattern = /\b(r[1-5]|rev\s*[1-5]|v\d+(?:\.\d+)?)\b/gi;
    const queryRevMatches = Array.from(query.matchAll(revPattern)).map((m) =>
      m[0].toLowerCase().replace(/\s+/g, "")
    );
    const titleRevMatches = Array.from(title.matchAll(revPattern)).map((m) =>
      m[0].toLowerCase().replace(/\s+/g, "")
    );

    if (queryRevMatches.length > 0 && titleRevMatches.length > 0) {
      for (const qRev of queryRevMatches) {
        // Normalize "rev3" and "r3"
        const normQ = qRev.replace("rev", "r");
        const hasMatch = titleRevMatches.some((tRev) => tRev.replace("rev", "r") === normQ);
        if (!hasMatch) {
          conflicts.push({
            category: "REVISION",
            querySpec: qRev,
            foundSpec: titleRevMatches.join(", "),
          });
        }
      }
    }

    return conflicts;
  }
}
