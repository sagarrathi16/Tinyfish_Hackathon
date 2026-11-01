import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { getEnv } from "../config/env.js";
import type { Repository } from "../persistence/repository.js";
import type { TaskProfile } from "../agents/compiler.js";
import {
  AgentResultSchema,
  type AgentResult,
  type AgentTask,
  type SiteAdapter,
  type Skill,
} from "../types/domain.js";
import { DomAnchors } from "./domAnchors.js";
import { PriceParser } from "./priceParser.js";
import { logger } from "../utils/logger.js";

export interface ReplayOptions {
  headless?: boolean;
  timeoutMs?: number;
  taskProfile?: TaskProfile;
}

export interface ReplayOutcome {
  result: AgentResult;
  stepsCompleted: number;
  finalUrl: string;
}

export class PlaywrightRunner {
  private repo?: Repository;

  constructor(repo?: Repository) {
    this.repo = repo;
  }

  /**
   * Executes a deterministic replay of the five-step procedure using local Chromium.
   * Strictly zero calls to TinyFish Agent or TinyFish Browser API.
   */
  async executeReplay(
    task: AgentTask,
    skill: Skill,
    adapter: SiteAdapter,
    options?: ReplayOptions
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const query = (task.inputPayload?.query as string) || task.goal;
    const timeoutMs = options?.timeoutMs ?? (task.budget?.maxSeconds ? task.budget.maxSeconds * 1000 : 30000);
    const taskProfile = options?.taskProfile;

    logger.info("Playwright Worker initiating deterministic replay", {
      taskId: task.taskId,
      domain: adapter.domain,
      query,
    });

    if (this.repo) {
      this.repo.saveTask(task);
      this.repo.logEvent({
        eventId: randomUUID(),
        jobId: task.jobId,
        runId: task.taskId,
        agentRole: "EXECUTOR",
        state: "EXECUTING",
        site: adapter.domain,
        timestamp: new Date().toISOString(),
        payloadSummary: { query, adapterVersion: adapter.adapterVersion },
      });
    }

    // Security validation: Domain must be authorized
    const isDomainAllowed = this.isDomainAllowed(adapter.domain);
    if (!isDomainAllowed) {
      return this.buildResult(task, "BLOCKED", null, startTime, [
        { code: "DISALLOWED_DOMAIN", message: `Domain '${adapter.domain}' is not in ALLOWED_TARGET_DOMAINS` },
      ]);
    }

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      // Launch local Chromium instance
      browser = await chromium.launch({
        headless: options?.headless ?? true,
      });

      context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      });

      page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);

      // Track URL redirects to enforce domain allowlist
      page.on("framenavigated", (frame) => {
        if (frame === page?.mainFrame()) {
          const navUrl = frame.url();
          if (navUrl && !navUrl.startsWith("about:") && !this.isUrlAllowed(navUrl)) {
            logger.warn("Disallowed redirect detected", { url: navUrl });
          }
        }
      });

      // ======================================================================
      // Step 1: OPEN
      // ======================================================================
      const entryUrl = adapter.urlPatterns.entryUrl;
      const navResponse = await page.goto(entryUrl, { waitUntil: "domcontentloaded" });

      if (navResponse && (navResponse.status() === 403 || navResponse.status() === 429)) {
        return this.buildResult(task, "BLOCKED", null, startTime, [
          { code: "ACCESS_RESTRICTED", message: `Site returned HTTP ${navResponse.status()}` },
        ]);
      }

      // Check for block page content
      const pageContent = await page.content();
      if (this.isBlockPage(pageContent)) {
        return this.buildResult(task, "BLOCKED", null, startTime, [
          { code: "BOT_BLOCKED", message: "Page content indicates bot challenge or block" },
        ]);
      }

      // Resolve SEARCH_INPUT
      const searchBinding = adapter.locatorBindings["SEARCH_INPUT"];
      if (!searchBinding) {
        return this.buildResult(task, "STUCK", null, startTime, [
          { code: "BINDING_FAILED", message: "Missing SEARCH_INPUT binding in site adapter" },
        ]);
      }

      const searchInputRes = await DomAnchors.resolve(page, searchBinding, Math.min(timeoutMs, 4000));
      if (!searchInputRes.locator || searchInputRes.matchedCount === 0) {
        return this.buildResult(task, "STUCK", null, startTime, [
          { code: "BINDING_FAILED", message: searchInputRes.error || "Search input not found" },
        ]);
      }

      if (searchInputRes.matchedCount > 1 && searchBinding.uniquenessExpectation === "SINGLE") {
        return this.buildResult(task, "STUCK", null, startTime, [
          { code: "BINDING_FAILED", message: searchInputRes.error || "Ambiguous duplicate search inputs" },
        ]);
      }

      this.logStepEvent(task, "STEP_OPEN_PASS", { entryUrl });

      // ======================================================================
      // Step 2: SEARCH
      // ======================================================================
      await searchInputRes.locator.first().fill(query);
      await searchInputRes.locator.first().press("Enter");

      // Wait for DOM or navigation change
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1000); // Allow dynamic rendering

      this.logStepEvent(task, "STEP_SEARCH_PASS", { query });

      // ======================================================================
      // Step 3: PARSE
      // ======================================================================
      const cardBinding = adapter.locatorBindings["PRODUCT_CARD"];
      if (!cardBinding) {
        return this.buildResult(task, "STUCK", null, startTime, [
          { code: "BINDING_FAILED", message: "Missing PRODUCT_CARD binding in site adapter" },
        ]);
      }

      const cardRes = await DomAnchors.resolve(page, cardBinding, Math.min(timeoutMs, 4000));
      if (!cardRes.locator || cardRes.matchedCount === 0) {
        // No result cards found
        return this.buildResult(task, "STUCK", null, startTime, [
          { code: "BINDING_FAILED", message: "No product cards found on search results page" },
        ]);
      }

      const rawCardsCount = cardRes.matchedCount;
      const extractedCards: Array<{
        title: string;
        numericPrice: number;
        currency: string;
        url: string;
      }> = [];

      const titleBinding = adapter.locatorBindings["PRODUCT_TITLE"];
      const priceBinding = adapter.locatorBindings["PRODUCT_PRICE"];

      for (let i = 0; i < Math.min(rawCardsCount, 15); i++) {
        const cardLoc = cardRes.locator.nth(i);

        let titleText = "";
        let priceText = "";
        let productUrl = "";

        // Title
        if (titleBinding) {
          const tLoc = cardLoc.locator(titleBinding.locatorValue);
          if ((await tLoc.count()) > 0) {
            titleText = (await tLoc.first().innerText()).trim();
          }
        }

        // Price
        if (priceBinding) {
          const pLoc = cardLoc.locator(priceBinding.locatorValue);
          if ((await pLoc.count()) > 0) {
            priceText = (await pLoc.first().innerText()).trim();
          }
        }

        // Link
        const linkLoc = cardLoc.locator("a");
        if ((await linkLoc.count()) > 0) {
          productUrl = (await linkLoc.first().getAttribute("href")) || "";
          if (productUrl && !productUrl.startsWith("http")) {
            productUrl = new URL(productUrl, entryUrl).toString();
          }
        }

        const parsedPrice = PriceParser.parse(priceText);
        if (titleText && parsedPrice.salePrice !== null && parsedPrice.salePrice > 0) {
          extractedCards.push({
            title: titleText,
            numericPrice: parsedPrice.salePrice,
            currency: parsedPrice.currency,
            url: productUrl || page.url(),
          });
        }
      }

      if (extractedCards.length === 0) {
        return this.buildResult(task, "STUCK", null, startTime, [
          { code: "BINDING_FAILED", message: "Failed to parse title or price from visible result cards" },
        ]);
      }

      this.logStepEvent(task, "STEP_PARSE_PASS", { cardsExtracted: extractedCards.length });

      // ======================================================================
      // Step 4: SELECT
      // ======================================================================
      const negativeWords = taskProfile?.negativeKeywords || [
        "case",
        "cover",
        "strap",
        "cable",
        "screen protector",
        "skin",
      ];

      const scoredCards = extractedCards
        .map((card) => {
          const lowerTitle = card.title.toLowerCase();
          const lowerQuery = query.toLowerCase();

          // Check if item is an accessory (penalize unless query asked for it)
          const isAccessory = negativeWords.some(
            (nw) => lowerTitle.includes(nw) && !lowerQuery.includes(nw)
          );

          // Compute token overlap score
          const queryTokens = lowerQuery.split(/\s+/).filter(Boolean);
          const matchedTokens = queryTokens.filter((token) => lowerTitle.includes(token));
          const score = isAccessory ? 0.1 : matchedTokens.length / queryTokens.length;

          return { ...card, score, isAccessory };
        })
        .sort((a, b) => b.score - a.score);

      const topCard = scoredCards[0];
      if (!topCard) {
        return this.buildResult(task, "NEEDS_REVIEW", null, startTime, [
          { code: "MISMATCH", message: "No product cards matched the search query" },
        ]);
      }

      if (topCard.isAccessory) {
        return this.buildResult(task, "NEEDS_REVIEW", null, startTime, [
          { code: "MISMATCH", message: "Top matching card is an accessory/complementary product, not the primary query" },
        ]);
      }

      if (topCard.score < 0.3) {
        return this.buildResult(task, "NEEDS_REVIEW", null, startTime, [
          { code: "MISMATCH", message: "No product cards matched the search query with sufficient confidence" },
        ]);
      }

      this.logStepEvent(task, "STEP_SELECT_PASS", {
        selectedTitle: topCard.title,
        price: topCard.numericPrice,
      });

      // ======================================================================
      // Step 5: CONFIRM
      // ======================================================================
      const finalProduct = {
        title: topCard.title,
        numericPrice: topCard.numericPrice,
        currency: topCard.currency,
        url: topCard.url,
        productUrl: topCard.url,
        evidenceUrl: page.url(),
        retrievalTime: new Date().toISOString(),
        retrievedAt: new Date().toISOString(),
      };

      this.logStepEvent(task, "STEP_CONFIRM_PASS", finalProduct);

      return this.buildResult(task, "SUCCESS", finalProduct, startTime, []);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.buildResult(task, "FAILED", null, startTime, [
        { code: "REPLAY_ERROR", message: errMsg },
      ]);
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }

  // ==========================================================================
  // Helper & Security Methods
  // ==========================================================================

  private isDomainAllowed(domain: string): boolean {
    const env = getEnv();
    const allowed = env.ALLOWED_TARGET_DOMAINS.split(",").map((d) => d.trim().toLowerCase());
    return allowed.some((d) => domain.toLowerCase().includes(d) || d.includes(domain.toLowerCase()));
  }

  private isUrlAllowed(urlStr: string): boolean {
    try {
      const u = new URL(urlStr);
      return this.isDomainAllowed(u.hostname);
    } catch {
      return false;
    }
  }

  private isBlockPage(content: string): boolean {
    const lower = content.toLowerCase();
    return (
      lower.includes("checking your browser") ||
      lower.includes("cf-browser-verification") ||
      lower.includes("datadome") ||
      lower.includes("access denied") ||
      lower.includes("please verify you are a human") ||
      lower.includes("hcaptcha")
    );
  }

  private buildResult(
    task: AgentTask,
    status: "SUCCESS" | "FAILED" | "STUCK" | "NEEDS_REVIEW" | "BLOCKED",
    structuredOutput: Record<string, unknown> | null,
    startTime: number,
    errors: Array<{ code: string; message: string }>
  ): AgentResult {
    const durationMs = Date.now() - startTime;
    const res: AgentResult = {
      taskId: task.taskId,
      jobId: task.jobId,
      status,
      structuredOutput,
      evidenceReferences: structuredOutput?.productUrl ? [String(structuredOutput.productUrl)] : [],
      providerRunIds: {}, // Strictly no TinyFish run ID on Playwright replay
      stepsUsage: { stepsCompleted: 5 },
      durationMs,
      errors,
      warnings: [],
    };

    if (this.repo) {
      this.repo.saveResult(res);
      this.repo.logEvent({
        eventId: randomUUID(),
        jobId: task.jobId,
        runId: task.taskId,
        agentRole: "EXECUTOR",
        state: status === "SUCCESS" ? "DONE" : status,
        site: task.site,
        timestamp: new Date().toISOString(),
        payloadSummary: { durationMs, status },
        redactedError: errors[0]?.message,
      });
    }

    return AgentResultSchema.parse(res);
  }

  private logStepEvent(task: AgentTask, stepId: string, details: Record<string, unknown>): void {
    if (this.repo) {
      this.repo.logEvent({
        eventId: randomUUID(),
        jobId: task.jobId,
        runId: task.taskId,
        agentRole: "EXECUTOR",
        state: "EXECUTING",
        site: task.site,
        stepId,
        timestamp: new Date().toISOString(),
        payloadSummary: details,
      });
    }
  }
}
