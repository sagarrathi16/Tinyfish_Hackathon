import { randomUUID } from "node:crypto";
import {
  type SiteAdapter,
  type StepBinding,
  type SemanticRole,
} from "../types/domain.js";
import {
  type TIPMatchResult,
  type TIPStatus,
  type ScoredFeature,
  type GroundedPrice,
  type TIPStructuralSketch,
} from "../types/transfer.js";
import { logger } from "../utils/logger.js";

export const DEFAULT_STRUCTURAL_SKETCH: TIPStructuralSketch = {
  searchBox: {
    expectedRoles: ["searchbox", "search", "combobox"],
    expectedTypes: ["search", "text"],
    nameKeywords: ["search", "find", "query", "keyword", "lookup", "explore"],
    containerContext: ["form", "header", "nav", "search"],
  },
  productCards: {
    minCardCount: 2,
    cardTagHints: ["article", "section", "li", "div"],
    excludeClasses: [
      "ad",
      "sponsored",
      "promo",
      "banner",
      "recent",
      "suggestion",
      "pill",
      "filter",
      "breadcrumb",
    ],
  },
  cardElements: {
    title: {
      tagHints: ["h1", "h2", "h3", "h4", "a", "strong", "span"],
      minTextLength: 4,
    },
    price: {
      currencySymbols: ["₹", "rs", "inr", "$", "€", "£"],
      excludePatterns: ["emi", "/mo", "month", "installment", "per month", "interest"],
    },
    link: {
      tag: "a",
      attr: "href",
    },
  },
};

export interface TIPMatchOptions {
  enableTip?: boolean;
  confidenceThreshold?: number;
  ambiguityMargin?: number;
  entryUrl?: string;
  searchUrlTemplate?: string;
}

interface RawInputCandidate {
  rawTag: string;
  type: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  role: string;
  className: string;
  testId: string;
  insideFormOrHeader: boolean;
  score: number;
  evidence: Record<string, string>;
  locator: string;
}

export class TIPMatcher {
  private sketch: TIPStructuralSketch;

  constructor(sketch: TIPStructuralSketch = DEFAULT_STRUCTURAL_SKETCH) {
    this.sketch = sketch;
  }

