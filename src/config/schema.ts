import { z } from "zod";

import {
  CONTENT_READINESS,
  CONTENT_STATUS,
  PROFILE_IDS,
  SENSITIVITY_CATEGORIES,
  SOURCE_KINDS
} from "../domain/types.js";

const llmProviderSchema = z.enum(["openai", "anthropic"]);

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NOTION_TOKEN: z.string().default(""),
  NOTION_PARENT_PAGE_ID: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  TAVILY_API_KEY: z.string().default(""),
  CLAAP_API_KEY: z.string().default(""),
  LINEAR_API_KEY: z.string().default(""),
  DEFAULT_TIMEZONE: z.string().default("Europe/Paris"),
  DEFAULT_COMPANY_SLUG: z.string().default("default"),
  DEFAULT_COMPANY_NAME: z.string().default("Default Company"),
  INTELLIGENCE_LLM_PROVIDER: llmProviderSchema.default("openai"),
  INTELLIGENCE_LLM_MODEL: z.string().default("gpt-5.4"),
  DRAFT_LLM_PROVIDER: llmProviderSchema.default("openai"),
  DRAFT_LLM_MODEL: z.string().default("gpt-5"),
  LLM_MODEL: z.string().default("gpt-4.1-mini"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  HTTP_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  NOTION_TONE_OF_VOICE_DB_ID: z.string().default(""),
  ADMIN_ENABLED: z.string().default(""),
  ADMIN_USER: z.string().default(""),
  ADMIN_PASSWORD: z.string().default(""),
  ADMIN_ALLOW_REMOTE: z.string().default("")
});

export const rateLimitSchema = z.object({
  requestsPerMinute: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  initialDelayMs: z.number().int().nonnegative()
});

const sourceBaseSchema = z.object({
  enabled: z.boolean(),
  storeRawText: z.boolean(),
  retentionDays: z.number().int().positive(),
  rateLimit: rateLimitSchema
});

export const notionSourceConfigSchema = sourceBaseSchema.extend({
  source: z.literal("notion"),
  pageAllowlist: z.array(z.string()),
  databaseAllowlist: z.array(z.string()),
  excludedDatabaseNames: z.array(z.string())
});

export const claapSourceConfigSchema = sourceBaseSchema.extend({
  source: z.literal("claap"),
  workspaceIds: z.array(z.string()),
  folderIds: z.array(z.string()),
  maxRecordingsPerRun: z.number().int().positive().default(50)
});

export const claapSignalExtractionSchema = z.object({
  hasSignal: z.boolean(),
  title: z.string(),
  summary: z.string(),
  hookCandidate: z.string(),
  whyItMatters: z.string(),
  excerpts: z.array(z.string()).max(3),
  signalType: z.string(),
  theme: z.string(),
  profileHint: z.string().optional(),
  confidenceScore: z.number().min(0).max(1),
  publishabilityRisk: z.enum(["safe", "reframeable", "harmful"]).default("safe"),
  reframingSuggestion: z.string().optional()
});

export const claapPublishabilityReviewSchema = z.object({
  publishabilityRisk: z.enum(["safe", "reframeable", "harmful"]),
  reframingSuggestion: z.string().optional(),
  rationale: z.string()
});

export const linearEnrichmentPolicySchema = z.object({
  classification: z.enum(["enrich-worthy", "ignore", "manual-review-needed"]),
  rationale: z.string(),
  customerVisibility: z.enum(["shipped", "in-progress", "internal-only", "ambiguous"]),
  sensitivityLevel: z.enum(["safe", "roadmap-sensitive", "pre-shipping", "promise-like"]),
  evidenceStrength: z.number().min(0).max(1),
  reviewNote: z.string().optional()
});

export type LinearEnrichmentClassification = z.infer<typeof linearEnrichmentPolicySchema>;

export const linearSourceConfigSchema = sourceBaseSchema.extend({
  source: z.literal("linear"),
  workspaceIds: z.array(z.string()),
  includeIssues: z.boolean(),
  includeProjectUpdates: z.boolean(),
  includeIssueComments: z.boolean()
});

export const marketFindingsSourceConfigSchema = sourceBaseSchema.extend({
  source: z.literal("market-findings"),
  directory: z.string().min(1)
});

export const sourceConfigSchema = z.discriminatedUnion("source", [
  notionSourceConfigSchema,
  claapSourceConfigSchema,
  linearSourceConfigSchema,
  marketFindingsSourceConfigSchema
]);

export const marketResearchRuntimeConfigSchema = z.object({
  enabled: z.boolean(),
  storeRawText: z.boolean(),
  retentionDays: z.number().int().positive(),
  rateLimit: rateLimitSchema,
  maxResultsPerQuery: z.number().int().min(5).max(10)
});

export const sensitivityOutputSchema = z.object({
  blocked: z.boolean(),
  categories: z.array(z.enum(SENSITIVITY_CATEGORIES)),
  rationale: z.string(),
  stageTwoScore: z.number().min(0).max(1)
});

export const draftOutputSchema = z.object({
  proposedTitle: z.string().min(1),
  hook: z.string().min(1),
  summary: z.string().min(1),
  whatItIsAbout: z.string().min(1),
  whatItIsNotAbout: z.string().min(1),
  visualIdea: z.string().min(1),
  firstDraftText: z.string().min(50).max(2000),
  confidenceScore: z.number().min(0).max(1)
});

export const llmDraftSafetySchema = sensitivityOutputSchema;

export const notionSelectionRowSchema = z.object({
  notionPageId: z.string().min(1),
  fingerprint: z.string().min(1),
  editorialOwner: z.string().min(1)
});

export const notionRichTextChunkSchema = z.object({
  text: z.string().min(1)
});

export const opportunityStatusSchema = z.enum(CONTENT_STATUS);
export const readinessSchema = z.enum(CONTENT_READINESS);

export const notionDatabaseNameSchema = z.enum([
  "Content Opportunities",
  "Claap Review",
  "Linear Review",
  "Profiles",
  "Sync Runs"
]);

export const supportedSourceSchema = z.enum(SOURCE_KINDS);

export const screeningItemSchema = z.object({
  sourceItemId: z.string(),
  decision: z.enum(["skip", "retain"]),
  rationale: z.string(),
  ownerSuggestion: z.string().optional(),
  createOrEnrich: z.enum(["create", "enrich", "unknown"]),
  relevanceScore: z.number().min(0).max(1),
  sensitivityFlag: z.boolean(),
  sensitivityCategories: z.array(z.string())
});
export const screeningBatchSchema = z.object({
  items: z.array(screeningItemSchema)
});

export const createEnrichDecisionSchema = z.object({
  action: z.enum(["create", "enrich", "skip"]),
  targetOpportunityId: z.string().optional(),
  rationale: z.string(),
  title: z.string().min(1),
  ownerDisplayName: z.string().optional(),
  territory: z.string().min(1),
  angle: z.string().min(1),
  whyNow: z.string().min(1),
  whatItIsAbout: z.string().min(1),
  whatItIsNotAbout: z.string().min(1),
  suggestedFormat: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

export const marketResearchSummarySchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  keyFindings: z.array(z.object({
    claim: z.string().min(1),
    supportingResultIndices: z.array(z.number().int().min(0)).min(1)
  }))
});
