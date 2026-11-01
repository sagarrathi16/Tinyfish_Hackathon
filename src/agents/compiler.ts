import { randomUUID } from "node:crypto";
import { getEnv } from "../config/env.js";
import type { Repository } from "../persistence/repository.js";
import {
  SiteAdapterSchema,
  SkillSchema,
  type AgentResult,
  type SiteAdapter,
  type Skill,
  type StepBinding,
  type TaskStep,
} from "../types/domain.js";
import { logger } from "../utils/logger.js";

export interface TaskProfile {
  taskName: string;
  allowedCategories?: string[];
  maxPriceInr?: number;
  requiredTokens?: string[];
  negativeKeywords?: string[]; // e.g. ["case", "cover", "strap", "cable", "screen protector"]
}

export interface CompileParams {
  domain: string;
  entryUrl: string;
  explorerResult: AgentResult;
  taskProfile?: TaskProfile;
  existingVersion?: string;
}

export interface CompileOutput {
  skill: Skill;
  adapter: SiteAdapter;
}

export type LLMCompilerFunction = (prompt: string) => Promise<string>;

export class CompilerAgent {
  private repo?: Repository;
  private customLLM?: LLMCompilerFunction;

  constructor(repo?: Repository, customLLM?: LLMCompilerFunction) {
    this.repo = repo;
    this.customLLM = customLLM;
  }

  /**
   * Compiles an inspectable candidate skill and domain adapter from Explorer observations.
   * Does NOT browse or invent facts. Enforces CANDIDATE status.
   */
  async compile(params: CompileParams): Promise<CompileOutput> {
    logger.info("Compiler Agent synthesizing candidate skill and adapter", {
      domain: params.domain,
      taskId: params.explorerResult.taskId,
    });

    const { domain, entryUrl, explorerResult } = params;

    // Validate Explorer result integrity
    if (explorerResult.status !== "SUCCESS" || !explorerResult.structuredOutput) {
      throw new Error(
        `Cannot compile skill from non-successful Explorer result (status: ${explorerResult.status})`
      );
    }

    const runId = explorerResult.providerRunIds.tinyFishRunId;
    if (!runId) {
      throw new Error("Missing exploration provenance: ExplorerResult does not contain a provider run ID");
    }

    // Security check: Validate domain authorization
    this.validateDomainBoundary(domain, entryUrl);

    // Increment version or default to 1.0.0
    const nextVersion = this.computeNextVersion(params.existingVersion);

    let rawCompilationJson: string;

    if (this.customLLM) {
      // Use configured or injected model (in demo/production or mock in tests)
      const prompt = this.buildCompilationPrompt(params);
      rawCompilationJson = await this.customLLM(prompt);
    } else {
      const env = getEnv();
      if (env.LLM_API_KEY) {
        // Real model call via server-only env key
        rawCompilationJson = await this.callConfiguredModel(params, env.LLM_API_KEY, env.LLM_MODEL);
      } else {
        // Deterministic synthesis from verified Explorer observations
        rawCompilationJson = this.synthesizeDeterministic(params, nextVersion, runId);
      }
    }

    // Parse and strictly validate compiler output
    const parsed = this.parseAndValidateCompilerOutput(rawCompilationJson, domain, nextVersion, runId);

    // Anti-corruption check: Reject accidental hardcoded volatile values
    this.detectHardcodedVolatileValues(parsed.adapter, explorerResult);

    // Save as CANDIDATE only
    if (this.repo) {
      this.repo.saveSkill(parsed.skill);
      this.repo.saveSiteAdapter(parsed.adapter);
      this.repo.logEvent({
        eventId: randomUUID(),
        jobId: explorerResult.jobId,
        runId: explorerResult.taskId,
        agentRole: "COMPILER",
        state: "VALIDATING_CANDIDATE",
        site: domain,
        timestamp: new Date().toISOString(),
        payloadSummary: {
          skillId: parsed.skill.id,
          adapterDomain: domain,
          version: nextVersion,
          status: "CANDIDATE",
        },
      });
    }

    return parsed;
  }

  // ==========================================================================
  // Prompt Construction & Model Invocation
  // ==========================================================================

  private buildCompilationPrompt(params: CompileParams): string {
    return [
      `You are the ShadowTwin Workflow Compiler. Convert this web exploration trace into a versioned, parameterized candidate skill.`,
      `Domain: ${params.domain}`,
      `Entry URL: ${params.entryUrl}`,
      `Explorer Observations: ${JSON.stringify(params.explorerResult.structuredOutput, null, 2)}`,
      `Rules:`,
      `1. Parameterize all queries. Do not hardcode specific item titles or numeric prices into locators.`,
      `2. Return an object with 'candidate_skill' and 'candidate_adapter'.`,
      `3. Status MUST be 'CANDIDATE'.`,
      `4. Provide anchor evidence for every binding (role, placeholder, aria-label, exactText).`,
      `Return JSON only.`,
    ].join("\n");
  }

