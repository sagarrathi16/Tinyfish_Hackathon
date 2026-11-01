import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { RunStatus } from "@tiny-fish/sdk";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import { RecoveryAgent, type RecoveryContext } from "../../src/agents/recovery.js";
import { TinyFishClient } from "../../src/agents/tinyfishClient.js";
import type { AgentTask, SiteAdapter } from "../../src/types/domain.js";

describe("Recovery Agent & Autonomous Self-Healing", () => {
  let db: ReturnType<typeof DatabaseConstructor>;
  let repo: Repository;
  let mockClient: TinyFishClient;
  let recoveryAgent: RecoveryAgent;

  const initialAdapter: SiteAdapter = {
    domain: "robu.in",
    adapterVersion: "1.0.0",
    status: "ACTIVE",
    locatorBindings: {
      SEARCH_INPUT: {
        semanticRole: "SEARCH_INPUT",
        locatorStrategy: "css",
        locatorValue: "input#old-search-bar",
        anchorEvidence: { text: "Search" },
        uniquenessExpectation: "SINGLE",
        provenance: "TINYFISH_EXPLORER",
        domain: "robu.in",
        version: "1.0.0",
      },
      PRODUCT_CARD: {
        semanticRole: "PRODUCT_CARD",
        locatorStrategy: "css",
        locatorValue: ".product-item",
        anchorEvidence: {},
        uniquenessExpectation: "MULTIPLE",
        provenance: "TINYFISH_EXPLORER",
        domain: "robu.in",
        version: "1.0.0",
      },
      PRODUCT_TITLE: {
        semanticRole: "PRODUCT_TITLE",
        locatorStrategy: "css",
        locatorValue: ".product-title",
        anchorEvidence: {},
        uniquenessExpectation: "SINGLE",
        provenance: "TINYFISH_EXPLORER",
        domain: "robu.in",
        version: "1.0.0",
      },
      PRODUCT_PRICE: {
        semanticRole: "PRODUCT_PRICE",
        locatorStrategy: "css",
        locatorValue: ".price",
        anchorEvidence: {},
        uniquenessExpectation: "SINGLE",
        provenance: "TINYFISH_EXPLORER",
        domain: "robu.in",
        version: "1.0.0",
      },
    },
    urlPatterns: {
      entryUrl: "https://robu.in",
    },
    evidence: {
      traceId: "initial-trace-123",
    },
    source: "agent",
    validationQueries: ["Arduino Uno", "Raspberry Pi"],
    validationResults: [],
    createdAt: new Date().toISOString(),
    promotedAt: new Date().toISOString(),
  };

  const sampleTask: AgentTask = {
    taskId: randomUUID(),
    jobId: randomUUID(),
    role: "RECOVERY",
    goal: "Recover broken SEARCH_INPUT binding",
    site: "robu.in",
    inputPayload: { query: "Arduino Uno" },
    status: "RUNNING",
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    db = new DatabaseConstructor(":memory:");
    initSchema(db);
    repo = new Repository(db);
    repo.saveSiteAdapter(initialAdapter);

    mockClient = new TinyFishClient();
    recoveryAgent = new RecoveryAgent(mockClient, repo);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("diagnoses BINDING_FAILED failure and synthesizes candidate adapter v1.1.0 with CANDIDATE status", async () => {
    const recoveryRunId = "tinyfish-recovery-run-999";
    vi.spyOn(mockClient, "runAutomation").mockResolvedValueOnce({
      runId: recoveryRunId,
      status: RunStatus.COMPLETED,
      durationMs: 2500,
      numOfSteps: 3,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: {
        repaired_binding: {
          semantic_role: "SEARCH_INPUT",
          repaired_selector: "input#repaired-search-v2",
          anchor_attribute: "Search products...",
          explanation: "Search input was wrapped in a new navigation container #repaired-search-v2",
        },
        verification_product: {
          title: "Arduino Uno R3 Compatible Board",
          price: "₹499.00",
          product_url: "https://robu.in/product/arduino-uno-r3",
        },
      },
    });

    const context: RecoveryContext = {
      task: sampleTask,
      activeAdapter: initialAdapter,
      failingBindingKey: "SEARCH_INPUT",
      failureDetails: {
        code: "BINDING_FAILED",
        message: "Search input not found with selector: input#old-search-bar",
        currentUrl: "https://robu.in",
      },
      query: "Arduino Uno",
    };

    const recoveryOutcome = await recoveryAgent.recoverBinding(context);

    // CRITICAL GUARDRAIL: Candidate must NOT be marked ACTIVE
    expect(recoveryOutcome.candidateAdapter.status).toBe("CANDIDATE");
    expect(recoveryOutcome.candidateAdapter.adapterVersion).toBe("1.1.0");
    expect(recoveryOutcome.recoveryRunId).toBe(recoveryRunId);

    // Verified repaired binding
    const repairedBinding = recoveryOutcome.candidateAdapter.locatorBindings.SEARCH_INPUT;
    expect(repairedBinding.locatorValue).toBe("input#repaired-search-v2");
    expect(repairedBinding.provenance).toBe("TINYFISH_RECOVERY");
    expect(repairedBinding.sourceRunId).toBe(recoveryRunId);
    expect(repairedBinding.version).toBe("1.1.0");

    // Untouched bindings must remain intact
    expect(recoveryOutcome.candidateAdapter.locatorBindings.PRODUCT_CARD.locatorValue).toBe(".product-item");
    expect(recoveryOutcome.candidateAdapter.locatorBindings.PRODUCT_CARD.version).toBe("1.0.0");
  });

  it("increments SemVer cleanly across multiple recovery cycles (1.1.0 -> 1.2.0)", async () => {
    const v11Adapter: SiteAdapter = {
      ...initialAdapter,
      adapterVersion: "1.1.0",
      status: "ACTIVE",
    };

    vi.spyOn(mockClient, "runAutomation").mockResolvedValueOnce({
      runId: "recovery-run-2",
      status: RunStatus.COMPLETED,
      durationMs: 2500,
      numOfSteps: 3,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: {
        repaired_binding: {
          semantic_role: "PRODUCT_CARD",
          repaired_selector: ".product-card-v3",
          anchor_attribute: "product-card",
          explanation: "Cards updated to v3 layout",
        },
        verification_product: {
          title: "Arduino Uno",
          price: "₹499",
          product_url: "https://robu.in/product/uno",
        },
      },
    });

    const context: RecoveryContext = {
      task: sampleTask,
      activeAdapter: v11Adapter,
      failingBindingKey: "PRODUCT_CARD",
      failureDetails: {
        code: "BINDING_FAILED",
        message: "Cards not found",
      },
      query: "Arduino Uno",
    };

    const outcome = await recoveryAgent.recoverBinding(context);
    expect(outcome.candidateAdapter.adapterVersion).toBe("1.2.0");
    expect(outcome.candidateAdapter.status).toBe("CANDIDATE");
  });

  it("persists RECOVERING and VALIDATING_CANDIDATE events into repository", async () => {
    vi.spyOn(mockClient, "runAutomation").mockResolvedValueOnce({
      runId: "recovery-run-persist",
      status: RunStatus.COMPLETED,
      durationMs: 2500,
      numOfSteps: 3,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: {
        repaired_binding: {
          semantic_role: "SEARCH_INPUT",
          repaired_selector: "input.search-v2",
          anchor_attribute: "Search",
          explanation: "Fixed selector",
        },
        verification_product: {
          title: "Arduino Uno",
          price: "₹499",
          product_url: "https://robu.in/product/uno",
        },
      },
    });

    const context: RecoveryContext = {
      task: sampleTask,
      activeAdapter: initialAdapter,
      failingBindingKey: "SEARCH_INPUT",
      failureDetails: {
        code: "BINDING_FAILED",
        message: "Old selector broke",
      },
      query: "Arduino Uno",
    };

    await recoveryAgent.recoverBinding(context);

    const events = repo.getEventsByJob(sampleTask.jobId);
    expect(events.length).toBe(2);

    const recoveringEvent = events.find((e) => e.state === "RECOVERING");
    expect(recoveringEvent).toBeDefined();
    expect(recoveringEvent?.agentRole).toBe("RECOVERY");

    const validatingEvent = events.find((e) => e.state === "VALIDATING_CANDIDATE");
    expect(validatingEvent).toBeDefined();
    expect((validatingEvent?.payloadSummary as Record<string, unknown>).candidateVersion).toBe("1.1.0");

    // Ensure candidate adapter is saved in repo as CANDIDATE
    const savedAdapter = repo.getSiteAdapter("robu.in", "1.1.0");
    expect(savedAdapter).toBeDefined();
    expect(savedAdapter?.status).toBe("CANDIDATE");
  });

  it("throws clear error and does not corrupt active adapter if TinyFish recovery fails", async () => {
    vi.spyOn(mockClient, "runAutomation").mockResolvedValueOnce({
      runId: "failed-recovery-run",
      status: RunStatus.FAILED,
      durationMs: 1500,
      numOfSteps: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: null,
      error: {
        code: "TIMEOUT",
        message: "Navigation timeout on destination",
      },
    });

    const context: RecoveryContext = {
      task: sampleTask,
      activeAdapter: initialAdapter,
      failingBindingKey: "SEARCH_INPUT",
      failureDetails: {
        code: "BINDING_FAILED",
        message: "Old selector broke",
      },
      query: "Arduino Uno",
    };

    await expect(recoveryAgent.recoverBinding(context)).rejects.toThrow(
      "TinyFish Recovery Agent failed to diagnose DOM mutation: Navigation timeout on destination"
    );

    // Active adapter in repo remains untouched and ACTIVE
    const active = repo.getActiveSiteAdapter("robu.in");
    expect(active?.adapterVersion).toBe("1.0.0");
    expect(active?.status).toBe("ACTIVE");
  });

  it("rejects empty repaired selectors from TinyFish", async () => {
    vi.spyOn(mockClient, "runAutomation").mockResolvedValueOnce({
      runId: "empty-selector-run",
      status: RunStatus.COMPLETED,
      durationMs: 2000,
      numOfSteps: 2,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: {
        repaired_binding: {
          semantic_role: "SEARCH_INPUT",
          repaired_selector: "   ", // Blank selector
          anchor_attribute: "",
          explanation: "could not find any selector",
        },
        verification_product: {
          title: "Test",
          price: "100",
          product_url: "https://robu.in/p",
        },
      },
    });

    const context: RecoveryContext = {
      task: sampleTask,
      activeAdapter: initialAdapter,
      failingBindingKey: "SEARCH_INPUT",
      failureDetails: {
        code: "BINDING_FAILED",
        message: "Old selector broke",
      },
      query: "Arduino Uno",
    };

    await expect(recoveryAgent.recoverBinding(context)).rejects.toThrow(
      "TinyFish Recovery Agent returned empty repaired selector"
    );
  });
});
