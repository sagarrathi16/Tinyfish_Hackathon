import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import { ValidatorWorker } from "../../src/validator/validatorWorker.js";
import { IdentityChecker } from "../../src/validator/identityCheck.js";
import type { AgentResult, AgentTask, SiteAdapter } from "../../src/types/domain.js";

describe("Validator Worker & Deterministic Verification", () => {
  let db: ReturnType<typeof DatabaseConstructor>;
  let repo: Repository;
  let validator: ValidatorWorker;

  const validTask: AgentTask = {
    taskId: randomUUID(),
    jobId: randomUUID(),
    role: "EXECUTOR",
    goal: "Search for Arduino Uno",
    site: "robu.in",
    inputPayload: { query: "Arduino Uno" },
    status: "COMPLETED",
    createdAt: new Date().toISOString(),
  };

  const validAdapter: SiteAdapter = {
    domain: "robu.in",
    adapterVersion: "1.0.0",
    status: "CANDIDATE",
    locatorBindings: {
      OPEN: {
        semanticRole: "PAGE_ROOT",
        locatorStrategy: "css",
        locatorValue: "body",
        anchorEvidence: {},
        uniquenessExpectation: "SINGLE",
        provenance: "TINYFISH_EXPLORER",
        domain: "robu.in",
        version: "1.0.0",
      },
      SEARCH: {
        semanticRole: "SEARCH_INPUT",
        locatorStrategy: "css",
        locatorValue: "input[type='search']",
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
    evidence: {},
    source: "agent",
    validationQueries: [],
    validationResults: [],
    createdAt: new Date().toISOString(),
  };

  const validExecutionResult: AgentResult = {
    taskId: validTask.taskId,
    jobId: validTask.jobId,
    status: "SUCCESS",
    structuredOutput: {
      title: "Arduino Uno R3 Compatible Development Board",
      numericPrice: 499,
      currency: "₹",
      price: "₹499.00",
      productUrl: "https://robu.in/product/arduino-uno-r3",
      retrievalTime: new Date().toISOString(),
    },
    evidenceReferences: ["https://robu.in/product/arduino-uno-r3"],
    providerRunIds: {},
    stepsUsage: { stepsCompleted: 5 },
    durationMs: 1200,
    errors: [],
    warnings: [],
  };

  beforeEach(() => {
    db = new DatabaseConstructor(":memory:");
    initSchema(db);
    repo = new Repository(db);
    validator = new ValidatorWorker(repo);
  });

  afterEach(() => {
    db.close();
  });

  describe("Product Identity Matching", () => {
    it("verifies accurate product title match for query", () => {
      const match = IdentityChecker.verify("Arduino Uno", "Original Arduino Uno Rev3 SMD Board");
      expect(match.match).toBe(true);
      expect(match.score).toBeGreaterThanOrEqual(0.8);
      expect(match.isAccessory).toBe(false);
    });

    it("detects and rejects accessory products (e.g. cable for arduino)", () => {
      const match = IdentityChecker.verify("Arduino Uno", "USB Cable for Arduino Uno R3");
      expect(match.match).toBe(false);
      expect(match.isAccessory).toBe(true);
      expect(match.reason).toContain("accessory");
    });

    it("detects and rejects replacement straps for smart watches", () => {
      const match = IdentityChecker.verify("Smart Watch", "Silicone Replacement Strap for Smart Watch");
      expect(match.match).toBe(false);
      expect(match.isAccessory).toBe(true);
    });

    it("allows accessory if user explicitly asked for one", () => {
      const match = IdentityChecker.verify("Arduino USB Cable", "High Quality USB Cable for Arduino");
      expect(match.match).toBe(true);
      expect(match.isAccessory).toBe(false);
    });

    it("rejects completely unrelated product titles", () => {
      const match = IdentityChecker.verify("Raspberry Pi 5", "Arduino Uno Rev3 Board");
      expect(match.match).toBe(false);
      expect(match.score).toBeLessThan(0.3);
    });
  });

  describe("Deterministic Validation Checks", () => {
    it("approves a completely valid replay execution as PASS", () => {
      const val = validator.validateResult(validTask, validExecutionResult, validAdapter);
      expect(val.status).toBe("PASS");
      expect(val.failureCategory).toBe("NONE");
      expect(val.checks.schemaValid).toBe(true);
      expect(val.checks.productIdentityMatch).toBe(true);
      expect(val.checks.priceParsedINR).toBe(true);
      expect(val.checks.domainAuthorized).toBe(true);
      expect(val.checks.freshnessValid).toBe(true);
      expect(val.checks.stepPostconditions.every((s) => s.passed)).toBe(true);
    });

    it("preserves deterministic authority when an optional critique model gives advice", () => {
      // Create a result with a binding failure
      const brokenResult: AgentResult = {
        ...validExecutionResult,
        status: "STUCK",
        errors: [{ code: "BINDING_FAILED", message: "Step SEARCH failed: Missing search input" }],
      };

      const critiqueDiagnostic = {
        summary: "The site layout changed its header structure.",
        recommendedAction: "Invoke TinyFish Recovery Agent.",
      };

      const val = validator.validateResult(validTask, brokenResult, validAdapter, critiqueDiagnostic);

      // Must be FAIL, cannot be overridden
      expect(val.status).toBe("FAIL");
      expect(val.failureCategory).toBe("BINDING_FAILED");
    });

    it("flags product identity mismatch as NEEDS_REVIEW", () => {
      const accessoryResult: AgentResult = {
        ...validExecutionResult,
        structuredOutput: {
          ...validExecutionResult.structuredOutput,
          title: "Protective Silicone Case and Stand for Arduino Uno",
        },
      };

      const val = validator.validateResult(validTask, accessoryResult, validAdapter);
      expect(val.status).toBe("NEEDS_REVIEW");
      expect(val.failureCategory).toBe("MISMATCH");
      expect(val.checks.productIdentityMatch).toBe(false);
    });

    it("flags invalid or missing numeric price as PRICE_ERROR or SCHEMA_ERROR", () => {
      const badPriceResult: AgentResult = {
        ...validExecutionResult,
        structuredOutput: {
          ...validExecutionResult.structuredOutput,
          numericPrice: -50, // Negative price invalid
        },
      };

      const val = validator.validateResult(validTask, badPriceResult, validAdapter);
      expect(val.status).toBe("FAIL");
      expect(["PRICE_ERROR", "SCHEMA_ERROR"]).toContain(val.failureCategory);
      expect(val.checks.priceParsedINR).toBe(false);
    });

    it("flags stale timestamp as SCHEMA_ERROR", () => {
      const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48 hours ago
      const staleResult: AgentResult = {
        ...validExecutionResult,
        structuredOutput: {
          ...validExecutionResult.structuredOutput,
          retrievalTime: staleDate,
        },
      };

      const val = validator.validateResult(validTask, staleResult, validAdapter);
      expect(val.status).toBe("FAIL");
      expect(val.checks.freshnessValid).toBe(false);
    });

    it("flags bot block or unauthorized domain as BLOCKED", () => {
      const blockedResult: AgentResult = {
        ...validExecutionResult,
        status: "BLOCKED",
        errors: [{ code: "BOT_DETECTED", message: "Cloudflare Turnstile challenge presented" }],
      };

      const val = validator.validateResult(validTask, blockedResult, validAdapter);
      expect(val.status).toBe("BLOCKED");
      expect(val.failureCategory).toBe("BLOCKED");
    });

    it("persists validation event and details to SQLite repository", () => {
      const val = validator.validateResult(validTask, validExecutionResult, validAdapter);
      const events = repo.getEventsByJob(validTask.jobId);
      expect(events.length).toBeGreaterThanOrEqual(1);

      const valEvent = events.find((e) => e.agentRole === "VALIDATOR");
      expect(valEvent).toBeDefined();
      expect(valEvent?.site).toBe("robu.in");
      expect((valEvent?.payloadSummary as Record<string, unknown>).validationId).toBe(val.validationId);
    });
  });

  describe("Candidate Promotion Gate (2-Query Gate)", () => {
    it("rejects promotion if fewer than two distinct queries are provided", () => {
      const valResult1 = validator.validateResult(validTask, validExecutionResult, validAdapter);

      const decision = validator.validateCandidateForPromotion(validAdapter, [
        { query: "Arduino Uno", result: valResult1 },
      ]);

      expect(decision.eligible).toBe(false);
      expect(decision.reason).toContain("Requires at least 2 distinct queries");
    });

    it("rejects promotion if queries are duplicates of each other", () => {
      const valResult1 = validator.validateResult(validTask, validExecutionResult, validAdapter);

      const decision = validator.validateCandidateForPromotion(validAdapter, [
        { query: "Arduino Uno", result: valResult1 },
        { query: "arduino uno", result: valResult1 }, // Duplicate case-insensitive
      ]);

      expect(decision.eligible).toBe(false);
      expect(decision.reason).toContain("only 1 provided");
    });

    it("rejects promotion if any of the distinct query validations failed", () => {
      const valResult1 = validator.validateResult(validTask, validExecutionResult, validAdapter);

      const brokenResult: AgentResult = {
        ...validExecutionResult,
        status: "STUCK",
        errors: [{ code: "BINDING_FAILED", message: "Step SEARCH failed" }],
      };
      const valResult2 = validator.validateResult(
        { ...validTask, taskId: randomUUID(), inputPayload: { query: "ESP32" } },
        brokenResult,
        validAdapter
      );

      const decision = validator.validateCandidateForPromotion(validAdapter, [
        { query: "Arduino Uno", result: valResult1 },
        { query: "ESP32 NodeMCU", result: valResult2 },
      ]);

      expect(decision.eligible).toBe(false);
      expect(decision.reason).toContain("1 query validations failed");
    });

    it("approves promotion when at least two distinct queries pass validation", () => {
      const valResult1 = validator.validateResult(validTask, validExecutionResult, validAdapter);

      const query2Task: AgentTask = {
        ...validTask,
        taskId: randomUUID(),
        inputPayload: { query: "ESP32 Board" },
      };
      const result2: AgentResult = {
        ...validExecutionResult,
        taskId: query2Task.taskId,
        structuredOutput: {
          title: "ESP32 DevKit V1 Development Board",
          numericPrice: 350,
          currency: "₹",
          productUrl: "https://robu.in/product/esp32-devkit",
          retrievalTime: new Date().toISOString(),
        },
      };
      const valResult2 = validator.validateResult(query2Task, result2, validAdapter);

      const decision = validator.validateCandidateForPromotion(validAdapter, [
        { query: "Arduino Uno", result: valResult1 },
        { query: "ESP32 Board", result: valResult2 },
      ]);

      expect(decision.eligible).toBe(true);
      expect(decision.reason).toContain("Promotion gate passed");
    });
  });
});
