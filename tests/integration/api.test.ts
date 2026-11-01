import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import DatabaseConstructor from "better-sqlite3";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import { createServer } from "../../src/server.js";
import type { SiteAdapter, Skill } from "../../src/types/domain.js";
import { randomUUID } from "node:crypto";

describe("API Server Endpoints & Studio Telemetry", () => {
  let server: Server;
  let baseUrl: string;
  let db: ReturnType<typeof DatabaseConstructor>;
  let repo: Repository;

  beforeAll(async () => {
    db = new DatabaseConstructor(":memory:");
    initSchema(db);
    repo = new Repository(db);

    const app = createServer(repo);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    db.close();
  });

  it("serves system diagnostics and confirms safe environment boundaries", async () => {
    const res = await fetch(`${baseUrl}/api/diagnostics`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.environment).toBeDefined();
    expect(data.tinyFishKeyStatus).toContain("..."); // Proves secret redaction
    expect(data.allowedTargetDomains).toBeInstanceOf(Array);
    expect(data.domMutated).toBe(false);
  });

  it("serves skill, adapter, and event introspection endpoints", async () => {
    // Seed an active adapter and skill
    const adapter: SiteAdapter = {
      domain: "localhost",
      adapterVersion: "1.0.0",
      status: "ACTIVE",
      locatorBindings: {
        SEARCH_INPUT: {
          semanticRole: "SEARCH_INPUT",
          locatorStrategy: "css",
          locatorValue: "input[type='search']",
          anchorEvidence: {},
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "localhost",
          version: "1.0.0",
        },
        PRODUCT_CARD: {
          semanticRole: "PRODUCT_CARD",
          locatorStrategy: "css",
          locatorValue: ".product-grid-item",
          anchorEvidence: {},
          uniquenessExpectation: "MULTIPLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "localhost",
          version: "1.0.0",
        },
        PRODUCT_TITLE: {
          semanticRole: "PRODUCT_TITLE",
          locatorStrategy: "css",
          locatorValue: ".product-title a",
          anchorEvidence: {},
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "localhost",
          version: "1.0.0",
        },
        PRODUCT_PRICE: {
          semanticRole: "PRODUCT_PRICE",
          locatorStrategy: "css",
          locatorValue: ".woocommerce-Price-amount bdi",
          anchorEvidence: {},
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          domain: "localhost",
          version: "1.0.0",
        },
      },
      urlPatterns: { entryUrl: `${baseUrl}/store-a` },
      evidence: {},
      source: "agent",
      validationQueries: ["Arduino Uno"],
      validationResults: [],
      createdAt: new Date().toISOString(),
      promotedAt: new Date().toISOString(),
    };

    const skill: Skill = {
      id: randomUUID(),
      name: "Product Discovery",
      taskType: "PRODUCT_LOOKUP",
      version: "1.0.0",
      status: "ACTIVE",
      taskTemplate: [{ order: 1, stepName: "OPEN", description: "Open", postcondition: "Pass" }],
      outputSchema: {},
      postconditions: [],
      sourceRunIds: ["run-1"],
      tests: [],
      limitations: [],
      timestamps: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    };

    repo.saveSiteAdapter(adapter);
    repo.saveSkill(skill);

    const adapterRes = await fetch(`${baseUrl}/api/adapters?domain=localhost`);
    expect(adapterRes.status).toBe(200);
    const adapterData = await adapterRes.json();
    expect(adapterData.activeAdapter.adapterVersion).toBe("1.0.0");

    const skillRes = await fetch(`${baseUrl}/api/skills`);
    expect(skillRes.status).toBe(200);
    const skillData = await skillRes.json();
    expect(skillData.activeSkill.name).toBe("Product Discovery");
  });

  it("executes deterministic fast replay via POST /api/execute", async () => {
    const res = await fetch(`${baseUrl}/api/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "localhost",
        query: "Arduino Uno",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.status).toBe("SUCCESS");
    expect(data.finalState).toBe("DONE");
    expect(data.selfHealed).toBe(false);
    expect(data.agentCallsCount).toBe(0); // STRICT REPLAY PROOF: 0 TinyFish calls
    expect(data.product.title).toContain("Arduino Uno");
  });

  it("toggles DOM mutation on owned mock storefront via POST /api/demo/mutate-fixture", async () => {
    const res1 = await fetch(`${baseUrl}/api/demo/mutate-fixture`, { method: "POST" });
    const data1 = await res1.json();
    expect(data1.domMutated).toBe(true);

    const res2 = await fetch(`${baseUrl}/api/demo/mutate-fixture`, { method: "POST" });
    const data2 = await res2.json();
    expect(data2.domMutated).toBe(false);
  });

  it("computes benchmark summary and serves report via /api/benchmark/summary and /report", async () => {
    const sumRes = await fetch(`${baseUrl}/api/benchmark/summary`);
    expect(sumRes.status).toBe(200);
    const sumData = await sumRes.json();
    expect(sumData.totalTrials).toBeGreaterThanOrEqual(1);

    const repRes = await fetch(`${baseUrl}/api/benchmark/report`);
    expect(repRes.status).toBe(200);
    const repText = await repRes.text();
    expect(repText).toContain("ShadowTwin Measured Benchmark & Reliability Report");
  });

  it("resets demo storage cleanly via POST /api/demo/reset", async () => {
    const res = await fetch(`${baseUrl}/api/demo/reset`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("serves ShadowTwin Studio HTML with all 8 required panels", async () => {
    const res = await fetch(`${baseUrl}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();

    // Verify all 8 required judge-readable panels exist
    expect(html).toContain("ShadowTwin Studio");
    expect(html).toContain("1. Task Input");
    expect(html).toContain("Strict 12-State FSM");
    expect(html).toContain("3. Live Run Evidence");
    expect(html).toContain("4. Skill & Site Adapter Inspector");
    expect(html).toContain("5. Validator Worker (Deterministic Authority)");
    expect(html).toContain("6. Recovery Diff & Promotion Gate");
    expect(html).toContain("7. Measured Telemetry (M1–M7 Real Data)");
    expect(html).toContain("8. Interactive Demonstration Controls");

    // Verify read-only notice & keyboard accessible elements
    expect(html).toContain("Live 3rd-Party Actions Are Read-Only");
    expect(html).toContain("aria-label");
  });

  it("serves latest validation and recovery endpoints", async () => {
    const valRes = await fetch(`${baseUrl}/api/validation/latest`);
    expect(valRes.status).toBe(200);
    const valData = await valRes.json();
    expect(valData).toHaveProperty("validation");

    const recRes = await fetch(`${baseUrl}/api/recovery/latest`);
    expect(recRes.status).toBe(200);
    const recData = await recRes.json();
    expect(recData).toHaveProperty("recoveryTrace");
  });

  it("handles conversational multi-agent task execution and returns cost savings via POST /api/chat/task", async () => {
    const res = await fetch(`${baseUrl}/api/chat/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Find books on books.toscrape.com and compare with webscraper.io",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("SUCCESS");
    expect(data.parsedTask.primaryDomain).toBe("books.toscrape.com");
    expect(data.transferredSites).toContain("webscraper.io");
    expect(data.products.length).toBeGreaterThanOrEqual(2);
    expect(data.costSavings.savingsPercentage).toBeGreaterThanOrEqual(1);
  });
});
