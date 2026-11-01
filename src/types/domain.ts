import { z } from "zod";

// ============================================================================
// 1. AgentTask & AgentResult
// ============================================================================

export const AgentRoleSchema = z.enum([
  "ORCHESTRATOR",
  "EXPLORER",
  "COMPILER",
  "EXECUTOR",
  "VALIDATOR",
  "RECOVERY",
  "BENCHMARK",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const AgentTaskSchema = z.object({
  taskId: z.string().uuid(),
  jobId: z.string().uuid(),
  role: AgentRoleSchema,
  goal: z.string().min(1, "Goal cannot be empty"),
  site: z.string().min(1, "Site domain/URL required"),
  inputPayload: z.record(z.unknown()).default({}),
  deadline: z.string().datetime(),
  maxSteps: z.number().int().positive().default(20),
  budget: z
    .object({
      maxSeconds: z.number().positive().default(120),
      maxUsd: z.number().nonnegative().default(1.0),
    })
    .default({ maxSeconds: 120, maxUsd: 1.0 }),
  correlationId: z.string().min(1),
});
export type AgentTask = z.infer<typeof AgentTaskSchema>;

export const AgentResultStatusSchema = z.enum([
  "SUCCESS",
  "FAILED",
  "STUCK",
  "NEEDS_REVIEW",
  "BLOCKED",
]);
export type AgentResultStatus = z.infer<typeof AgentResultStatusSchema>;

export const AgentResultSchema = z.object({
  taskId: z.string().uuid(),
  jobId: z.string().uuid(),
  status: AgentResultStatusSchema,
  structuredOutput: z.record(z.unknown()).nullable(),
  evidenceReferences: z.array(z.string()).default([]),
  providerRunIds: z
    .object({
      tinyFishRunId: z.string().optional(),
      browserSessionId: z.string().optional(),
    })
    .default({}),
  stepsUsage: z
    .object({
      stepsCompleted: z.number().int().nonnegative(),
      tokensUsed: z.number().int().nonnegative().optional(),
      browserMinutes: z.number().nonnegative().optional(),
    })
    .nullable(),
  durationMs: z.number().nonnegative(),
  errors: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
        stepId: z.string().optional(),
      })
    )
    .default([]),
  warnings: z.array(z.string()).default([]),
});
export type AgentResult = z.infer<typeof AgentResultSchema>;

// ============================================================================
// 2. RunEvent
// ============================================================================

