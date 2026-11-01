import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { ExplorerAgent, EXPLORER_OUTPUT_SCHEMA } from "../../src/agents/explorer.js";
import {
  TinyFishClient,
  type ProviderExecutionSummary,
} from "../../src/agents/tinyfishClient.js";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import type { AgentTask } from "../../src/types/domain.js";

describe("Explorer Agent & TinyFish Adapter Contract", () => {
  const createMockTask = (): AgentTask => ({
    taskId: randomUUID(),
    jobId: randomUUID(),
    role: "EXPLORER",
    goal: "Search and extract Arduino Uno on robu.in",
    site: "robu.in",
    inputPayload: { query: "Arduino Uno" },
    deadline: new Date(Date.now() + 60000).toISOString(),
    maxSteps: 15,
    budget: { maxSeconds: 60, maxUsd: 0.5 },
    correlationId: "test-corr-1",
  });

  const createMockSummary = (
    overrides?: Partial<ProviderExecutionSummary>
  ): ProviderExecutionSummary => ({
    runId: "tf_run_12345",
    status: "COMPLETED" as any,
    result: {
      product: {
        title: "Arduino Uno R3 Compatible Board",
        model_sku: "ROBU-ARD-001",
        numeric_price: 499,
        currency: "INR",
        product_url: "https://robu.in/product/arduino-uno-r3",
        evidence_url: "https://robu.in/product/arduino-uno-r3",
        retrieval_time: new Date().toISOString(),
        evidence_explanation: "Found product title in h1 element and price in .price bdi",
      },
      candidate_bindings: {
        search_input_selector: "input[name='s']",
        search_input_anchor: "placeholder='Search for products'",
        product_card_selector: ".product-grid-item",
        product_card_anchor: "role='article'",
        title_selector: ".product-title a",
        title_anchor: "exactText='Arduino Uno R3 Compatible Board'",
        price_selector: ".woocommerce-Price-amount bdi",
        price_anchor: "currency='₹'",
        evidence_explanation: "Semantic ARIA and class selectors verified on results page",
      },
    },
    numOfSteps: 7,
    durationMs: 12500,
    startedAt: new Date(Date.now() - 12500).toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  });

  it("complies with TinyFish schema keyword constraints", () => {
    // Top-level must be object
    expect(EXPLORER_OUTPUT_SCHEMA.type).toBe("object");
    expect(EXPLORER_OUTPUT_SCHEMA.required).toContain("product");
    expect(EXPLORER_OUTPUT_SCHEMA.required).toContain("candidate_bindings");

    // Must not contain forbidden keywords
    const schemaStr = JSON.stringify(EXPLORER_OUTPUT_SCHEMA);
    expect(schemaStr).not.toContain('"additionalProperties"');
    expect(schemaStr).not.toContain('"oneOf"');
  });

  it("normalizes a valid TinyFish extraction into AgentResult with SUCCESS status", async () => {
    const mockClient = {
      runAutomation: vi.fn().mockResolvedValue(createMockSummary()),
    } as unknown as TinyFishClient;

    const agent = new ExplorerAgent(mockClient);
    const task = createMockTask();

    const result = await agent.explore(task);

    expect(result.status).toBe("SUCCESS");
    expect(result.taskId).toBe(task.taskId);
    expect(result.providerRunIds.tinyFishRunId).toBe("tf_run_12345");
    expect(result.stepsUsage?.stepsCompleted).toBe(7);
    expect(result.evidenceReferences).toContain("https://robu.in/product/arduino-uno-r3");
    expect(result.errors).toHaveLength(0);
  });

  it("normalizes bot blocks or CAPTCHAs into BLOCKED status", async () => {
    const mockClient = {
      runAutomation: vi.fn().mockResolvedValue(
        createMockSummary({
          status: "FAILED" as any,
          result: null,
          error: {
            message: "Cloudflare challenge detected: access denied (403)",
            category: "AGENT_FAILURE",
          },
        })
      ),
    } as unknown as TinyFishClient;

    const agent = new ExplorerAgent(mockClient);
    const task = createMockTask();

    const result = await agent.explore(task);

    expect(result.status).toBe("BLOCKED");
    expect(result.errors[0]?.code).toBe("BOT_BLOCKED");
    expect(result.errors[0]?.message).toContain("Cloudflare");
  });

  it("normalizes incomplete or empty outputs into NEEDS_REVIEW status", async () => {
    const mockClient = {
      runAutomation: vi.fn().mockResolvedValue(
        createMockSummary({
          status: "COMPLETED" as any,
          result: {}, // Empty result
        })
      ),
    } as unknown as TinyFishClient;

    const agent = new ExplorerAgent(mockClient);
    const task = createMockTask();

    const result = await agent.explore(task);

    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.errors[0]?.code).toBe("EMPTY_RESULT");
  });

  it("persists exploration tasks, results, and events to SQLite repository", async () => {
    const db = new DatabaseConstructor(":memory:");
    initSchema(db);
    const repo = new Repository(db);

    const mockClient = {
      runAutomation: vi.fn().mockResolvedValue(createMockSummary()),
    } as unknown as TinyFishClient;

    const agent = new ExplorerAgent(mockClient, repo);
    const task = createMockTask();

    await agent.explore(task);

    // Verify task & result saved
    const run = repo.getRun(task.taskId);
    expect(run).not.toBeNull();
    expect(run?.task.taskId).toBe(task.taskId);
    expect(run?.result?.status).toBe("SUCCESS");

    // Verify run events emitted
    const events = repo.getEventsByJob(task.jobId);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.state).toBe("TEACHING");
    expect(events[1]?.state).toBe("COMPILING");
  });
});
