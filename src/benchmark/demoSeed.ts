import { randomUUID } from "node:crypto";
import { type Repository } from "../persistence/repository.js";
import {
  type Skill,
  type SiteAdapter,
  type BenchmarkRecord,
} from "../types/domain.js";
import { logger } from "../utils/logger.js";

/**
 * Seeds a clean, presentation-ready demo state into the SQLite database.
 * Safety Guarantee: ONLY resets database tables; NEVER touches .env, source files, or credentials.
 */
export function seedCleanDemo(
  repo: Repository,
  baseUrl: string = "http://localhost:3000"
): {
  success: boolean;
  seededAt: string;
  activeSkillId: string;
  storeAAdapterVersion: string;
  storeBAdapterVersion: string;
  baselineTrialCount: number;
} {
  logger.info("Executing clean demo state seed...");

  // 1. Clean reset of demo storage tables (Never touches .env, configs, or source code)
  repo.resetDemoStorage();

  const now = new Date().toISOString();
  const skillId = randomUUID();

  // 2. Seed Store A & Universal Task Template Skill (Status: ACTIVE)
  const universalSkill: Skill = {
    id: skillId,
    name: "Product Discovery",
    taskType: "PRODUCT_LOOKUP",
    version: "1.0.0",
    status: "ACTIVE",
    taskTemplate: [
      { order: 1, stepName: "OPEN", description: "Navigate to canonical storefront entry URL", postcondition: "PAGE_LOADED" },
      { order: 2, stepName: "SEARCH", description: "Fill unique search input and submit query", postcondition: "SEARCH_SUBMITTED" },
      { order: 3, stepName: "PARSE", description: "Extract product listing cards from search results", postcondition: "CARDS_EXTRACTED" },
      { order: 4, stepName: "SELECT", description: "Apply category policy: select primary item, filter accessories", postcondition: "PRODUCT_SELECTED" },
      { order: 5, stepName: "CONFIRM", description: "Extract numeric price, title, and canonical product URL", postcondition: "DETAILS_CONFIRMED" },
    ],
    outputSchema: {
      title: "string",
      numericPrice: "number",
      currency: "string",
      url: "string",
      retrievedAt: "string",
    },
    postconditions: [
      { name: "SCHEMA_VALID", rule: "All required output fields present", required: true },
      { name: "PRICE_PARSED_INR", rule: "Price parsed with valid currency and numeric value", required: true },
      { name: "PRODUCT_IDENTITY_MATCH", rule: "Extracted item matches search intent; accessories rejected", required: true },
      { name: "DOMAIN_AUTHORIZED", rule: "Final URL resides on approved target domain", required: true },
      { name: "FRESHNESS_VALID", rule: "Data retrieved at runtime, never reused from teach run", required: true },
    ],
    sourceRunIds: ["seed-teach-run-store-a"],
    tests: [
      { query: "Arduino Uno", expectedFields: ["title", "numericPrice", "currency", "url"] },
      { query: "ESP32", expectedFields: ["title", "numericPrice", "currency", "url"] },
    ],
    limitations: [
      "Read-only product lookup; no add-to-cart or checkout writes",
      "Requires unique search box control",
    ],
    timestamps: {
      createdAt: now,
      updatedAt: now,
      promotedAt: now,
    },
  };

  repo.saveSkill(universalSkill);

  // 3. Seed Store A Active Site Adapter (Status: ACTIVE)
  const storeAAdapter: SiteAdapter = {
    domain: "localhost",
    adapterVersion: "1.0.0",
    status: "ACTIVE",
    locatorBindings: {
      SEARCH_INPUT: {
        semanticRole: "SEARCH_INPUT",
        locatorStrategy: "css",
        locatorValue: "input[name='s']",
        anchorEvidence: { placeholder: "Search products...", role: "searchbox" },
        uniquenessExpectation: "SINGLE",
        provenance: "TINYFISH_EXPLORER",
        sourceRunId: "seed-explorer-run-1",
        domain: "localhost",
        version: "1.0.0",
      },
      PRODUCT_CARD: {
        semanticRole: "PRODUCT_CARD",
        locatorStrategy: "css",
        locatorValue: ".product-grid-item",
        anchorEvidence: { role: "article", nearbyStructure: "Repeated card container" },
        uniquenessExpectation: "MULTIPLE",
        provenance: "TINYFISH_EXPLORER",
        sourceRunId: "seed-explorer-run-1",
        domain: "localhost",
        version: "1.0.0",
      },
      PRODUCT_TITLE: {
        semanticRole: "PRODUCT_TITLE",
        locatorStrategy: "css",
        locatorValue: ".product-title a",
        anchorEvidence: { text: "Product title link" },
        uniquenessExpectation: "SINGLE",
        provenance: "TINYFISH_EXPLORER",
        sourceRunId: "seed-explorer-run-1",
        domain: "localhost",
        version: "1.0.0",
      },
      PRODUCT_PRICE: {
        semanticRole: "PRODUCT_PRICE",
        locatorStrategy: "css",
        locatorValue: ".woocommerce-Price-amount",
        anchorEvidence: { text: "Price with currency symbol" },
        uniquenessExpectation: "SINGLE",
        provenance: "TINYFISH_EXPLORER",
        sourceRunId: "seed-explorer-run-1",
        domain: "localhost",
        version: "1.0.0",
      },
    },
    urlPatterns: {
      entryUrl: `${baseUrl}/store-a`,
      searchUrlTemplate: `${baseUrl}/store-a/search?s={query}`,
    },
    evidence: {
      traceId: "seed-trace-store-a-01",
      sampleProductUrl: `${baseUrl}/store-a/product/arduino-uno`,
    },
    source: "agent",
    validationQueries: ["Arduino Uno", "ESP32"],
    validationResults: [
      { query: "Arduino Uno", passed: true },
      { query: "ESP32", passed: true },
    ],
    createdAt: now,
    promotedAt: now,
  };

  repo.saveSiteAdapter(storeAAdapter);
  repo.promoteSiteAdapter("localhost", "1.0.0");

  // 4. Seed Store B Active Site Adapter (Status: ACTIVE, completely separate locators)
  const storeBAdapter: SiteAdapter = {
    domain: "store-b.local",
    adapterVersion: "1.0.0",
    status: "ACTIVE",
    locatorBindings: {
      SEARCH_INPUT: {
        semanticRole: "SEARCH_INPUT",
        locatorStrategy: "css",
        locatorValue: "input[name='keyword']",
        anchorEvidence: { placeholder: "Search maker parts...", testid: "search-input" },
        uniquenessExpectation: "SINGLE",
        provenance: "TIP_GROUNDED",
        sourceRunId: "seed-tip-run-store-b",
        domain: "store-b.local",
        version: "1.0.0",
      },
      PRODUCT_CARD: {
        semanticRole: "PRODUCT_CARD",
        locatorStrategy: "css",
        locatorValue: "article.catalog-card",
        anchorEvidence: { role: "article" },
        uniquenessExpectation: "MULTIPLE",
        provenance: "TIP_GROUNDED",
        sourceRunId: "seed-tip-run-store-b",
        domain: "store-b.local",
        version: "1.0.0",
      },
      PRODUCT_TITLE: {
        semanticRole: "PRODUCT_TITLE",
        locatorStrategy: "css",
        locatorValue: ".catalog-card-title a",
        anchorEvidence: { text: "Title" },
        uniquenessExpectation: "SINGLE",
        provenance: "TIP_GROUNDED",
        sourceRunId: "seed-tip-run-store-b",
        domain: "store-b.local",
        version: "1.0.0",
      },
      PRODUCT_PRICE: {
        semanticRole: "PRODUCT_PRICE",
        locatorStrategy: "css",
        locatorValue: ".sale-price",
        anchorEvidence: { text: "Price" },
        uniquenessExpectation: "SINGLE",
        provenance: "TIP_GROUNDED",
        sourceRunId: "seed-tip-run-store-b",
        domain: "store-b.local",
        version: "1.0.0",
      },
    },
    urlPatterns: {
      entryUrl: `${baseUrl}/store-b`,
      searchUrlTemplate: `${baseUrl}/store-b/search?keyword={query}`,
    },
    evidence: {
      traceId: "seed-trace-store-b-01",
    },
    source: "heuristic",
    validationQueries: ["Arduino Uno", "ESP32"],
    validationResults: [
      { query: "Arduino Uno", passed: true },
      { query: "ESP32", passed: true },
    ],
    createdAt: now,
    promotedAt: now,
  };

  repo.saveSiteAdapter(storeBAdapter);
  repo.promoteSiteAdapter("store-b.local", "1.0.0");

  // 5. Seed Recorded Baseline Benchmark Trials (M1–M7 Telemetry)
  const baselineTrials: Array<Omit<BenchmarkRecord, "benchmarkId" | "executedAt">> = [
    {
      trialType: "COLD_AGENT",
      site: "localhost",
      query: "Arduino Uno",
      agentInvocations: 1,
      agentSteps: 4,
      latencyMs: 16200,
      success: true,
      resultCorrectness: "CORRECT",
      costs: { agentCostUsd: 0.015, browserCostUsd: 0, totalCostUsd: 0.015 },
      unavailableMetrics: [],
    },
    {
      trialType: "COLD_AGENT",
      site: "localhost",
      query: "ESP32",
      agentInvocations: 1,
      agentSteps: 5,
      latencyMs: 15800,
      success: true,
      resultCorrectness: "CORRECT",
      costs: { agentCostUsd: 0.015, browserCostUsd: 0, totalCostUsd: 0.015 },
      unavailableMetrics: [],
    },
    {
      trialType: "WARM_PLAYWRIGHT_REPLAY",
      site: "localhost",
      query: "Arduino Uno",
      agentInvocations: 0,
      agentSteps: null,
      latencyMs: 1280,
      success: true,
      resultCorrectness: "CORRECT",
      costs: { agentCostUsd: 0, browserCostUsd: 0, totalCostUsd: 0 },
      unavailableMetrics: [],
    },
    {
      trialType: "WARM_PLAYWRIGHT_REPLAY",
      site: "localhost",
      query: "ESP32",
      agentInvocations: 0,
      agentSteps: null,
      latencyMs: 1220,
      success: true,
      resultCorrectness: "CORRECT",
      costs: { agentCostUsd: 0, browserCostUsd: 0, totalCostUsd: 0 },
      unavailableMetrics: [],
    },
    {
      trialType: "WARM_PLAYWRIGHT_REPLAY",
      site: "localhost",
      query: "Raspberry Pi",
      agentInvocations: 0,
      agentSteps: null,
      latencyMs: 1350,
      success: true,
      resultCorrectness: "CORRECT",
      costs: { agentCostUsd: 0, browserCostUsd: 0, totalCostUsd: 0 },
      unavailableMetrics: [],
    },
    {
      trialType: "SELF_HEALING_RECOVERY",
      site: "localhost",
      query: "Arduino Uno",
      agentInvocations: 1,
      agentSteps: 3,
      latencyMs: 2850,
      success: true,
      resultCorrectness: "CORRECT",
      costs: { agentCostUsd: 0.015, browserCostUsd: 0, totalCostUsd: 0.015 },
      unavailableMetrics: [],
    },
    {
      trialType: "CROSS_SITE_TRANSFER",
      site: "store-b.local",
      query: "Raspberry Pi",
      agentInvocations: 0,
      agentSteps: null,
      latencyMs: 1380,
      success: true,
      resultCorrectness: "CORRECT",
      costs: { agentCostUsd: 0, browserCostUsd: 0, totalCostUsd: 0 },
      unavailableMetrics: [],
    },
  ];

  for (const trial of baselineTrials) {
    repo.saveBenchmark({
      benchmarkId: randomUUID(),
      ...trial,
      executedAt: now,
    });
  }

  // 6. Log Initial Seed Audit Events
  repo.logEvent({
    eventId: randomUUID(),
    jobId: randomUUID(),
    runId: randomUUID(),
    agentRole: "ORCHESTRATOR",
    state: "ACTIVE",
    timestamp: now,
    site: "localhost",
    payloadSummary: {
      action: "DEMO_SEED_COMPLETED",
      activeSkill: universalSkill.name,
      storeA: "v1.0.0",
      storeB: "v1.0.0",
      baselineTrials: baselineTrials.length,
    },
  });

  logger.info("Demo state successfully seeded cleanly", {
    skillId,
    storeAAdapter: "1.0.0",
    storeBAdapter: "1.0.0",
    baselineTrials: baselineTrials.length,
  });

  return {
    success: true,
    seededAt: now,
    activeSkillId: skillId,
    storeAAdapterVersion: "1.0.0",
    storeBAdapterVersion: "1.0.0",
    baselineTrialCount: baselineTrials.length,
  };
}
