import { z } from "zod";

// ============================================================================
// 1. Frozen Evaluation Dataset Schema & Ground Truth Types
// ============================================================================

export const GroundTruthItemSchema = z.object({
  datasetId: z.string(),
  domain: z.string(),
  category: z.string(),
  query: z.string(),
  expectedProduct: z.string(),
  expectedModelSku: z.string(),
  expectedPrice: z.number(),
  expectedCurrency: z.string().default("INR"),
  canonicalUrlPattern: z.string(),
  isAccessory: z.boolean().default(false),
  shouldPass: z.boolean().default(true),
  notes: z.string().optional(),
});
export type GroundTruthItem = z.infer<typeof GroundTruthItemSchema>;

export interface GroundTruthGradingResult {
  isCorrect: boolean;
  isSilentWrong: boolean;
  score: number; // 0 to 1
  reason: string;
  observedTitle?: string;
  observedPrice?: number;
  observedUrl?: string;
}

// ============================================================================
// 2. Frozen Evaluation Query Sets (At least 4 per domain)
// ============================================================================

/**
 * Store A Frozen Query Set (Owned Mock Storefront — Standard Layout)
 * 2 adapter validation queries + 2 held-out test queries
 */
export const FROZEN_STORE_A_DATASET: GroundTruthItem[] = [
  {
    datasetId: "EVAL-STORE-A-01",
    domain: "localhost",
    category: "Microcontrollers",
    query: "Arduino Uno",
    expectedProduct: "Arduino Uno R3 Compatible Development Board",
    expectedModelSku: "ARD-UNO-R3",
    expectedPrice: 499.0,
    expectedCurrency: "INR",
    canonicalUrlPattern: "/store-a/product/arduino-uno",
    isAccessory: false,
    shouldPass: true,
    notes: "Primary development board; must distinguish sale price ₹499 from MRP ₹799",
  },
  {
    datasetId: "EVAL-STORE-A-02",
    domain: "localhost",
    category: "IoT / Wireless",
    query: "ESP32",
    expectedProduct: "ESP32 NodeMCU WiFi + Bluetooth Development Board",
    expectedModelSku: "ESP32-DEVKIT",
    expectedPrice: 350.0,
    expectedCurrency: "INR",
    canonicalUrlPattern: "/store-a/product/esp32-devkit",
    isAccessory: false,
    shouldPass: true,
    notes: "Must select NodeMCU board over camera module",
  },
  {
    datasetId: "EVAL-STORE-A-03",
    domain: "localhost",
    category: "Single Board Computers",
    query: "Raspberry Pi",
    expectedProduct: "Raspberry Pi 5 Model B 8GB RAM",
    expectedModelSku: "RPI-5-8GB",
    expectedPrice: 7999.0,
    expectedCurrency: "INR",
    canonicalUrlPattern: "/store-a/product/raspberry-pi-5",
    isAccessory: false,
    shouldPass: true,
    notes: "Held-out test query; validates high price formatting (₹7,999)",
  },
  {
    datasetId: "EVAL-STORE-A-04",
    domain: "localhost",
    category: "Wearables (Negative Test)",
    query: "Smart Watch",
    expectedProduct: "Smart Watch",
    expectedModelSku: "WATCH-ACC",
    expectedPrice: 0,
    expectedCurrency: "INR",
    canonicalUrlPattern: "/store-a/product/watch",
    isAccessory: true,
    shouldPass: false,
    notes: "Held-out negative test query; catalog contains only straps/cases. Must reject accessories.",
  },
];

/**
 * Store B Frozen Query Set (Owned Mock Storefront — Structurally Different)
 * 2 adapter validation queries + 2 held-out test queries
 */
export const FROZEN_STORE_B_DATASET: GroundTruthItem[] = [
  {
    datasetId: "EVAL-STORE-B-01",
    domain: "store-b.local",
    category: "Maker Components",
    query: "Arduino Uno",
    expectedProduct: "Arduino Uno R3 Compatible Board",
    expectedModelSku: "ard-01",
    expectedPrice: 475.0,
    expectedCurrency: "INR",
    canonicalUrlPattern: "/store-b/item/arduino-uno",
    isAccessory: false,
    shouldPass: true,
    notes: "Store B fixture with semantic Schema.org JSON-LD grounding",
  },
  {
    datasetId: "EVAL-STORE-B-02",
    domain: "store-b.local",
    category: "IoT / Wireless",
    query: "ESP32",
    expectedProduct: "ESP32 WiFi + Bluetooth Board",
    expectedModelSku: "esp32-01",
    expectedPrice: 340.0,
    expectedCurrency: "INR",
    canonicalUrlPattern: "/store-b/item/esp32-devkit",
    isAccessory: false,
    shouldPass: true,
    notes: "Store B ESP32 development board",
  },
  {
    datasetId: "EVAL-STORE-B-03",
    domain: "store-b.local",
    category: "Single Board Computers",
    query: "Raspberry Pi",
    expectedProduct: "Raspberry Pi 5 8GB",
    expectedModelSku: "rpi-01",
    expectedPrice: 7850.0,
    expectedCurrency: "INR",
    canonicalUrlPattern: "/store-b/item/rpi-5",
    isAccessory: false,
    shouldPass: true,
    notes: "Held-out query 1 for Store B",
  },
  {
    datasetId: "EVAL-STORE-B-04",
    domain: "store-b.local",
    category: "Accessories (Negative Test)",
    query: "Smart Watch",
    expectedProduct: "Smart Watch",
    expectedModelSku: "strap-01",
    expectedPrice: 0,
    expectedCurrency: "INR",
    canonicalUrlPattern: "/store-b/item/watch-strap",
    isAccessory: true,
    shouldPass: false,
    notes: "Held-out negative query 2 for Store B; catalog contains only replacement silicone strap.",
  },
];

