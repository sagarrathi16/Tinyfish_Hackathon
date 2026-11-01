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
      const priceClass = this.domMutated ? "mutated-cost-val" : "woocommerce-Price-amount";

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

