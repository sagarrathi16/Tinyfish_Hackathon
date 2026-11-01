import { z } from "zod";
import {
  SiteAdapterSchema,
  TaskStepSchema,
  StepBindingSchema,
} from "./domain.js";

// ============================================================================
// 1. Scored Feature Schema (Transparent TIP Explanation)
// ============================================================================

export const ScoredFeatureSchema = z.object({
  featureName: z.string(),
  weight: z.number().min(0).max(1),
  rawScore: z.number().min(0).max(1),
  weightedScore: z.number().min(0).max(1),
  evidence: z.string(),
});
export type ScoredFeature = z.infer<typeof ScoredFeatureSchema>;

// ============================================================================
// 2. TIP Status & Match Result
// ============================================================================

export const TIPStatusSchema = z.enum([
  "MATCHED",
  "AMBIGUOUS_REJECTED",
  "LOW_CONFIDENCE_FALLBACK",
  "DISABLED",
]);
export type TIPStatus = z.infer<typeof TIPStatusSchema>;

export const GroundedPriceSchema = z.object({
  sellingPrice: z.number().positive().optional(),
  originalPrice: z.number().positive().optional(),
  emiPrice: z.number().positive().optional(),
  currency: z.string().default("INR"),
  source: z.enum(["JSON_LD", "VISIBLE_DOM", "MISMATCH_FALLBACK"]),
  discrepancyNote: z.string().optional(),
});
export type GroundedPrice = z.infer<typeof GroundedPriceSchema>;

export const TIPMatchResultSchema = z.object({
  matched: z.boolean(),
  status: TIPStatusSchema,
  confidence: z.number().min(0).max(1),
  candidateAdapter: SiteAdapterSchema.optional(),
  scoredFeatures: z.array(ScoredFeatureSchema),
  explanation: z.string(),
  rejectionReason: z.string().optional(),
  groundedPrice: GroundedPriceSchema.optional(),
});
export type TIPMatchResult = z.infer<typeof TIPMatchResultSchema>;

// ============================================================================
// 3. Compact Structural Sketch (Task Invariant Pattern)
// ============================================================================

export interface TIPStructuralSketch {
  searchBox: {
    expectedRoles: string[];
    expectedTypes: string[];
    nameKeywords: string[];
    containerContext: string[];
  };
  productCards: {
    minCardCount: number;
    cardTagHints: string[];
    excludeClasses: string[];
  };
  cardElements: {
    title: { tagHints: string[]; minTextLength: number };
    price: { currencySymbols: string[]; excludePatterns: string[] };
    link: { tag: string; attr: string };
  };
}

// ============================================================================
// 4. Cross-Site Transfer Report & Table Schema
// ============================================================================

export const CrossSiteTransferReportSchema = z.object({
  sourceDomain: z.string(),
  targetDomain: z.string(),
  skillId: z.string(),
  transferredArtifacts: z.object({
    taskTemplate: z.array(TaskStepSchema),
    outputSchema: z.record(z.unknown()),
    postconditions: z.array(z.string()),
    selectionPolicy: z.object({
      taskType: z.string(),
      accessoryKeywords: z.array(z.string()),
      requiredModelTokens: z.array(z.string()),
    }),
  }),
  relearnedArtifacts: z.object({
    domain: z.string(),
    adapterVersion: z.string(),
    locatorBindings: z.record(StepBindingSchema),
    searchUrlTemplate: z.string().optional(),
    provenance: z.string(),
    sourceRunId: z.string().optional(),
  }),
  validationOutcome: z.object({
    query1: z.object({ query: z.string(), passed: z.boolean(), taskId: z.string() }),
    query2: z.object({ query: z.string(), passed: z.boolean(), taskId: z.string() }),
    promoted: z.boolean(),
    activeVersion: z.string(),
  }),
  tipStatus: TIPStatusSchema,
  tipMatchSummary: z
    .object({
      confidence: z.number(),
      explanation: z.string(),
      scoredFeatures: z.array(ScoredFeatureSchema),
    })
    .optional(),
  replayProof: z.object({
    subsequentQuery: z.string(),
    tinyfishApiCalls: z.literal(0),
    passed: z.boolean(),
    latencyMs: z.number(),
  }),
  savings: z.object({
    coldStartTokensSaved: z.number(),
    agentCallsAvoidedOnReplay: z.number(),
    latencyReductionMs: z.number(),
  }),
  transferredAt: z.string().datetime(),
});
export type CrossSiteTransferReport = z.infer<typeof CrossSiteTransferReportSchema>;