  private async callConfiguredModel(
    params: CompileParams,
    apiKey: string,
    modelName: string
  ): Promise<string> {
    const prompt = this.buildCompilationPrompt(params);

    // Standard Gemini REST API invocation
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM provider call failed with HTTP ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as any;
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw new Error("Model returned empty text response");
    }
    return rawText;
  }

  // ==========================================================================
  // Deterministic Fallback Synthesis
  // ==========================================================================

  private synthesizeDeterministic(
    params: CompileParams,
    version: string,
    runId: string
  ): string {
    const raw = params.explorerResult.structuredOutput as Record<string, unknown>;
    const bindings = (raw?.candidate_bindings as Record<string, string>) || {};

    const searchInput = bindings.search_input_selector || "input[type='search'], input[name='s']";
    const productCard = bindings.product_card_selector || ".product-card, .product-grid-item";
    const titleSel = bindings.title_selector || ".product-title a, h2.woocommerce-loop-product__title";
    const priceSel = bindings.price_selector || ".price bdi, .woocommerce-Price-amount";

    const searchAnchor = bindings.search_input_anchor || "role='searchbox'";
    const cardAnchor = bindings.product_card_anchor || "role='article'";
    const titleAnchor = bindings.title_anchor || "role='heading'";
    const priceAnchor = bindings.price_anchor || "currency='₹'";

    const candidateAdapter: SiteAdapter = {
      domain: params.domain,
      adapterVersion: version,
      status: "CANDIDATE",
      locatorBindings: {
        SEARCH_INPUT: {
          semanticRole: "SEARCH_INPUT",
          locatorStrategy: "css",
          locatorValue: searchInput,
          anchorEvidence: { label: searchAnchor },
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          sourceRunId: runId,
          domain: params.domain,
          version,
        },
        PRODUCT_CARD: {
          semanticRole: "PRODUCT_CARD",
          locatorStrategy: "css",
          locatorValue: productCard,
          anchorEvidence: { role: cardAnchor },
          uniquenessExpectation: "MULTIPLE",
          provenance: "TINYFISH_EXPLORER",
          sourceRunId: runId,
          domain: params.domain,
          version,
        },
        PRODUCT_TITLE: {
          semanticRole: "PRODUCT_TITLE",
          locatorStrategy: "css",
          locatorValue: titleSel,
          anchorEvidence: { role: titleAnchor },
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          sourceRunId: runId,
          domain: params.domain,
          version,
        },
        PRODUCT_PRICE: {
          semanticRole: "PRODUCT_PRICE",
          locatorStrategy: "css",
          locatorValue: priceSel,
          anchorEvidence: { text: priceAnchor },
          uniquenessExpectation: "SINGLE",
          provenance: "TINYFISH_EXPLORER",
          sourceRunId: runId,
          domain: params.domain,
          version,
        },
      },
      urlPatterns: {
        entryUrl: params.entryUrl,
        searchUrlTemplate: `${params.entryUrl.replace(/\/$/, "")}/?s={query}`,
      },
      evidence: {
        traceId: runId,
      },
      source: "agent",
      validationQueries: [],
      validationResults: [],
      createdAt: new Date().toISOString(),
    };

    const candidateSkill: Skill = {
      id: randomUUID(),
      name: "E-Commerce Product Lookup",
      taskType: "PRODUCT_LOOKUP",
      version,
      status: "CANDIDATE",
      taskTemplate: this.getPlatformNeutralFiveStepTemplate(),
      outputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          numericPrice: { type: "number" },
          currency: { type: "string" },
          productUrl: { type: "string" },
          evidenceUrl: { type: "string" },
          retrievedAt: { type: "string" },
        },
        required: ["title", "numericPrice", "currency", "productUrl"],
      },
      postconditions: [
        { name: "title_non_empty", rule: "len(title) > 0", required: true },
        { name: "price_positive_inr", rule: "numericPrice > 0 and currency == 'INR'", required: true },
        { name: "same_domain", rule: "productUrl.domain == target.domain", required: true },
      ],
      sourceRunIds: [runId],
      tests: [{ query: "test query", expectedFields: ["title", "numericPrice"] }],
      limitations: [
        "Read-only product discovery",
        "Requires semantic search box and card layout",
      ],
      timestamps: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    return JSON.stringify({
      candidate_skill: candidateSkill,
      candidate_adapter: candidateAdapter,
    });
  }

  // ==========================================================================
  // Canonical Five-Step Template
  // ==========================================================================

  private getPlatformNeutralFiveStepTemplate(): TaskStep[] {
    return [
      {
        order: 1,
        stepName: "OPEN",
        description: "Navigate to domain entry URL and verify page loads with visible search input",
        postcondition: "Page loaded; search input located through binding",
      },
      {
        order: 2,
        stepName: "SEARCH",
        description: "Fill the parameterized search query into the search input and submit",
        postcondition: "URL or DOM changed; result container holds at least 3 cards",
      },
      {
        order: 3,
        stepName: "PARSE",
        description: "Extract result cards containing product title and numeric INR price",
        postcondition: "At least 3 cards extracted with non-empty titles and numeric prices",
      },
      {
        order: 4,
        stepName: "SELECT",
        description: "Score titles against query, apply accessory/negative keyword filters, and select top candidate",
        postcondition: "Top candidate score >= threshold; not an accessory or ad",
      },
      {
        order: 5,
        stepName: "CONFIRM",
        description: "Verify title matches selected card, price is valid INR, domain matches, and freshness timestamp is set",
        postcondition: "Title matches selected card; numeric price valid; same domain; retrievedAt set",
      },
    ];
  }

  // ==========================================================================
  // Strict Output Parsing & Validation
  // ==========================================================================

  private parseAndValidateCompilerOutput(
    rawJson: string,
    expectedDomain: string,
    version: string,
    sourceRunId: string
  ): CompileOutput {
    let parsedJson: any;
    try {
      parsedJson = JSON.parse(rawJson);
    } catch (err: unknown) {
      throw new Error(`Compiler output is malformed JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    const skillData = parsedJson.candidate_skill || parsedJson.skill;
    const adapterData = parsedJson.candidate_adapter || parsedJson.adapter;

    if (!skillData || !adapterData) {
      throw new Error("Compiler output must contain both 'candidate_skill' and 'candidate_adapter'");
    }

    // Enforce CANDIDATE status at compile time
    if (skillData.status !== "CANDIDATE") {
      throw new Error(`Security violation: Skill cannot be marked '${skillData.status}' at compile time. Must be 'CANDIDATE'.`);
    }
    if (adapterData.status !== "CANDIDATE") {
      throw new Error(`Security violation: Adapter cannot be marked '${adapterData.status}' at compile time. Must be 'CANDIDATE'.`);
    }

    // Enforce domain boundary on adapter
    if (adapterData.domain !== expectedDomain) {
      throw new Error(`Domain mismatch: Adapter domain '${adapterData.domain}' does not match expected '${expectedDomain}'`);
    }

    // Verify all bindings have locators and provenance
    const bindings = adapterData.locatorBindings as Record<string, StepBinding>;
    if (!bindings || Object.keys(bindings).length === 0) {
      throw new Error("Adapter has no locator bindings");
    }

    for (const [key, binding] of Object.entries(bindings)) {
      if (!binding.locatorValue || binding.locatorValue.trim() === "") {
        throw new Error(`Empty locator value for binding '${key}'`);
      }
      // Ensure provenance is tracked
      if (!binding.provenance) {
        binding.provenance = "TINYFISH_EXPLORER";
      }
      if (!binding.sourceRunId) {
        binding.sourceRunId = sourceRunId;
      }
      if (binding.domain !== expectedDomain) {
        throw new Error(`Binding '${key}' domain '${binding.domain}' does not match expected '${expectedDomain}'`);
      }
    }

    const validatedSkill = SkillSchema.parse(skillData);
    const validatedAdapter = SiteAdapterSchema.parse(adapterData);

    return {
      skill: validatedSkill,
      adapter: validatedAdapter,
    };
  }

  // ==========================================================================
  // Guardrails & Anti-Corruption Checks
  // ==========================================================================

  private validateDomainBoundary(domain: string, entryUrl: string): void {
    const env = getEnv();
    const allowed = env.ALLOWED_TARGET_DOMAINS.split(",").map((d) => d.trim().toLowerCase());

    const isDomainAllowed = allowed.some((d) => domain.toLowerCase().includes(d) || d.includes(domain.toLowerCase()));
    if (!isDomainAllowed) {
      throw new Error(`Target domain '${domain}' is not in ALLOWED_TARGET_DOMAINS`);
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(entryUrl);
    } catch {
      throw new Error(`Invalid entry URL: '${entryUrl}'`);
    }

    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      throw new Error(`Invalid scheme in entry URL: '${parsedUrl.protocol}'`);
    }
  }

  private detectHardcodedVolatileValues(adapter: SiteAdapter, explorerResult: AgentResult): void {
    const raw = explorerResult.structuredOutput as Record<string, unknown> | null;
    if (!raw) return;

    const product = raw.product as Record<string, unknown> | undefined;
    if (!product) return;

    const numericPrice = product.numeric_price;
    const priceStr = numericPrice !== undefined && numericPrice !== null ? String(numericPrice) : null;

    for (const [role, binding] of Object.entries(adapter.locatorBindings)) {
      const locator = binding.locatorValue.toLowerCase();

      // Reject if exact live price is hardcoded into selector (e.g. [price='499'])
      if (priceStr && (locator.includes(`'${priceStr}'`) || locator.includes(`"${priceStr}"`))) {
        throw new Error(
          `Anti-corruption check failed: Locator for '${role}' contains hardcoded volatile price '${priceStr}'`
        );
      }
    }
  }

  private computeNextVersion(existingVersion?: string): string {
    if (!existingVersion) return "1.0.0";
    const parts = existingVersion.split(".").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return "1.0.0";
    return `${parts[0]}.${parts[1]! + 1}.${parts[2]}`;
  }
}

