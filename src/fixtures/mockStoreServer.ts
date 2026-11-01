import express, { type Request, type Response } from "express";
import type { Server } from "node:http";

export class MockStoreServer {
  private app: express.Express;
  private server: Server | null = null;
  public port: number = 0;
  public domMutated: boolean = false;

  constructor() {
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // ------------------------------------------------------------------------
    // Store A (Standard E-Commerce Storefront)
    // ------------------------------------------------------------------------
    this.app.get("/store-a", (_req: Request, res: Response) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Robu Electronics — Hobby Electronics Store</title></head>
        <body>
          <header>
            <h1>Robu Store</h1>
            <form action="/store-a/search" method="GET">
              <input type="search" name="s" placeholder="Search products..." aria-label="Search store" role="searchbox" />
              <button type="submit">Search</button>
            </form>
          </header>
          <main>
            <p>Welcome to Robu Store. Explore 10,000+ maker components.</p>
          </main>
        </body>
        </html>
      `);
    });

    this.app.get("/store-a/search", (req: Request, res: Response) => {
      const q = String(req.query.s || "").toLowerCase();

      // DOM Mutation Toggle effect
      const cardClass = this.domMutated ? "mutated-card-node" : "product-grid-item";
      const priceClass = "woocommerce-Price-amount";

      if (q.includes("empty") || q.includes("notfound")) {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>Search: ${q}</title></head>
          <body>
            <h2>Search results for "${q}"</h2>
            <div class="no-products"><p>No products found matching your search.</p></div>
          </body>
          </html>
        `);
      }