  /**
   * Matches a live page snapshot against the invariant structural sketch.
   * Scored features are fully transparent.
   * Enforces confidence thresholds and ambiguity rejection.
   * Zero hardcoded domain names or site-specific selectors.
   */
  matchPage(
    html: string,
    domain: string,
    options?: TIPMatchOptions
  ): TIPMatchResult {
    const enableTip = options?.enableTip ?? true;
    if (!enableTip) {
      logger.info("TIP matching is disabled by configuration; deferring to agent learning", { domain });
      return {
        matched: false,
        status: "DISABLED",
        confidence: 0,
        scoredFeatures: [],
        explanation: "TIP structural matching is disabled by feature flag. Deferring to TinyFish Explorer.",
      };
    }

    const confidenceThreshold = options?.confidenceThreshold ?? 0.7;
    const ambiguityMargin = options?.ambiguityMargin ?? 0.15;
    const scoredFeatures: ScoredFeature[] = [];

    // ========================================================================
    // 1. Search Box Structural Analysis
    // ========================================================================
    const inputCandidates = this.extractInputCandidates(html);

    if (inputCandidates.length === 0) {
      return {
        matched: false,
        status: "LOW_CONFIDENCE_FALLBACK",
        confidence: 0,
        scoredFeatures: [
          {
            featureName: "SEARCH_INPUT_DISCOVERY",
            weight: 0.5,
            rawScore: 0,
            weightedScore: 0,
            evidence: "No candidate interactive search inputs found on page snapshot",
          },
        ],
        explanation: "Failed to discover any candidate search input controls.",
        rejectionReason: "LOW_CONFIDENCE",
      };
    }

    // Sort descending by score
    inputCandidates.sort((a, b) => b.score - a.score);
    const topInput = inputCandidates[0];

    // Ambiguity Check: Multiple inputs with near-identical high scores
    if (
      inputCandidates.length > 1 &&
      topInput.score >= 0.7 &&
      topInput.score - inputCandidates[1].score < ambiguityMargin
    ) {
      const secondInput = inputCandidates[1];
      logger.warn("TIP ambiguity rejection: competing search inputs with similar scores", {
        domain,
        topScore: topInput.score,
        secondScore: secondInput.score,
      });

      scoredFeatures.push({
        featureName: "SEARCH_INPUT_AMBIGUITY_CHECK",
        weight: 0.5,
        rawScore: 0,
        weightedScore: 0,
        evidence: `Detected competing search inputs: [${topInput.locator}] (score ${topInput.score.toFixed(
          2
        )}) and [${secondInput.locator}] (score ${secondInput.score.toFixed(2)}) within margin ${ambiguityMargin}`,
      });

      return {
        matched: false,
        status: "AMBIGUOUS_REJECTED",
        confidence: Number(((topInput.score + secondInput.score) / 4).toFixed(2)),
        scoredFeatures,
        explanation:
          "Search control ambiguity detected: multiple inputs match the structural sketch with near-identical scores. Rejecting to prevent wrong interaction.",
        rejectionReason: "AMBIGUOUS_SEARCH_CONTROLS",
      };
    }

    scoredFeatures.push({
      featureName: "SEARCH_ROLE_AND_TYPE",
      weight: 0.2,
      rawScore: topInput.score >= 0.7 ? 1.0 : 0.5,
      weightedScore: (topInput.score >= 0.7 ? 1.0 : 0.5) * 0.2,
      evidence: `Selected input with type="${topInput.type}", role="${topInput.role}", locator="${topInput.locator}"`,
    });

    scoredFeatures.push({
      featureName: "SEARCH_NAME_OR_PLACEHOLDER",
      weight: 0.15,
      rawScore: topInput.placeholder || topInput.ariaLabel || topInput.name ? 1.0 : 0.2,
      weightedScore: (topInput.placeholder || topInput.ariaLabel || topInput.name ? 1.0 : 0.2) * 0.15,
      evidence: `Placeholder="${topInput.placeholder}", ariaLabel="${topInput.ariaLabel}", name="${topInput.name}"`,
    });

    // ========================================================================
    // 2. Product Card & Repeating Structure Analysis
    // ========================================================================
    const cardAnalysis = this.extractCardStructures(html);

    scoredFeatures.push({
      featureName: "REPEATED_CARD_REGULARITY",
      weight: 0.25,
      rawScore: cardAnalysis.regularityScore,
      weightedScore: cardAnalysis.regularityScore * 0.25,
      evidence: `Found ${cardAnalysis.cardsFound} candidate cards using locator '${cardAnalysis.cardLocator}'. Uniformity=${(
        cardAnalysis.regularityScore * 100
      ).toFixed(0)}%`,
    });

    scoredFeatures.push({
      featureName: "TITLE_ANCHOR_GROUNDING",
      weight: 0.15,
      rawScore: cardAnalysis.titleFound ? 1.0 : 0.0,
      weightedScore: (cardAnalysis.titleFound ? 1.0 : 0.0) * 0.15,
      evidence: cardAnalysis.titleEvidence,
    });

    scoredFeatures.push({
      featureName: "PRICE_PATTERN_GROUNDING",
      weight: 0.15,
      rawScore: cardAnalysis.priceFound ? 1.0 : 0.0,
      weightedScore: (cardAnalysis.priceFound ? 1.0 : 0.0) * 0.15,
      evidence: cardAnalysis.priceEvidence,
    });

    // ========================================================================
    // 3. Semantic JSON-LD Grounding & Mismatch Detection
    // ========================================================================
    const groundedPrice = this.groundPriceWithJsonLd(html, cardAnalysis.sampleVisiblePrice);

    scoredFeatures.push({
      featureName: "SEMANTIC_JSONLD_ALIGNMENT",
      weight: 0.1,
      rawScore: groundedPrice.source === "JSON_LD" ? 1.0 : groundedPrice.source === "MISMATCH_FALLBACK" ? 0.8 : 0.5,
      weightedScore:
        (groundedPrice.source === "JSON_LD" ? 1.0 : groundedPrice.source === "MISMATCH_FALLBACK" ? 0.8 : 0.5) * 0.1,
      evidence:
        groundedPrice.discrepancyNote ??
        `Price grounded via ${groundedPrice.source}: sellingPrice=₹${groundedPrice.sellingPrice ?? "N/A"}`,
    });

    // ========================================================================
    // 4. Combined Confidence & Threshold Evaluation
    // ========================================================================
    const totalWeightedScore = scoredFeatures.reduce((acc, f) => acc + f.weightedScore, 0);
    const totalConfidence = Number(Math.min(1.0, Math.max(0.0, totalWeightedScore)).toFixed(2));

    if (totalConfidence < confidenceThreshold || cardAnalysis.cardsFound < this.sketch.productCards.minCardCount) {
      logger.warn("TIP matching below confidence threshold", {
        domain,
        totalConfidence,
        threshold: confidenceThreshold,
        cardsFound: cardAnalysis.cardsFound,
      });

      return {
        matched: false,
        status: "LOW_CONFIDENCE_FALLBACK",
        confidence: totalConfidence,
        scoredFeatures,
        explanation: `Structural confidence (${totalConfidence}) is below threshold (${confidenceThreshold}) or fewer than ${this.sketch.productCards.minCardCount} cards discovered.`,
        rejectionReason: "LOW_CONFIDENCE",
      };
    }

    // ========================================================================
    // 5. Emit Candidate SiteAdapter (STATUS: CANDIDATE)
    // ========================================================================
    const candidateAdapter: SiteAdapter = {
      domain,
      adapterVersion: "1.0.0",
      status: "CANDIDATE", // Strictly CANDIDATE; never ACTIVE until 2-query Playwright validation
      locatorBindings: {
        SEARCH_INPUT: {
          semanticRole: "SEARCH_INPUT",
          locatorStrategy: "css",
          locatorValue: topInput.locator,
          anchorEvidence: {
            role: topInput.role || undefined,
            placeholder: topInput.placeholder || undefined,
            name: topInput.name || undefined,
            testid: topInput.testId || undefined,
          },
          uniquenessExpectation: "SINGLE",
          provenance: "TIP_GROUNDED",
          domain,
          version: "1.0.0",
        },
        PRODUCT_CARD: {
          semanticRole: "PRODUCT_CARD",
          locatorStrategy: "css",
          locatorValue: cardAnalysis.cardLocator,
          anchorEvidence: {
            role: "article",
            nearbyStructure: `Repeated grid items count: ${cardAnalysis.cardsFound}`,
          },
          uniquenessExpectation: "MULTIPLE",
          provenance: "TIP_GROUNDED",
          domain,
          version: "1.0.0",
        },
        PRODUCT_TITLE: {
          semanticRole: "PRODUCT_TITLE",
          locatorStrategy: "css",
          locatorValue: cardAnalysis.titleLocator,
          anchorEvidence: {
            text: cardAnalysis.sampleTitle || undefined,
          },
          uniquenessExpectation: "SINGLE",
          provenance: "TIP_GROUNDED",
          domain,
          version: "1.0.0",
        },
        PRODUCT_PRICE: {
          semanticRole: "PRODUCT_PRICE",
          locatorStrategy: "css",
          locatorValue: cardAnalysis.priceLocator,
          anchorEvidence: {
            text: cardAnalysis.sampleVisiblePrice ? `₹${cardAnalysis.sampleVisiblePrice}` : undefined,
          },
          uniquenessExpectation: "SINGLE",
          provenance: "TIP_GROUNDED",
          domain,
          version: "1.0.0",
        },
      },
      urlPatterns: {
        entryUrl: options?.entryUrl || `https://${domain}`,
        searchUrlTemplate: options?.searchUrlTemplate,
      },
      evidence: {
        traceId: `tip-${randomUUID()}`,
      },
      source: "heuristic",
      validationQueries: [],
      validationResults: [],
      createdAt: new Date().toISOString(),
    };

    return {
      matched: true,
      status: "MATCHED",
      confidence: totalConfidence,
      candidateAdapter,
      scoredFeatures,
      explanation: `Successfully synthesized candidate adapter via TIP structural matching (Confidence: ${(
        totalConfidence * 100
      ).toFixed(0)}%). Grounded ${cardAnalysis.cardsFound} product cards.`,
      groundedPrice,
    };
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  private extractInputCandidates(html: string): RawInputCandidate[] {
    const inputRegex = /<input\b([^>]*)>/gi;
    const candidates: RawInputCandidate[] = [];
    let match: RegExpExecArray | null;

    while ((match = inputRegex.exec(html)) !== null) {
      const attrsStr = match[1];
      const type = (this.getAttr(attrsStr, "type") || "text").toLowerCase();

      // Exclude non-text interactive inputs
      if (["hidden", "submit", "button", "checkbox", "radio", "file", "image"].includes(type)) {
        continue;
      }

      const name = (this.getAttr(attrsStr, "name") || "").toLowerCase();
      const id = this.getAttr(attrsStr, "id") || "";
      const placeholder = this.getAttr(attrsStr, "placeholder") || "";
      const ariaLabel = this.getAttr(attrsStr, "aria-label") || "";
      const role = (this.getAttr(attrsStr, "role") || "").toLowerCase();
      const className = this.getAttr(attrsStr, "class") || "";
      const testId = this.getAttr(attrsStr, "data-testid") || "";

      // Check surrounding context: is it inside a form or header?
      const index = match.index;
      const precedingHtml = html.slice(Math.max(0, index - 500), index).toLowerCase();
      const insideFormOrHeader =
        precedingHtml.includes("<form") || precedingHtml.includes("<header") || precedingHtml.includes("<nav");

      // Score evaluation
      let roleScore = 0.2;
      if (role === "searchbox" || role === "search") roleScore = 1.0;
      else if (type === "search") roleScore = 0.95;
      else if (type === "text") roleScore = 0.7;

      let keywordScore = 0.1;
      const combinedText = `${name} ${id} ${placeholder} ${ariaLabel} ${className}`.toLowerCase();
      for (const kw of this.sketch.searchBox.nameKeywords) {
        if (placeholder.toLowerCase().includes(kw) || ariaLabel.toLowerCase().includes(kw)) {
          keywordScore = 1.0;
          break;
        } else if (name.includes(kw) || id.toLowerCase().includes(kw) || testId.toLowerCase().includes(kw)) {
          keywordScore = 0.85;
          break;
        } else if (className.toLowerCase().includes(kw)) {
          keywordScore = Math.max(keywordScore, 0.5);
        }
      }

      const contextScore = insideFormOrHeader ? 1.0 : 0.5;
      const totalScore = roleScore * 0.35 + keywordScore * 0.35 + contextScore * 0.3;

      // Select most resilient locator strategy
      let locator = "";
      if (testId) {
        locator = `[data-testid="${testId}"]`;
      } else if (id && !/^\d+$/.test(id)) {
        locator = `#${id}`;
      } else if (ariaLabel) {
        locator = `input[aria-label="${ariaLabel}"]`;
      } else if (role === "searchbox") {
        locator = "input[role='searchbox']";
      } else if (name) {
        locator = `input[name='${name}']`;
      } else if (placeholder) {
        locator = `input[placeholder='${placeholder}']`;
      } else {
        locator = `input[type='${type}']`;
      }

      candidates.push({
        rawTag: match[0],
        type,
        name,
        id,
        placeholder,
        ariaLabel,
        role,
        className,
        testId,
        insideFormOrHeader,
        score: totalScore,
        evidence: {
          role,
          name,
          placeholder,
          ariaLabel,
        },
        locator,
      });
    }

    return candidates;
  }

  private extractCardStructures(html: string): {
    cardLocator: string;
    cardsFound: number;
    regularityScore: number;
    titleFound: boolean;
    titleLocator: string;
    titleEvidence: string;
    sampleTitle?: string;
    priceFound: boolean;
    priceLocator: string;
    priceEvidence: string;
    sampleVisiblePrice?: number;
  } {
    // Look for article, section, or container elements that repeat and contain a title and price
    // Check for common semantic tag patterns: <article class="..."> or <div class="*card*">
    const articleCards = this.findMatchingCardCluster(html, "article");
    const sectionCards = this.findMatchingCardCluster(html, "section");
    const divCards = this.findMatchingCardCluster(html, "div");

    // Select the best cluster that has >= 2 items and highest score
    const clusters = [articleCards, sectionCards, divCards].filter((c) => c.cards.length >= 1);
    clusters.sort((a, b) => b.cards.length - a.cards.length);

    const bestCluster = clusters[0] ?? {
      cards: [],
      tag: "div",
      className: "product-grid-item",
    };

    const cardsFound = bestCluster.cards.length;
    const regularityScore = cardsFound >= 2 ? 1.0 : cardsFound === 1 ? 0.5 : 0.0;

    // Build resilient card locator (e.g. article.catalog-card or .catalog-card)
    let cardLocator = "";
    if (bestCluster.className) {
      const primaryClass = bestCluster.className.split(" ")[0].trim();
      cardLocator = `${bestCluster.tag}.${primaryClass}`;
    } else {
      cardLocator = bestCluster.tag;
    }

    // Inspect first card for Title and Price
    const sampleCard = bestCluster.cards[0] || "";

    // 1. Title discovery
    let titleFound = false;
    let titleLocator = "h3 a";
    let titleEvidence = "No title element detected";
    let sampleTitle = "";

    const headingMatch = /<(h[1-4]|div|h2|h3)[^>]*class="?([^">]*)"?[^>]*>([\s\S]*?)<\/\1>/i.exec(sampleCard);
    const anchorMatch = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(sampleCard);

