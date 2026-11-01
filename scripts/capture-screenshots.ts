import { chromium } from "playwright";
import DatabaseConstructor from "better-sqlite3";
import { initSchema } from "../src/persistence/database.js";
import { Repository } from "../src/persistence/repository.js";
import { createServer } from "../src/server.js";
import { seedCleanDemo } from "../src/benchmark/demoSeed.js";
import path from "node:path";
import type { Server } from "node:http";

async function main() {
  console.log("================================================================================");
  console.log("  ShadowTwin — Neural Mission Control Automated Visual Verification");
  console.log("================================================================================");

  // 1. Initialize server with in-memory SQLite
  const db = new DatabaseConstructor(":memory:");
  initSchema(db);
  const repo = new Repository(db);
  const app = createServer(repo);

  let baseUrl = "";
  let server: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as any;
      baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  seedCleanDemo(repo, baseUrl);
  console.log(`Server running at ${baseUrl}`);
  const outDir = path.resolve(process.cwd(), "docs", "screenshots");

  // 2. Launch headless Chromium
  const browser = await chromium.launch({ headless: true });

  try {
    // -------------------------------------------------------------------------
    // Viewport 1: 1440px Desktop (Flagship Mission Control)
    // -------------------------------------------------------------------------
    console.log("Capturing 1440px Desktop screens...");
    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await desktopContext.newPage();
    await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    // Screen 1: Flagship AI Agent Chat & Live Browser Simulation
    await page.screenshot({
      path: path.join(outDir, "01-agent-chat-and-live-browser-1440.png"),
      fullPage: false,
    });
    console.log("  - 01-agent-chat-and-live-browser-1440.png saved");

    // Screen 2: Neural Mission Control Graph & Inspector Drawer
    await page.click("button[data-screen='mission']");
    await page.waitForTimeout(300);
    await page.click("#node-orchestrator");
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(outDir, "02-agent-inspector-drawer-1440.png"),
      fullPage: false,
    });
    console.log("  - 02-agent-inspector-drawer-1440.png saved");

    // Close drawer
    await page.click(".inspector-header button");
    await page.waitForTimeout(200);

    // Screen D: Execution Lab
    await page.click("button[data-screen='lab']");
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(outDir, "03-execution-lab-1440.png"),
      fullPage: false,
    });
    console.log("  - 03-execution-lab-1440.png saved");

    // Screen C: Skill Memory Registry
    await page.click("button[data-screen='memory']");
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(outDir, "04-skill-memory-1440.png"),
      fullPage: false,
    });
    console.log("  - 04-skill-memory-1440.png saved");

    // Screen E: Benchmark Observatory
    await page.click("button[data-screen='benchmark']");
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(outDir, "05-benchmark-observatory-1440.png"),
      fullPage: false,
    });
    console.log("  - 05-benchmark-observatory-1440.png saved");

    await desktopContext.close();

    // -------------------------------------------------------------------------
    // Viewport 2: 1280px Laptop
    // -------------------------------------------------------------------------
    console.log("Capturing 1280px Laptop screen...");
    const laptopContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    const laptopPage = await laptopContext.newPage();
    await laptopPage.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
    await laptopPage.waitForTimeout(500);
    await laptopPage.screenshot({
      path: path.join(outDir, "06-laptop-1280.png"),
      fullPage: false,
    });
    console.log("  - 06-laptop-1280.png saved");
    await laptopContext.close();

    // -------------------------------------------------------------------------
    // Viewport 3: 768px Tablet
    // -------------------------------------------------------------------------
    console.log("Capturing 768px Tablet screen...");
    const tabletContext = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      deviceScaleFactor: 2,
    });
    const tabletPage = await tabletContext.newPage();
    await tabletPage.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
    await tabletPage.waitForTimeout(500);
    await tabletPage.screenshot({
      path: path.join(outDir, "07-tablet-768.png"),
      fullPage: false,
    });
    console.log("  - 07-tablet-768.png saved");
    await tabletContext.close();

    // -------------------------------------------------------------------------
    // Viewport 4: 375px Mobile
    // -------------------------------------------------------------------------
    console.log("Capturing 375px Mobile screen...");
    const mobileContext = await browser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
    await mobilePage.waitForTimeout(500);
    await mobilePage.screenshot({
      path: path.join(outDir, "08-mobile-375.png"),
      fullPage: false,
    });
    console.log("  - 08-mobile-375.png saved");
    await mobileContext.close();

    console.log("\nAll 8 screenshots successfully captured into docs/screenshots/!");
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

main().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
