export interface ParsedPrice {
  salePrice: number | null;
  originalPrice: number | null;
  emiPrice: number | null;
  unitPrice: number | null;
  currency: string;
  rawString: string;
  isAmbiguous: boolean;
}

export class PriceParser {
  /**
   * Parses raw price text and DOM context into distinct price categories.
   * Distinguishes sale price, MRP/original, EMI, and unit prices.
   */
  static parse(rawText: string, contextSnippet?: string): ParsedPrice {
    const raw = (rawText || "").trim();
    if (!raw) {
      return {
        salePrice: null,
        originalPrice: null,
        emiPrice: null,
        unitPrice: null,
        currency: "UNKNOWN",
        rawString: "",
        isAmbiguous: false,
      };
    }

    const currency = this.detectCurrency(raw);
    const combined = `${raw} ${contextSnippet || ""}`.toLowerCase();

    // Check for EMI / installment pricing
    const isEmi =
      combined.includes("emi") ||
      combined.includes("/month") ||
      combined.includes("/mo") ||
      combined.includes("per month");

    // Check for unit pricing
    const isUnit =
      combined.includes("/ piece") ||
      combined.includes("/ 100g") ||
      combined.includes("/ unit") ||
      combined.includes("per piece");

    // Check for strikethrough / original price markers
    const isOriginalPrice =
      combined.includes("mrp") ||
      combined.includes("regular price") ||
      combined.includes("original") ||
      combined.includes("<del") ||
      combined.includes("<strike") ||
      combined.includes("line-through");

    // Extract all numeric amounts from raw text
    const numbers = this.extractNumericAmounts(raw);

    if (numbers.length === 0) {
      return {
        salePrice: null,
        originalPrice: null,
        emiPrice: null,
        unitPrice: null,
        currency,
        rawString: raw,
        isAmbiguous: false,
      };
    }

    if (isEmi) {
      return {
        salePrice: null,
        originalPrice: null,
        emiPrice: numbers[0] ?? null,
        unitPrice: null,
        currency,
        rawString: raw,
        isAmbiguous: false,
      };
    }

    if (isUnit) {
      return {
        salePrice: null,
        originalPrice: null,
        emiPrice: null,
        unitPrice: numbers[0] ?? null,
        currency,
        rawString: raw,
        isAmbiguous: false,
      };
    }

    if (numbers.length === 1) {
      if (isOriginalPrice) {
        return {
          salePrice: null,
          originalPrice: numbers[0] ?? null,
          emiPrice: null,
          unitPrice: null,
          currency,
          rawString: raw,
          isAmbiguous: true, // Only MRP without sale price is ambiguous
        };
      }
      return {
        salePrice: numbers[0] ?? null,
        originalPrice: null,
        emiPrice: null,
        unitPrice: null,
        currency,
        rawString: raw,
        isAmbiguous: false,
      };
    }

    // Multiple prices present (e.g. MRP ₹999, Sale ₹499)
    // In e-commerce, the sale price is typically the lower of the two
    const sorted = [...numbers].sort((a, b) => a - b);
    const sale = sorted[0]!;
    const original = sorted[sorted.length - 1]!;

    return {
      salePrice: sale,
      originalPrice: original !== sale ? original : null,
      emiPrice: null,
      unitPrice: null,
      currency,
      rawString: raw,
      isAmbiguous: false,
    };
  }

  static detectCurrency(text: string): string {
    const upper = text.toUpperCase();
    if (text.includes("₹") || upper.includes("RS.") || upper.includes("RS") || upper.includes("INR")) {
      return "INR";
    }
    if (text.includes("$") || upper.includes("USD")) {
      return "USD";
    }
    if (text.includes("£") || upper.includes("GBP")) {
      return "GBP";
    }
    if (text.includes("€") || upper.includes("EUR")) {
      return "EUR";
    }
    return "INR"; // Default fallback for Indian e-commerce
  }

  static extractNumericAmounts(text: string): number[] {
    // Regex for Indian & Western currency amounts: e.g. 1,249.00 or 1249 or 1,25,000.50
    const matches = text.match(/(?:[₹$£€]|Rs\.?|INR)?\s*([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/gi);
    if (!matches) return [];

    const results: number[] = [];
    for (const match of matches) {
      // Remove currency symbols, whitespace, and formatting commas
      const cleaned = match.replace(/[₹$£€\s]|Rs\.?|INR/gi, "").replace(/,/g, "");
      const num = parseFloat(cleaned);
      if (!isNaN(num) && num > 0) {
        results.push(num);
      }
    }
    return results;
  }
}