    if (headingMatch && anchorMatch) {
      titleFound = true;
      const hClass = headingMatch[2]?.trim();
      if (hClass) {
        titleLocator = `.${hClass.split(" ")[0]} a`;
      } else {
        titleLocator = `${headingMatch[1]} a`;
      }
      sampleTitle = this.stripHtml(anchorMatch[2] || headingMatch[3]);
      titleEvidence = `Grounded title with selector '${titleLocator}' (sample: "${sampleTitle.slice(0, 30)}...")`;
    } else if (anchorMatch) {
      titleFound = true;
      titleLocator = "a";
      sampleTitle = this.stripHtml(anchorMatch[2]);
      titleEvidence = `Grounded title with generic anchor 'a' (sample: "${sampleTitle.slice(0, 30)}...")`;
    }

    // 2. Price discovery
    let priceFound = false;
    let priceLocator = ".price";
    let priceEvidence = "No price element detected";
    let sampleVisiblePrice: number | undefined;

    // Scan for currency pattern in sampleCard
    const priceClassMatch = /class="?([^">]*(?:price|sale|amount|cost)[^">]*)"?/i.exec(sampleCard);
    const priceTextMatch = /(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d{2})?)/i.exec(sampleCard);

    if (priceTextMatch) {
      priceFound = true;
      const numStr = priceTextMatch[1].replace(/,/g, "");
      sampleVisiblePrice = parseFloat(numStr);

      if (priceClassMatch) {
        const pClass = priceClassMatch[1].split(" ")[0].trim();
        priceLocator = `.${pClass}`;
        priceEvidence = `Grounded visible price with selector '.${pClass}' (sample: ₹${sampleVisiblePrice})`;
      } else {
        priceLocator = ".price, span:has-text('₹')";
        priceEvidence = `Grounded visible price with currency symbol text (sample: ₹${sampleVisiblePrice})`;
      }
    }

    return {
      cardLocator,
      cardsFound,
      regularityScore,
      titleFound,
      titleLocator,
      titleEvidence,
      sampleTitle,
      priceFound,
      priceLocator,
      priceEvidence,
      sampleVisiblePrice,
    };
  }

  private findMatchingCardCluster(
    html: string,
    tag: string
  ): {
    cards: string[];
    tag: string;
    className: string;
  } {
    const regex = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "gi");
    const cards: string[] = [];
    const classCount = new Map<string, number>();

    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      const attrs = match[1];
      const content = match[2];
      const className = (this.getAttr(attrs, "class") || "").trim();

      // Exclude ads, sponsored banners, and recent search pills
      const lowerAttrs = attrs.toLowerCase();
      const lowerContent = content.toLowerCase();
      const isAdOrBanner = this.sketch.productCards.excludeClasses.some(
        (ex) =>
          lowerAttrs.includes(ex) ||
          lowerContent.includes(`class="${ex}`) ||
          lowerContent.includes(`badge-${ex}`) ||
          lowerContent.includes(`>${ex}<`)
      );

      if (isAdOrBanner) {
        continue;
      }

      // Check if this tag contains both a title-like element and a currency symbol
      const hasCurrency = /(?:₹|Rs|INR|\$|€|£)\s*[\d,]+/i.test(content);
      const hasLinkOrHeading = /<a\b|<h[1-4]\b/i.test(content);

      if (hasCurrency && hasLinkOrHeading) {
        cards.push(match[0]);
        if (className) {
          const primaryClass = className.split(" ")[0];
          classCount.set(primaryClass, (classCount.get(primaryClass) ?? 0) + 1);
        }
      }
    }

    // Determine the most common class among valid cards
    let mostCommonClass = "";
    let maxCount = 0;
    for (const [cls, cnt] of classCount.entries()) {
      if (cnt > maxCount) {
        maxCount = cnt;
        mostCommonClass = cls;
      }
    }

    return {
      cards,
      tag,
      className: mostCommonClass,
    };
  }

  private groundPriceWithJsonLd(html: string, sampleVisiblePrice?: number): GroundedPrice {
    const jsonLdRegex = /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let jsonLdMatch: RegExpExecArray | null;

    let jsonLdPrice: number | undefined;
    let jsonLdCurrency = "INR";

    while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
      try {
        const parsed = JSON.parse(jsonLdMatch[1]);
        const items = Array.isArray(parsed) ? parsed : [parsed];

        for (const item of items) {
          if (item["@type"] === "Product" || item["@type"] === "Offer") {
            const offers = item.offers;
            if (offers) {
              const offerObj = Array.isArray(offers) ? offers[0] : offers;
              if (offerObj?.price) {
                jsonLdPrice = parseFloat(String(offerObj.price));
                if (offerObj.priceCurrency) {
                  jsonLdCurrency = offerObj.priceCurrency;
                }
                break;
              }
            } else if (item.price) {
              jsonLdPrice = parseFloat(String(item.price));
              break;
            }
          }
        }
      } catch {
        // Ignore JSON-LD parse errors; fallback to visible DOM
      }
    }

    // Grounding logic & Mismatch detection
    if (jsonLdPrice !== undefined && sampleVisiblePrice !== undefined) {
      const diff = Math.abs(jsonLdPrice - sampleVisiblePrice);
      if (diff > 1.0) {
        // JSON-LD MISMATCH! E.g. JSON-LD outdated price (₹999) vs visible DOM price (₹475)
        logger.warn("JSON-LD price mismatch detected; discarding JSON-LD in favor of grounded visible DOM", {
          jsonLdPrice,
          sampleVisiblePrice,
        });

        return {
          sellingPrice: sampleVisiblePrice,
          currency: jsonLdCurrency,
          source: "MISMATCH_FALLBACK",
          discrepancyNote: `JSON-LD price (₹${jsonLdPrice}) disagrees with visible DOM price (₹${sampleVisiblePrice}). Discarding stale JSON-LD in favor of grounded visible DOM.`,
        };
      }

      // JSON-LD and visible price agree
      return {
        sellingPrice: jsonLdPrice,
        currency: jsonLdCurrency,
        source: "JSON_LD",
      };
    }

    if (sampleVisiblePrice !== undefined) {
      return {
        sellingPrice: sampleVisiblePrice,
        currency: "INR",
        source: "VISIBLE_DOM",
      };
    }

    if (jsonLdPrice !== undefined) {
      return {
        sellingPrice: jsonLdPrice,
        currency: jsonLdCurrency,
        source: "JSON_LD",
      };
    }

    return {
      currency: "INR",
      source: "VISIBLE_DOM",
    };
  }

  private getAttr(attrsStr: string, attrName: string): string | null {
    const regex = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
    const m = regex.exec(attrsStr);
    if (!m) return null;
    return m[1] ?? m[2] ?? m[3] ?? null;
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  }
}
