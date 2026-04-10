import { z } from "zod";

import {
  CONTENT_READINESS,
  CONTENT_STATUS,
  PROFILE_IDS,
  SENSITIVITY_CATEGORIES,
  SOURCE_KINDS
} from "../domain/types.js";

const llmProviderSchema = z.enum(["openai", "anthropic", "claude-cli"]);

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NOTION_TOKEN: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  TAVILY_API_KEY: z.string().default(""),
  CLAAP_API_KEY: z.string().default(""),
  LINEAR_API_KEY: z.string().default(""),
  GITHUB_TOKEN: z.string().default(""),
  DEFAULT_TIMEZONE: z.string().default("Europe/Paris"),
  DEFAULT_COMPANY_SLUG: z.string().default("default"),
  DEFAULT_COMPANY_NAME: z.string().default("Default Company"),
  INTELLIGENCE_LLM_PROVIDER: llmProviderSchema.default("openai"),
  INTELLIGENCE_LLM_MODEL: z.string().default("gpt-5.4"),
  DRAFT_LLM_PROVIDER: llmProviderSchema.default("openai"),
  DRAFT_LLM_MODEL: z.string().default("gpt-5.4"),
  LLM_MODEL: z.string().default("gpt-5.4-mini"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  HTTP_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  NOTION_TONE_OF_VOICE_DB_ID: z.string().default(""),
  ADMIN_ENABLED: z.string().default(""),
  ADMIN_USER: z.string().default(""),
  ADMIN_PASSWORD: z.string().default(""),
  ADMIN_ALLOW_REMOTE: z.string().default(""),
  HUBSPOT_ACCESS_TOKEN: z.string().default(""),
  HUBSPOT_PORTAL_ID: z.string().default(""),
  SALES_LLM_PROVIDER: llmProviderSchema.default("openai"),
  SALES_LLM_MODEL: z.string().default("gpt-5.4-nano"),
  NANO_LLM_PROVIDER: llmProviderSchema.default("openai"),
  NANO_LLM_MODEL: z.string().default("gpt-5.4-nano"),
  CLAUDE_CLI_PATH: z.string().default("claude"),
  CLAUDE_CLI_MAX_BUDGET_USD: z.coerce.number().positive().default(0.50),
  CLAUDE_CLI_TIMEOUT_MS: z.coerce.number().int().positive().default(120000)
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
  routingDecision: z.enum(["create_opportunity", "support_only", "ignore"]).default("ignore"),
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
  classification: z.enum(["editorial-lead", "enrich-worthy", "ignore", "manual-review-needed"]),
  rationale: z.string(),
  customerVisibility: z.enum(["shipped", "in-progress", "internal-only", "ambiguous"]),
  sensitivityLevel: z.enum(["safe", "roadmap-sensitive", "pre-shipping", "promise-like"]),
  evidenceStrength: z.number().min(0).max(1),
  reviewNote: z.string().optional()
});

export type LinearEnrichmentClassification = z.infer<typeof linearEnrichmentPolicySchema>;

export const githubEnrichmentPolicySchema = z.object({
  classification: z.enum(["shipped-feature", "customer-fix", "proof-point", "internal-only", "manual-review"]),
  rationale: z.string(),
  customerVisibility: z.enum(["shipped", "in-progress", "internal-only", "ambiguous"]),
  sensitivityLevel: z.enum(["safe", "roadmap-sensitive", "pre-shipping"]),
  evidenceStrength: z.number().min(0).max(1),
  reviewNote: z.string().optional()
});

export type GitHubEnrichmentClassification = z.infer<typeof githubEnrichmentPolicySchema>;

export const linearSourceConfigSchema = sourceBaseSchema.extend({
  source: z.literal("linear"),
  workspaceIds: z.array(z.string()),
  includeIssues: z.boolean(),
  includeProjectUpdates: z.boolean(),
  includeIssueComments: z.boolean(),
  teamKeys: z.array(z.string()).optional(),
  includeProjects: z.boolean().optional(),
  projectStateFilter: z.array(z.string()).optional()
});

export const marketFindingsSourceConfigSchema = sourceBaseSchema.extend({
  source: z.literal("market-findings"),
  directory: z.string().min(1)
});

export const githubSourceConfigSchema = sourceBaseSchema.extend({
  source: z.literal("github"),
  orgSlug: z.string().min(1),
  repos: z.array(z.string()).min(1),
  includeMergedPRs: z.boolean(),
  includeClosedIssues: z.boolean(),
  includeReleases: z.boolean(),
  labelFilters: z.object({
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional()
  }).optional(),
  maxItemsPerRun: z.number().int().positive().optional()
});

export const sourceConfigSchema = z.discriminatedUnion("source", [
  notionSourceConfigSchema,
  claapSourceConfigSchema,
  linearSourceConfigSchema,
  marketFindingsSourceConfigSchema,
  githubSourceConfigSchema
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

export const opportunityStatusSchema = z.enum(CONTENT_STATUS);
export const readinessSchema = z.enum(CONTENT_READINESS);

export const supportedSourceSchema = z.enum(SOURCE_KINDS);

export const screeningItemSchema = z.object({
  sourceItemId: z.string(),
  decision: z.enum(["skip", "retain"]),
  rationale: z.string(),
  ownerSuggestion: z.string().optional(),
  createOrEnrich: z.enum(["create", "enrich", "unknown"]),
  relevanceScore: z.number().min(0).max(1),
  sensitivityFlag: z.boolean(),
  sensitivityCategories: z.array(z.string()),
  // Structural reading — all optional so older prompts / fallbacks still validate.
  literalReading: z.string().optional(),
  structuralReading: z.string().optional(),
  hasStructuralSignificance: z.boolean().optional(),
  needsFirstPartyCorroboration: z.boolean().optional()
});
export const screeningBatchSchema = z.object({
  items: z.array(screeningItemSchema)
});

export const angleQualitySignalsSchema = z.object({
  specificity: z.string(),
  consequence: z.string(),
  tensionOrContrast: z.string(),
  traceableEvidence: z.string(),
  positionSharpening: z.string()
});

export const createEnrichDecisionSchema = z.object({
  action: z.enum(["create", "enrich", "skip"]),
  targetOpportunityId: z.string().optional(),
  rationale: z.string(),
  // Opportunity fields — required for create/enrich, allowed empty on skip.
  // Policy enforcement is in the quality gate, not the schema.
  title: z.string(),
  ownerDisplayName: z.string().optional(),
  territory: z.string(),
  angle: z.string(),
  whyNow: z.string(),
  whatItIsAbout: z.string(),
  whatItIsNotAbout: z.string(),
  suggestedFormat: z.string(),
  confidence: z.number().min(0).max(1),
  // Editorial angle contract
  editorialClaim: z.string().optional(),
  angleQualitySignals: angleQualitySignalsSchema.optional(),
  skipReasons: z.array(z.string()).optional(),
  // GTM fields
  targetSegment: z.string().optional(),
  editorialPillar: z.string().optional(),
  awarenessTarget: z.string().optional(),
  buyerFriction: z.string().optional(),
  contentMotion: z.string().optional()
});

export const marketResearchSummarySchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  keyFindings: z.array(z.object({
    claim: z.string().min(1),
    supportingResultIndices: z.array(z.number().int().min(0)).min(1)
  }))
});
