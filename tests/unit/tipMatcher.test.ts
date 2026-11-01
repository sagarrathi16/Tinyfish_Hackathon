import { describe, it, expect } from "vitest";
import { TIPMatcher, DEFAULT_STRUCTURAL_SKETCH } from "../../src/transfer/tipMatcher.js";

describe("TIP Structural Matcher (Task Invariant Pattern)", () => {
  const matcher = new TIPMatcher();

  it("successfully matches structurally different Store B page with transparent scored features", () => {
    const storeBHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Electronics Comp</title>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org/",
          "@type": "Product",
          "name": "Arduino Uno R3 Compatible Board",
          "offers": {
            "@type": "Offer",
            "priceCurrency": "INR",
            "price": "475.00"
          }
        }
        </script>
      </head>
      <body>
        <header>
          <form action="/store-b/search" method="GET">
            <input type="text" id="store-b-kw" name="keyword" class="header-search-bar" placeholder="Search maker parts..." data-testid="search-input" />
            <button type="submit">Search</button>
          </form>
        </header>
        <section class="catalog-grid">
          <article class="catalog-card" data-sku="ard-01">
            <h3 class="catalog-card-title"><a href="/store-b/item/arduino-uno">Arduino Uno R3 Compatible Board</a></h3>
            <div class="pricing-box"><span class="sale-price">₹ 475.00</span><del>₹ 800.00</del></div>
          </article>
          <article class="catalog-card" data-sku="ard-02">
            <h3 class="catalog-card-title"><a href="/store-b/item/arduino-nano">Arduino Nano V3</a></h3>
            <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
          </article>
        </section>
      </body>
      </html>
    `;

    const res = matcher.matchPage(storeBHtml, "store-b.local");
    expect(res.matched).toBe(true);
    expect(res.status).toBe("MATCHED");
    expect(res.confidence).toBeGreaterThanOrEqual(0.7);
    expect(res.candidateAdapter).toBeDefined();

    // Candidate adapter must have status CANDIDATE (never ACTIVE)
    expect(res.candidateAdapter?.status).toBe("CANDIDATE");
    expect(res.candidateAdapter?.domain).toBe("store-b.local");

    // Check transparent scored features
    expect(res.scoredFeatures.length).toBeGreaterThanOrEqual(4);
    const featureNames = res.scoredFeatures.map((f) => f.featureName);
    expect(featureNames).toContain("SEARCH_ROLE_AND_TYPE");
    expect(featureNames).toContain("REPEATED_CARD_REGULARITY");
    expect(featureNames).toContain("TITLE_ANCHOR_GROUNDING");
    expect(featureNames).toContain("PRICE_PATTERN_GROUNDING");

    // Check grounded price
    expect(res.groundedPrice?.sellingPrice).toBe(475.0);
    expect(res.groundedPrice?.currency).toBe("INR");
    expect(res.groundedPrice?.source).toBe("JSON_LD");
  });

  it("rejects ambiguous search controls with AMBIGUOUS_REJECTED", () => {
    const ambiguousHtml = `
      <html>
      <body>
        <!-- Two identical inputs with identical scores and no differentiating features -->
        <input type="text" name="keyword" placeholder="Search maker parts..." />
        <input type="text" name="keyword" placeholder="Search maker parts..." />
        <section class="catalog-grid">
          <article class="catalog-card">
            <h3><a href="/item/1">Item 1</a></h3>
            <span class="sale-price">₹ 475.00</span>
          </article>
          <article class="catalog-card">
            <h3><a href="/item/2">Item 2</a></h3>
            <span class="sale-price">₹ 260.00</span>
          </article>
        </section>
      </body>
      </html>
    `;

    const res = matcher.matchPage(ambiguousHtml, "store-ambiguous.local");
    expect(res.matched).toBe(false);
    expect(res.status).toBe("AMBIGUOUS_REJECTED");
    expect(res.rejectionReason).toBe("AMBIGUOUS_SEARCH_CONTROLS");
    expect(res.explanation).toContain("Search control ambiguity detected");
  });

  it("filters out misleading search suggestion pills and grounds genuine product cards", () => {
    const misleadingHtml = `
      <html>
      <body>
        <input type="text" name="keyword" placeholder="Search maker parts..." data-testid="search-input" />
        <div class="recent-searches">
          <div class="search-pill"><a href="/search?kw=sensors">Sensors</a></div>
          <div class="search-pill"><a href="/search?kw=cables">Jumper Cables</a></div>
        </div>
        <section class="catalog-grid">
          <article class="catalog-card">
            <h3 class="catalog-card-title"><a href="/item/ard">Arduino Uno R3 Compatible Board</a></h3>
            <div class="pricing-box"><span class="sale-price">₹ 475.00</span></div>
          </article>
          <article class="catalog-card">
            <h3 class="catalog-card-title"><a href="/item/nano">Arduino Nano V3 Board</a></h3>
            <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
          </article>
        </section>
      </body>
      </html>
    `;

    const res = matcher.matchPage(misleadingHtml, "store-misleading.local");
    expect(res.matched).toBe(true);
    expect(res.status).toBe("MATCHED");
    expect(res.candidateAdapter?.locatorBindings.PRODUCT_CARD.locatorValue).toBe("article.catalog-card");
  });

  it("filters out ad cards / sponsored banners and grounds only genuine products", () => {
    const adHtml = `
      <html>
      <body>
        <input type="text" name="keyword" placeholder="Search maker parts..." data-testid="search-input" />
        <section class="catalog-grid">
          <article class="catalog-card ad-sponsored-banner">
            <span class="badge-sponsored">Sponsored</span>
            <h3><a href="/ad-link">Cloud Server Hosting Deals</a></h3>
            <span class="sale-price">₹ 999.00</span>
          </article>
          <article class="catalog-card">
            <h3 class="catalog-card-title"><a href="/item/ard">Arduino Uno R3 Compatible Board</a></h3>
            <div class="pricing-box"><span class="sale-price">₹ 475.00</span></div>
          </article>
          <article class="catalog-card">
            <h3 class="catalog-card-title"><a href="/item/nano">Arduino Nano V3 Board</a></h3>
            <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
          </article>
        </section>
      </body>
      </html>
    `;

    const res = matcher.matchPage(adHtml, "store-ads.local");
    expect(res.matched).toBe(true);
    expect(res.status).toBe("MATCHED");
    expect(res.groundedPrice?.sellingPrice).toBe(475.0); // Genuine product price, not ad price 999.00
  });

  it("grounds product cards inside nested carousel / subgrid structures", () => {
    const nestedHtml = `
      <html>
      <body>
        <input type="text" name="keyword" placeholder="Search maker parts..." data-testid="search-input" />
        <div class="carousel-outer">
          <div class="nested-subgrid">
            <article class="catalog-card">
              <h3 class="catalog-card-title"><a href="/item/ard">Arduino Uno R3 Compatible Board</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 475.00</span></div>
            </article>
            <article class="catalog-card">
              <h3 class="catalog-card-title"><a href="/item/nano">Arduino Nano V3 Board</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
            </article>
          </div>
        </div>
      </body>
      </html>
    `;

    const res = matcher.matchPage(nestedHtml, "store-nested.local");
    expect(res.matched).toBe(true);
    expect(res.candidateAdapter?.locatorBindings.PRODUCT_CARD.locatorValue).toBe("article.catalog-card");
  });

  it("falls back gracefully when ARIA labels and roles are absent", () => {
    const missingAriaHtml = `
      <html>
      <body>
        <!-- Plain HTML without aria-label or role -->
        <input type="text" name="keyword" placeholder="Search maker parts..." />
        <section class="catalog-grid">
          <article class="catalog-card">
            <h3 class="catalog-card-title"><a href="/item/ard">Arduino Uno R3 Compatible Board</a></h3>
            <div class="pricing-box"><span class="sale-price">₹ 475.00</span></div>
          </article>
          <article class="catalog-card">
            <h3 class="catalog-card-title"><a href="/item/nano">Arduino Nano V3 Board</a></h3>
            <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
          </article>
        </section>
      </body>
      </html>
    `;

    const res = matcher.matchPage(missingAriaHtml, "store-plain.local");
    expect(res.matched).toBe(true);
    expect(res.candidateAdapter?.locatorBindings.SEARCH_INPUT.locatorValue).toBe("input[name='keyword']");
  });

  it("detects JSON-LD price mismatch and falls back to visible grounded DOM price", () => {
    const mismatchHtml = `
      <html>
      <head>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org/",
          "@type": "Product",
          "name": "Arduino Uno R3 Compatible Board",
          "offers": {
            "@type": "Offer",
            "priceCurrency": "INR",
            "price": "999.00"
          }
        }
        </script>
      </head>
      <body>
        <input type="text" name="keyword" placeholder="Search maker parts..." data-testid="search-input" />
        <section class="catalog-grid">
          <article class="catalog-card">
            <h3 class="catalog-card-title"><a href="/item/ard">Arduino Uno R3 Compatible Board</a></h3>
            <!-- Visible DOM price is ₹475, but JSON-LD was stale at ₹999 -->
            <div class="pricing-box"><span class="sale-price">₹ 475.00</span></div>
          </article>
          <article class="catalog-card">
            <h3 class="catalog-card-title"><a href="/item/nano">Arduino Nano V3 Board</a></h3>
            <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
          </article>
        </section>
      </body>
      </html>
    `;

    const res = matcher.matchPage(mismatchHtml, "store-mismatch.local");
    expect(res.matched).toBe(true);
    expect(res.groundedPrice?.source).toBe("MISMATCH_FALLBACK");
    expect(res.groundedPrice?.sellingPrice).toBe(475.0); // Discarded stale 999.00!
    expect(res.groundedPrice?.discrepancyNote).toContain("disagrees with visible DOM price");
  });

  it("rejects non-e-commerce or empty DOM with LOW_CONFIDENCE_FALLBACK without claiming universal transfer", () => {
    const blogHtml = `
      <html>
      <body>
        <header><h1>Tech Blog</h1></header>
        <article>
          <h2>How to code in TypeScript</h2>
          <p>This is a tutorial article without products, shopping carts, or prices.</p>
        </article>
      </body>
      </html>
    `;

    const res = matcher.matchPage(blogHtml, "blog.local");
    expect(res.matched).toBe(false);
    expect(res.status).toBe("LOW_CONFIDENCE_FALLBACK");
    expect(res.rejectionReason).toBe("LOW_CONFIDENCE");
  });

  it("respects feature flag and immediately returns DISABLED when enableTip is false", () => {
    const storeBHtml = `<html><body><input type="search" placeholder="Search..." /></body></html>`;
    const res = matcher.matchPage(storeBHtml, "store.local", { enableTip: false });
    expect(res.matched).toBe(false);
    expect(res.status).toBe("DISABLED");
    expect(res.explanation).toContain("disabled by feature flag");
  });
});