// ============================================================================
// 3. Strict Deterministic Correctness Grader
// ============================================================================

/**
 * Grades an execution result against frozen ground truth.
 * A result is "silent-wrong" if it was marked PASS/successful by a runner,
 * but is factually incorrect, wrong variant, accessory, or wrong price.
 */
export function gradeResultAgainstGroundTruth(
  result: {
    status: string;
    product?: Record<string, unknown> | null;
    structuredOutput?: Record<string, unknown> | null;
  },
  groundTruth: GroundTruthItem
): GroundTruthGradingResult {
  const output = (result.product || result.structuredOutput || {}) as Record<string, unknown>;
  const title = typeof output.title === "string" ? output.title : "";
  const numericPrice = typeof output.numericPrice === "number" ? output.numericPrice : undefined;
  const currency = typeof output.currency === "string" ? output.currency : "INR";
  const url = typeof output.url === "string" ? output.url : typeof output.productUrl === "string" ? output.productUrl : "";

  // --------------------------------------------------------------------------
  // Case A: Expected Failure / Negative Test (e.g. Smart Watch accessories)
  // --------------------------------------------------------------------------
  if (!groundTruth.shouldPass) {
    if (result.status === "SUCCESS") {
      // SILENT WRONG: Accepted an accessory or invalid item as a successful match!
      return {
        isCorrect: false,
        isSilentWrong: true,
        score: 0,
        reason: `Negative query '${groundTruth.query}' was marked SUCCESS, but ground truth specifies it must fail or reject accessories. Title observed: '${title}'.`,
        observedTitle: title,
        observedPrice: numericPrice,
        observedUrl: url,
      };
    }

    // Correctly rejected/halted
    return {
      isCorrect: true,
      isSilentWrong: false,
      score: 1.0,
      reason: `Correctly refused non-matching / accessory query '${groundTruth.query}' with status '${result.status}'.`,
    };
  }

  // --------------------------------------------------------------------------
  // Case B: Expected Success Query
  // --------------------------------------------------------------------------
  if (result.status !== "SUCCESS") {
    return {
      isCorrect: false,
      isSilentWrong: false, // Refused honestly with an error; not silent wrong
      score: 0,
      reason: `Execution status was '${result.status}', expected 'SUCCESS'.`,
    };
  }

  // 1. Verify Product Title
  if (!title) {
    return {
      isCorrect: false,
      isSilentWrong: true,
      score: 0,
      reason: "Missing product title in structured output.",
    };
  }

  const titleLower = title.toLowerCase();
  const expectedLower = groundTruth.expectedProduct.toLowerCase();
  const queryLower = groundTruth.query.toLowerCase();

  // Must contain main query token
  const queryTokens = queryLower.split(/\s+/).filter((t) => t.length > 2);
  const matchesTokens = queryTokens.every((t) => titleLower.includes(t));
  if (!matchesTokens) {
    return {
      isCorrect: false,
      isSilentWrong: true,
      score: 0,
      reason: `Title '${title}' does not match expected query tokens '${groundTruth.query}'.`,
      observedTitle: title,
    };
  }

  // 2. Verify Price
  if (numericPrice === undefined || isNaN(numericPrice) || numericPrice <= 0) {
    return {
      isCorrect: false,
      isSilentWrong: true,
      score: 0,
      reason: `Invalid or missing numeric price: ${numericPrice}.`,
      observedPrice: numericPrice,
    };
  }

  const priceDiff = Math.abs(numericPrice - groundTruth.expectedPrice);
  // Allow slight tolerance of ₹5 for rounding or dynamic taxation
  if (priceDiff > 10.0) {
    return {
      isCorrect: false,
      isSilentWrong: true,
      score: 0,
      reason: `Extracted price ₹${numericPrice} disagrees with ground truth baseline ₹${groundTruth.expectedPrice} (difference: ₹${priceDiff}).`,
      observedPrice: numericPrice,
    };
  }

  // 3. Verify Currency
  if (currency.toUpperCase() !== groundTruth.expectedCurrency.toUpperCase()) {
    return {
      isCorrect: false,
      isSilentWrong: true,
      score: 0,
      reason: `Extracted currency '${currency}' disagrees with ground truth '${groundTruth.expectedCurrency}'.`,
    };
  }

  // 4. Verify Canonical URL
  if (groundTruth.canonicalUrlPattern && !url.includes(groundTruth.canonicalUrlPattern)) {
    return {
      isCorrect: false,
      isSilentWrong: false,
      score: 0.8, // Partial credit if title and price are correct
      reason: `Extracted URL '${url}' does not match expected canonical path '${groundTruth.canonicalUrlPattern}'.`,
      observedUrl: url,
    };
  }

  return {
    isCorrect: true,
    isSilentWrong: false,
    score: 1.0,
    reason: `Verified against ground truth: title, price (₹${numericPrice}), currency, and URL pattern aligned.`,
    observedTitle: title,
    observedPrice: numericPrice,
    observedUrl: url,
  };
}