      if (q.includes("watch")) {
        // Return accessory items to test accessory filtering
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>Search results for "${q}"</title></head>
          <body>
            <h2>Results for "${q}"</h2>
            <div class="products-grid">
              <div class="${cardClass}">
                <h2 class="product-title"><a href="/store-a/product/watch-strap">Silicone Watch Strap 22mm for Smart Watch</a></h2>
                <div class="price"><span class="${priceClass}"><bdi>₹199</bdi></span></div>
              </div>
              <div class="${cardClass}">
                <h2 class="product-title"><a href="/store-a/product/watch-case">Protective Bumper Case for Smart Watch</a></h2>
                <div class="price"><span class="${priceClass}"><bdi>₹149</bdi></span></div>
              </div>
            </div>
          </body>
          </html>
        `);
      }

      if (q.includes("esp32")) {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>Search results for "${q}"</title></head>
          <body>
            <h2>Results for "${q}"</h2>
            <div class="products-grid">
              <div class="${cardClass}">
                <h2 class="product-title"><a href="/store-a/product/esp32-devkit">ESP32 NodeMCU WiFi + Bluetooth Development Board</a></h2>
                <div class="price"><span class="${priceClass}"><bdi>₹350</bdi></span></div>
              </div>
              <div class="${cardClass}">
                <h2 class="product-title"><a href="/store-a/product/esp32-cam">ESP32-CAM WiFi + Bluetooth Camera Module</a></h2>
                <div class="price"><span class="${priceClass}"><bdi>₹580</bdi></span></div>
              </div>
            </div>
          </body>
          </html>
        `);
      }

      if (q.includes("raspberry") || q.includes("pi")) {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>Search results for "${q}"</title></head>
          <body>
            <h2>Results for "${q}"</h2>
            <div class="products-grid">
              <div class="${cardClass}">
                <h2 class="product-title"><a href="/store-a/product/raspberry-pi-5">Raspberry Pi 5 Model B 8GB RAM</a></h2>
                <div class="price"><span class="${priceClass}"><bdi>₹7,999</bdi></span></div>
              </div>
            </div>
          </body>
          </html>
        `);
      }

      // Default: Return valid products (e.g. Arduino / Raspberry Pi)
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Search results for "${q}"</title></head>
        <body>
          <h2>Results for "${q}"</h2>
          <div class="products-grid">
            <div class="${cardClass}">
              <h2 class="product-title"><a href="/store-a/product/arduino-uno">Arduino Uno R3 Compatible Development Board</a></h2>
              <div class="price">
                <del><span class="mrp">₹799</span></del>
                <ins><span class="${priceClass}"><bdi>₹499</bdi></span></ins>
              </div>
            </div>
            <div class="${cardClass}">
              <h2 class="product-title"><a href="/store-a/product/arduino-nano">Arduino Nano V3.0 ATmega328 Board</a></h2>
              <div class="price"><span class="${priceClass}"><bdi>₹280</bdi></span></div>
            </div>
            <div class="${cardClass}">
              <h2 class="product-title"><a href="/store-a/product/arduino-mega">Arduino Mega 2560 R3 Board</a></h2>
              <div class="price"><span class="${priceClass}"><bdi>₹1,250</bdi></span></div>
            </div>
          </div>
        </body>
        </html>
      `);
    });

    // ------------------------------------------------------------------------
    // Store B (Structurally Different E-Commerce Storefront)
    // ------------------------------------------------------------------------
    this.app.get("/store-b", (_req: Request, res: Response) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Electronics Comp — Maker Components & Sensors</title>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org/",
            "@type": "Product",
            "name": "Arduino Uno R3 Compatible Board",
            "offers": {
              "@type": "Offer",
              "priceCurrency": "INR",
              "price": "475.00",
              "availability": "https://schema.org/InStock"
            }
          }
          </script>
        </head>
        <body>
          <header class="site-header">
            <div class="brand"><h1>ElectronicsComp</h1></div>
            <nav class="top-nav">
              <form action="/store-b/search" method="GET">
                <input type="text" id="store-b-kw" name="keyword" class="header-search-bar" placeholder="Search maker parts..." data-testid="search-input" />
                <button type="submit" id="btn-do-search">Search Components</button>
              </form>
            </nav>
          </header>
          <main>
            <h2>Featured Maker Components</h2>
            <section class="catalog-grid">
              <article class="catalog-card" data-sku="ard-01">
                <h3 class="catalog-card-title"><a href="/store-b/item/arduino-uno">Arduino Uno R3 Compatible Board</a></h3>
                <div class="pricing-box">
                  <span class="sale-price">₹ 475.00</span>
                  <del class="regular-mrp">₹ 800.00</del>
                </div>
              </article>
              <article class="catalog-card" data-sku="ard-02">
                <h3 class="catalog-card-title"><a href="/store-b/item/arduino-nano">Arduino Nano V3 ATmega328</a></h3>
                <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
              </article>
              <article class="catalog-card" data-sku="ard-03">
                <h3 class="catalog-card-title"><a href="/store-b/item/arduino-mega">Arduino Mega 2560 Board</a></h3>
                <div class="pricing-box"><span class="sale-price">₹ 1,190.00</span></div>
              </article>
            </section>
          </main>
        </body>
        </html>
      `);
    });

    this.app.get("/store-b/search", (req: Request, res: Response) => {
      const q = String(req.query.keyword || req.query.s || "").toLowerCase();

      if (q.includes("empty") || q.includes("notfound")) {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>No Results — ElectronicsComp</title></head>
          <body>
            <h2>Catalog Search: ${q}</h2>
            <div class="empty-state"><p>Zero catalog items matched your keywords.</p></div>
          </body>
          </html>
        `);
      }

      if (q.includes("watch")) {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>Accessories — ElectronicsComp</title></head>
          <body>
            <section class="catalog-grid">
              <article class="catalog-card" data-sku="strap-01">
                <h3 class="catalog-card-title"><a href="/store-b/item/watch-strap">Silicone Replacement Strap 20mm for Smart Watch</a></h3>
                <div class="pricing-box"><span class="sale-price">₹ 180.00</span></div>
              </article>
            </section>
          </body>
          </html>
        `);
      }

      if (q.includes("esp32")) {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>ESP32 — ElectronicsComp</title></head>
          <body>
            <section class="catalog-grid">
              <article class="catalog-card" data-sku="esp32-01">
                <h3 class="catalog-card-title"><a href="/store-b/item/esp32-devkit">ESP32 WiFi + Bluetooth Board</a></h3>
                <div class="pricing-box"><span class="sale-price">₹ 340.00</span></div>
              </article>
              <article class="catalog-card" data-sku="esp32-02">
                <h3 class="catalog-card-title"><a href="/store-b/item/esp32-cam">ESP32 CAM OV2640 Module</a></h3>
                <div class="pricing-box"><span class="sale-price">₹ 560.00</span></div>
              </article>
            </section>
          </body>
          </html>
        `);
      }

      if (q.includes("raspberry") || q.includes("pi")) {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>Raspberry Pi — ElectronicsComp</title></head>
          <body>
            <section class="catalog-grid">
              <article class="catalog-card" data-sku="rpi-01">
                <h3 class="catalog-card-title"><a href="/store-b/item/rpi-5">Raspberry Pi 5 8GB</a></h3>
                <div class="pricing-box"><span class="sale-price">₹ 7,850.00</span></div>
              </article>
            </section>
          </body>
          </html>
        `);
      }

      // Default: Return Arduino results with semantic JSON-LD
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Arduino Components — ElectronicsComp</title>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org/",
            "@type": "Product",
            "name": "Arduino Uno R3 Compatible Board",
            "offers": {
              "@type": "Offer",
              "priceCurrency": "INR",
              "price": "475.00",
              "availability": "https://schema.org/InStock"
            }
          }
          </script>
        </head>
        <body>
          <h2>Components Matching "${q}"</h2>
          <section class="catalog-grid">
            <article class="catalog-card" data-sku="ard-01">
              <h3 class="catalog-card-title"><a href="/store-b/item/arduino-uno">Arduino Uno R3 Compatible Board</a></h3>
              <div class="pricing-box">
                <span class="sale-price">₹ 475.00</span>
                <del class="regular-mrp">₹ 800.00</del>
              </div>
            </article>
            <article class="catalog-card" data-sku="ard-02">
              <h3 class="catalog-card-title"><a href="/store-b/item/arduino-nano">Arduino Nano V3 ATmega328</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
            </article>
            <article class="catalog-card" data-sku="ard-03">
              <h3 class="catalog-card-title"><a href="/store-b/item/arduino-mega">Arduino Mega 2560 Board</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 1,190.00</span></div>
            </article>
          </section>
        </body>
        </html>
      `);
    });

    // ------------------------------------------------------------------------
    // TIP Adversarial Fixture: Misleading Similar DOM (Search Suggestions)
    // ------------------------------------------------------------------------
    this.app.get("/store-b/misleading-dom", (_req: Request, res: Response) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Search Catalog</title></head>
        <body>
          <input type="text" id="kw" name="keyword" placeholder="Search maker parts..." />
          <div class="recent-searches">
            <div class="search-pill"><a href="/store-b/search?keyword=sensors">Sensor Modules</a></div>
            <div class="search-pill"><a href="/store-b/search?keyword=cables">Jumper Cables</a></div>
          </div>
          <section class="catalog-grid">
            <article class="catalog-card">
              <h3 class="catalog-card-title"><a href="/store-b/item/arduino-uno">Arduino Uno R3 Compatible Board</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 475.00</span></div>
            </article>
            <article class="catalog-card">
              <h3 class="catalog-card-title"><a href="/store-b/item/arduino-nano">Arduino Nano V3 Board</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
            </article>
          </section>
        </body>
        </html>
      `);
    });

    // ------------------------------------------------------------------------
    // TIP Adversarial Fixture: Ad / Sponsored Banners in Grid
    // ------------------------------------------------------------------------
    this.app.get("/store-b/ad-cards", (_req: Request, res: Response) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Search Catalog with Ads</title></head>
        <body>
          <input type="text" id="kw" name="keyword" placeholder="Search maker parts..." />
          <section class="catalog-grid">
            <article class="catalog-card ad-sponsored-banner">
              <span class="badge-sponsored">Sponsored</span>
              <h3 class="ad-title"><a href="https://ad-network.com/hosting">Cloud Server Hosting Deals</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 999.00</span></div>
            </article>
            <article class="catalog-card">
              <h3 class="catalog-card-title"><a href="/store-b/item/arduino-uno">Arduino Uno R3 Compatible Board</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 475.00</span></div>
            </article>
            <article class="catalog-card">
              <h3 class="catalog-card-title"><a href="/store-b/item/arduino-nano">Arduino Nano V3 Board</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
            </article>
          </section>
        </body>
        </html>
      `);
    });

    // ------------------------------------------------------------------------
    // TIP Adversarial Fixture: Nested Grids / Carousels
    // ------------------------------------------------------------------------
    this.app.get("/store-b/nested-grids", (_req: Request, res: Response) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Nested Carousel Store</title></head>
        <body>
          <input type="text" id="kw" name="keyword" placeholder="Search maker parts..." />
          <div class="carousel-outer">
            <div class="nested-subgrid">
              <article class="catalog-card">
                <h3 class="catalog-card-title"><a href="/store-b/item/arduino-uno">Arduino Uno R3 Compatible Board</a></h3>
                <div class="pricing-box"><span class="sale-price">₹ 475.00</span></div>
              </article>
              <article class="catalog-card">
                <h3 class="catalog-card-title"><a href="/store-b/item/arduino-nano">Arduino Nano V3 Board</a></h3>
                <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
              </article>
            </div>
          </div>
        </body>
        </html>
      `);
    });

    // ------------------------------------------------------------------------
    // TIP Adversarial Fixture: Missing ARIA Labels & Roles
    // ------------------------------------------------------------------------
    this.app.get("/store-b/missing-aria", (_req: Request, res: Response) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Plain HTML Store</title></head>
        <body>
          <!-- No aria-label, no role, no testid -->
          <input type="text" name="keyword" placeholder="Search maker parts..." />
          <section class="catalog-grid">
            <article class="catalog-card">
              <h3 class="catalog-card-title"><a href="/store-b/item/arduino-uno">Arduino Uno R3 Compatible Board</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 475.00</span></div>
            </article>
            <article class="catalog-card">
              <h3 class="catalog-card-title"><a href="/store-b/item/arduino-nano">Arduino Nano V3 Board</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
            </article>
          </section>
        </body>
        </html>
      `);
    });

    // ------------------------------------------------------------------------
    // TIP Adversarial Fixture: JSON-LD Price Mismatch
    // ------------------------------------------------------------------------
    this.app.get("/store-b/jsonld-mismatch", (_req: Request, res: Response) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>JSON-LD Mismatch Store</title>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org/",
            "@type": "Product",
            "name": "Arduino Uno R3 Compatible Board",
            "offers": {
              "@type": "Offer",
              "priceCurrency": "INR",
              "price": "999.00",
              "availability": "https://schema.org/InStock"
            }
          }
          </script>
        </head>
        <body>
          <input type="text" id="kw" name="keyword" placeholder="Search maker parts..." />
          <section class="catalog-grid">
            <article class="catalog-card">
              <h3 class="catalog-card-title"><a href="/store-b/item/arduino-uno">Arduino Uno R3 Compatible Board</a></h3>
              <div class="pricing-box">
                <!-- Visible price is ₹475, but JSON-LD says ₹999 -->
                <span class="sale-price">₹ 475.00</span>
              </div>
            </article>
            <article class="catalog-card">
              <h3 class="catalog-card-title"><a href="/store-b/item/arduino-nano">Arduino Nano V3 Board</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
            </article>
          </section>
        </body>
        </html>
      `);
    });

    // ------------------------------------------------------------------------
    // TIP Adversarial Fixture: Ambiguous Identical Controls
    // ------------------------------------------------------------------------
    this.app.get("/store-b/ambiguous-controls", (_req: Request, res: Response) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Ambiguous Controls Store</title></head>
        <body>
          <input type="text" name="keyword" placeholder="Search maker parts..." />
          <input type="text" name="keyword" placeholder="Search maker parts..." />
          <section class="catalog-grid">
            <article class="catalog-card">
              <h3 class="catalog-card-title"><a href="/store-b/item/arduino-uno">Arduino Uno R3 Compatible Board</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 475.00</span></div>
            </article>
            <article class="catalog-card">
              <h3 class="catalog-card-title"><a href="/store-b/item/arduino-nano">Arduino Nano V3 Board</a></h3>
              <div class="pricing-box"><span class="sale-price">₹ 260.00</span></div>
            </article>
          </section>
        </body>
        </html>
      `);
    });

    // ------------------------------------------------------------------------
    // Ambiguous Storefront (Duplicate search inputs)
    // ------------------------------------------------------------------------
    this.app.get("/store-duplicate", (_req: Request, res: Response) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Duplicate Controls Store</title></head>
        <body>
          <!-- Two identical inputs without differentiating attributes -->
          <input type="search" name="s" class="search-field" />
          <input type="search" name="s" class="search-field" />
        </body>
        </html>
      `);
    });

    // ------------------------------------------------------------------------
    // Blocked Storefront (HTTP 403 & Bot Challenge Content)
    // ------------------------------------------------------------------------
    this.app.get("/store-blocked", (_req: Request, res: Response) => {
      res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Access Denied | Cloudflare</title></head>
        <body>
          <h1>403 Forbidden</h1>
          <p>Checking your browser before accessing the site. CF-Browser-Verification.</p>
        </body>
        </html>
      `);
    });

    // ------------------------------------------------------------------------
    // Disallowed Domain Redirect
    // ------------------------------------------------------------------------
    this.app.get("/store-redirect", (_req: Request, res: Response) => {
      res.redirect("https://disallowed-malicious-domain.com/landing");
    });

    // ------------------------------------------------------------------------
    // DOM Mutation Toggle Endpoint
    // ------------------------------------------------------------------------
    this.app.post("/toggle-dom", (_req: Request, res: Response) => {
      this.domMutated = !this.domMutated;
      res.json({ domMutated: this.domMutated });
    });
  }

  async start(port: number = 0): Promise<string> {
    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        const address = this.server?.address() as any;
        this.port = address.port;
        resolve(`http://localhost:${this.port}`);
      });
    });
  }

  getApp(): express.Express {
    return this.app;
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((err) => (err ? reject(err) : resolve()));
      } else {
        resolve();
      }
    });
  }
}

