import { z } from "zod";

import {
  CONTENT_READINESS,
  CONTENT_STATUS,
  PROFILE_IDS,
  SENSITIVITY_CATEGORIES,
  SIGNAL_STATUS,
  SIGNAL_TYPES,
  SLACK_INGESTION_MODES,
  SOURCE_KINDS
} from "../domain/types.js";

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NOTION_TOKEN: z.string().default(""),
  NOTION_PARENT_PAGE_ID: z.string().default(""),
  SLACK_BOT_TOKEN: z.string().default(""),
  SLACK_EDITORIAL_OPERATOR_ID: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  CLAAP_API_KEY: z.string().default(""),
  LINEAR_API_KEY: z.string().default(""),
  DEFAULT_TIMEZONE: z.string().default("Europe/Paris"),
  LLM_MODEL: z.string().default("gpt-4.1-mini"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  LOG_LEVEL: z.string().default("info")
});

export const rateLimitSchema = z.object({
  requestsPerMinute: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  initialDelayMs: z.number().int().nonnegative()
});

export const slackChannelSchema = z.object({
  channelId: z.string().min(1),
  mode: z.enum(SLACK_INGESTION_MODES),
  enabled: z.boolean()
});

const sourceBaseSchema = z.object({
  enabled: z.boolean(),
  storeRawText: z.boolean(),
  retentionDays: z.number().int().positive(),
  rateLimit: rateLimitSchema
});

export const slackSourceConfigSchema = sourceBaseSchema.extend({
  source: z.literal("slack"),
  channels: z.array(slackChannelSchema)
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
  folderIds: z.array(z.string())
});

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
  slackSourceConfigSchema,
  notionSourceConfigSchema,
  claapSourceConfigSchema,
  linearSourceConfigSchema,
  marketFindingsSourceConfigSchema
]);

export const llmSignalSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  type: z.enum(SIGNAL_TYPES),
  freshness: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  probableOwnerProfile: z.enum(PROFILE_IDS).optional(),
  suggestedAngle: z.string().min(1),
  status: z.enum(SIGNAL_STATUS),
  evidenceIds: z.array(z.string()).min(1)
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
  firstDraftText: z.string().min(1),
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

export const territoryOutputSchema = z.object({
  profileId: z.enum(PROFILE_IDS).optional(),
  territory: z.string().min(1),
  confidence: z.number().min(0).max(1),
  needsRouting: z.boolean(),
  rationale: z.string()
});

export const opportunityStatusSchema = z.enum(CONTENT_STATUS);
export const readinessSchema = z.enum(CONTENT_READINESS);

export const notionDatabaseNameSchema = z.enum([
  "Signal Feed",
  "Content Opportunities",
  "Profiles",
  "Market Findings",
  "Sync Runs"
]);

export const supportedSourceSchema = z.enum(SOURCE_KINDS);