export const RunEventSchema = z.object({
  eventId: z.string().uuid(),
  jobId: z.string().uuid(),
  runId: z.string().uuid(),
  agentRole: AgentRoleSchema,
  state: z.string().min(1),
  timestamp: z.string().datetime(),
  site: z.string().min(1),
  stepId: z.string().optional(),
  payloadSummary: z.record(z.unknown()).default({}),
  redactedError: z.string().optional(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

// ============================================================================
// 3. StepBinding, SiteAdapter & Skill
// ============================================================================

export const SemanticRoleSchema = z.enum([
  "SEARCH_INPUT",
  "SEARCH_BUTTON",
  "PRODUCT_CARD",
  "PRODUCT_TITLE",
  "PRODUCT_PRICE",
  "PRODUCT_LINK",
  "PAGINATION_NEXT",
]);
export type SemanticRole = z.infer<typeof SemanticRoleSchema>;

export const LocatorStrategySchema = z.enum([
  "css",
  "xpath",
  "role",
  "text",
  "testid",
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const StepBindingSchema = z.object({
  semanticRole: SemanticRoleSchema,
  locatorStrategy: LocatorStrategySchema,
  locatorValue: z.string().min(1),
  anchorEvidence: z
    .object({
      role: z.string().optional(),
      name: z.string().optional(),
      label: z.string().optional(),
      placeholder: z.string().optional(),
      testid: z.string().optional(),
      text: z.string().optional(),
    })
    .default({}),
  uniquenessExpectation: z.enum(["SINGLE", "MULTIPLE"]).default("SINGLE"),
  domain: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Version must be SemVer format (e.g. 1.0.0)"),
});
export type StepBinding = z.infer<typeof StepBindingSchema>;

export const VersionStatusSchema = z.enum(["CANDIDATE", "ACTIVE", "RETIRED"]);
export type VersionStatus = z.infer<typeof VersionStatusSchema>;

export const SiteAdapterSchema = z.object({
  domain: z.string().min(1),
  adapterVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "Version must be SemVer format"),
  status: VersionStatusSchema.default("CANDIDATE"),
  locatorBindings: z.record(StepBindingSchema),
  urlPatterns: z.object({
    entryUrl: z.string().url(),
    searchUrlTemplate: z.string().optional(),
  }),
  evidence: z
    .object({
      traceId: z.string().optional(),
      sampleProductUrl: z.string().optional(),
      screenshotUrl: z.string().optional(),
    })
    .default({}),
  source: z.enum(["agent", "manual", "heuristic"]).default("agent"),
  validationQueries: z.array(z.string()).default([]),
  validationResults: z
    .array(
      z.object({
        query: z.string(),
        passed: z.boolean(),
        error: z.string().optional(),
      })
    )
    .default([]),
  createdAt: z.string().datetime(),
  promotedAt: z.string().datetime().optional(),
});
export type SiteAdapter = z.infer<typeof SiteAdapterSchema>;

export const TaskStepSchema = z.object({
  order: z.number().int().positive(),
  stepName: z.string().min(1),
  description: z.string(),
  postcondition: z.string().min(1),
});
export type TaskStep = z.infer<typeof TaskStepSchema>;

export const SkillSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  taskType: z.literal("PRODUCT_LOOKUP"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Version must be SemVer format"),
  status: VersionStatusSchema.default("CANDIDATE"),
  taskTemplate: z.array(TaskStepSchema).min(1),
  outputSchema: z.record(z.unknown()),
  postconditions: z
    .array(
      z.object({
        name: z.string(),
        rule: z.string(),
        required: z.boolean(),
      })
    )
    .default([]),
  sourceRunIds: z.array(z.string()).default([]),
  tests: z
    .array(
      z.object({
        query: z.string(),
        expectedFields: z.array(z.string()),
      })
    )
    .default([]),
  limitations: z.array(z.string()).default([]),
  timestamps: z.object({
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    promotedAt: z.string().datetime().optional(),
  }),
});
export type Skill = z.infer<typeof SkillSchema>;

// ============================================================================
// 4. ValidationResult
// ============================================================================

export const ValidationStatusSchema = z.enum(["PASS", "FAIL", "NEEDS_REVIEW", "BLOCKED"]);
export type ValidationStatus = z.infer<typeof ValidationStatusSchema>;

export const FailureCategorySchema = z.enum([
  "NONE",
  "BINDING_FAILED",
  "BLOCKED",
  "MISMATCH",
  "SCHEMA_ERROR",
  "TIMEOUT",
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export const StepPostconditionResultSchema = z.object({
  stepName: z.string(),
  passed: z.boolean(),
  message: z.string(),
});

export const ValidationResultSchema = z.object({
  validationId: z.string().uuid(),
  status: ValidationStatusSchema,
  failureCategory: FailureCategorySchema.default("NONE"),
  checks: z.object({
    schemaValid: z.boolean(),
    productIdentityMatch: z.boolean(),
    priceParsedINR: z.boolean(),
    domainAuthorized: z.boolean(),
    freshnessValid: z.boolean(),
    stepPostconditions: z.array(StepPostconditionResultSchema),
  }),
  verifiedOutput: z.record(z.unknown()).optional(),
  validatedAt: z.string().datetime(),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// ============================================================================
// 5. BenchmarkRecord
// ============================================================================

export const TrialTypeSchema = z.enum([
  "COLD_AGENT",
  "WARM_PLAYWRIGHT_REPLAY",
  "CROSS_SITE_TRANSFER",
  "SELF_HEALING_RECOVERY",
]);
export type TrialType = z.infer<typeof TrialTypeSchema>;

export const BenchmarkRecordSchema = z.object({
  benchmarkId: z.string().uuid(),
  trialType: TrialTypeSchema,
  site: z.string().min(1),
  query: z.string().min(1),
  agentInvocations: z.number().int().nonnegative(),
  agentSteps: z.number().int().nonnegative().nullable(), // Null when provider doesn't report
  latencyMs: z.number().nonnegative(),
  success: z.boolean(),
  resultCorrectness: z.enum(["CORRECT", "INCORRECT", "UNVERIFIED"]),
  costs: z.object({
    agentCostUsd: z.number().nonnegative(),
    browserCostUsd: z.number().nonnegative(),
    totalCostUsd: z.number().nonnegative(),
  }),
  unavailableMetrics: z.array(z.string()).default([]),
  executedAt: z.string().datetime(),
});
export type BenchmarkRecord = z.infer<typeof BenchmarkRecordSchema>;

