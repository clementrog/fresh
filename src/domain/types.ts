export const PROFILE_IDS = [
  "baptiste",
  "thomas",
  "virginie",
  "quentin",
  "linc-corporate"
] as const;

export type ProfileId = (typeof PROFILE_IDS)[number];

export const SENSITIVITY_CATEGORIES = [
  "client-identifiable",
  "payroll-sensitive",
  "roadmap-sensitive",
  "internal-only",
  "recruiting-sensitive",
  "financial-sensitive"
] as const;

export type SensitivityCategory = (typeof SENSITIVITY_CATEGORIES)[number];

export const SIGNAL_TYPES = [
  "objection",
  "friction",
  "product-insight",
  "user-language",
  "market-pattern",
  "process-lesson",
  "adoption-blocker",
  "quote",
  "decision-rationale",
  "tradeoff",
  "recurring-theme"
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

export const SOURCE_KINDS = ["slack", "notion", "claap", "linear", "market-findings"] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SLACK_INGESTION_MODES = ["full", "threads_only", "mentions_only"] as const;

export type SlackIngestionMode = (typeof SLACK_INGESTION_MODES)[number];

export const CONTENT_READINESS = [
  "Opportunity only",
  "Draft candidate",
  "V1 generated"
] as const;

export type ContentReadiness = (typeof CONTENT_READINESS)[number];

export const CONTENT_STATUS = [
  "To review",
  "Needs routing",
  "To enrich",
  "Ready for V1",
  "V1 generated",
  "Selected",
  "V2 in progress",
  "Waiting approval",
  "Rejected",
  "Archived"
] as const;

export type ContentStatus = (typeof CONTENT_STATUS)[number];

export const SIGNAL_STATUS = [
  "New",
  "Reviewed",
  "Converted",
  "Ignored",
  "Archived",
  "Sensitive review"
] as const;

export type SignalStatus = (typeof SIGNAL_STATUS)[number];

export type RunType =
  | "ingest:run"
  | "intelligence:run"
  | "draft:generate"
  | "server:start"
  | "setup:notion"
  | "sync:daily"
  | "digest:send"
  | "selection:scan"
  | "profile:weekly-recompute"
  | "cleanup:retention"
  | "backfill"
  | "repair:opportunity-evidence";

export interface RateLimitConfig {
  requestsPerMinute: number;
  maxRetries: number;
  initialDelayMs: number;
}

export interface SourceSyncConfig {
  source: SourceKind;
  enabled: boolean;
  storeRawText: boolean;
  retentionDays: number;
  rateLimit: RateLimitConfig;
}

export interface SlackChannelConfig {
  channelId: string;
  mode: SlackIngestionMode;
  enabled: boolean;
}

export interface SlackSourceConfig extends SourceSyncConfig {
  source: "slack";
  channels: SlackChannelConfig[];
}

export interface NotionSourceConfig extends SourceSyncConfig {
  source: "notion";
  pageAllowlist: string[];
  databaseAllowlist: string[];
  excludedDatabaseNames: string[];
}

export interface ClaapSourceConfig extends SourceSyncConfig {
  source: "claap";
  workspaceIds: string[];
  folderIds: string[];
}

export interface LinearSourceConfig extends SourceSyncConfig {
  source: "linear";
  workspaceIds: string[];
  includeIssues: boolean;
  includeProjectUpdates: boolean;
  includeIssueComments: boolean;
}

export interface MarketFindingsSourceConfig extends SourceSyncConfig {
  source: "market-findings";
  directory: string;
}

export type ConnectorConfig =
  | SlackSourceConfig
  | NotionSourceConfig
  | ClaapSourceConfig
  | LinearSourceConfig
  | MarketFindingsSourceConfig;

export interface RawSourceItem {
  id: string;
  cursor: string;
  payload: Record<string, unknown>;
}

export interface NormalizedSourceItem {
  source: SourceKind;
  sourceItemId: string;
  externalId: string;
  sourceFingerprint: string;
  sourceUrl: string;
  title: string;
  text: string;
  summary: string;
  authorName?: string;
  speakerName?: string;
  occurredAt: string;
  ingestedAt: string;
  metadata: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  rawText?: string | null;
  chunks?: string[];
}

export interface EvidenceReference {
  id: string;
  source: SourceKind;
  sourceItemId: string;
  sourceUrl: string;
  timestamp: string;
  excerpt: string;
  excerptHash: string;
  speakerOrAuthor?: string;
  freshnessScore: number;
}

export interface SensitivityAssessment {
  blocked: boolean;
  categories: SensitivityCategory[];
  rationale: string;
  stageOneMatchedRules: string[];
  stageTwoScore: number;
}

export interface EditorialSignal {
  id: string;
  sourceFingerprint: string;
  title: string;
  summary: string;
  type: SignalType;
  freshness: number;
  confidence: number;
  probableOwnerProfile?: ProfileId;
  suggestedAngle: string;
  status: SignalStatus;
  evidence: EvidenceReference[];
  sourceItemIds: string[];
  duplicateOfSignalId?: string;
  themeClusterKey?: string;
  sensitivity: SensitivityAssessment;
  notionPageId?: string;
  notionPageFingerprint: string;
}

export interface ThemeCluster {
  key: string;
  title: string;
  profileHint?: ProfileId;
  signalIds: string[];
  evidenceCount: number;
}

export interface TerritoryAssignment {
  profileId?: ProfileId;
  territory: string;
  confidence: number;
  needsRouting: boolean;
  rationale: string;
}

export interface ProfileBase {
  profileId: ProfileId;
  role: string;
  languagePreference: string;
  toneSummary: string;
  preferredStructure: string;
  typicalPhrases: string[];
  avoidRules: string[];
  contentTerritories: string[];
  weakFitTerritories: string[];
  sampleExcerpts: string[];
  sourcePath: string;
  notionPageId?: string;
  notionPageFingerprint: string;
}

export interface ProfileLearnedLayer {
  profileId: ProfileId;
  recurringPhrases: string[];
  structuralPatterns: string[];
  evidenceExcerptIds: string[];
  lastIncrementalUpdateAt: string;
  lastWeeklyRecomputeAt?: string;
}

export interface ProfileSnapshot {
  profileId: ProfileId;
  toneSummary: string;
  preferredStructure: string;
  recurringPhrases: string[];
  avoidRules: string[];
  contentTerritories: string[];
  weakFitTerritories: string[];
  sampleExcerpts: string[];
  baseSource: string;
  learnedExcerptCount: number;
  weeklyRecomputedAt?: string;
  notionPageId?: string;
  notionPageFingerprint: string;
}

export interface ScreeningResult {
  decision: "skip" | "retain";
  rationale: string;
  ownerSuggestion?: string;
  createOrEnrich: "create" | "enrich" | "unknown";
  relevanceScore: number;
  sensitivityFlag: boolean;
  sensitivityCategories: string[];
}

export interface EnrichmentLogEntry {
  createdAt: string;
  rawSourceItemId: string;
  evidenceIds: string[];
  contextComment: string;
  suggestedAngleUpdate?: string;
  suggestedWhyNowUpdate?: string;
  ownerSuggestionUpdate?: string;
  confidence: number;
  reason: string;
}

export interface CreateEnrichDecision {
  action: "create" | "enrich" | "skip";
  targetOpportunityId?: string;
  rationale: string;
  title: string;
  ownerDisplayName?: string;
  territory: string;
  angle: string;
  whyNow: string;
  whatItIsAbout: string;
  whatItIsNotAbout: string;
  suggestedFormat: string;
  confidence: number;
}

export interface ContentOpportunity {
  id: string;
  sourceFingerprint: string;
  title: string;
  ownerProfile?: ProfileId;
  ownerUserId?: string;
  companyId?: string;
  narrativePillar: string;
  angle: string;
  whyNow: string;
  whatItIsAbout: string;
  whatItIsNotAbout: string;
  relatedSignalIds: string[];
  evidence: EvidenceReference[];
  primaryEvidence: EvidenceReference;
  supportingEvidenceCount: number;
  evidenceFreshness: number;
  evidenceExcerpts: string[];
  routingStatus: "Routed" | "Needs routing";
  readiness: ContentReadiness;
  status: ContentStatus;
  suggestedFormat: string;
  enrichmentLog: EnrichmentLogEntry[];
  editorialOwner?: string;
  selectedAt?: string;
  lastDigestAt?: string;
  v1History: string[];
  notionPageId?: string;
  notionPageFingerprint: string;
}

export interface DraftV1 {
  id: string;
  opportunityId: string;
  profileId: ProfileId;
  proposedTitle: string;
  hook: string;
  summary: string;
  whatItIsAbout: string;
  whatItIsNotAbout: string;
  visualIdea: string;
  firstDraftText: string;
  sourceEvidence: EvidenceReference[];
  confidenceScore: number;
  language: string;
  createdAt: string;
}

export interface SyncRunCounters {
  fetched: number;
  normalized: number;
  sensitivityBlocked: number;
  signalsCreated: number;
  opportunitiesCreated: number;
  draftsCreated: number;
  llmFallbacks: number;
  llmValidationFailures: number;
  notionCreates: number;
  notionUpdates: number;
}

export interface LlmStepStats {
  calls: number;
  fallbacks: number;
  validationFailures: number;
}

export interface LlmRunStats {
  totalCalls: number;
  totalFallbacks: number;
  totalValidationFailures: number;
  byStep: Record<string, LlmStepStats>;
}

export interface SyncRun {
  id: string;
  companyId?: string;
  runType: RunType;
  source?: SourceKind;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  counters: SyncRunCounters;
  llmStats: LlmRunStats;
  warnings: string[];
  notes?: string;
  notionPageId?: string;
  notionPageFingerprint: string;
}

export interface CostLedgerEntry {
  id: string;
  step: string;
  model: string;
  mode: "provider" | "fallback";
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  runId: string;
  createdAt: string;
}

export interface RunContext {
  dryRun: boolean;
  now: Date;
  companySlug?: string;
  opportunityId?: string;
  port?: number;
}

export type LlmProvider = "openai" | "anthropic";

export interface CompanyRecord {
  id: string;
  slug: string;
  name: string;
  defaultTimezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface EditorialConfigRecord {
  id: string;
  companyId: string;
  version: number;
  layer1CompanyLens: Record<string, unknown>;
  layer2ContentPhilosophy: Record<string, unknown>;
  layer3LinkedInCraft: Record<string, unknown>;
  createdAt: string;
}

export interface UserRecord {
  id: string;
  companyId: string;
  displayName: string;
  type: "human" | "corporate";
  language: string;
  baseProfile: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SourceConfigRecord {
  id: string;
  companyId: string;
  source: string;
  enabled: boolean;
  configJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MarketQueryRecord {
  id: string;
  companyId: string;
  query: string;
  enabled: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface HealthcheckResult {
  source: SourceKind;
  ok: boolean;
  details?: string;
}

export interface NotionSelectionRow {
  notionPageId: string;
  fingerprint: string;
  editorialOwner: string;
}

export interface NotionSyncResult {
  notionPageId: string;
  action: "created" | "updated";
}

export interface NotionDatabaseBinding {
  name: string;
  parentPageId: string;
  databaseId: string;
  createdAt?: string;
  updatedAt?: string;
}

export type DigestDispatchStatus = "pending" | "sent" | "failed";

export interface DigestDispatch {
  digestKey: string;
  status: DigestDispatchStatus;
  channel: string;
  opportunityIds: string[];
  slackMessageTs?: string;
  sentAt?: string;
  leaseExpiresAt?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SourceConnector<TConfig extends ConnectorConfig = ConnectorConfig> {
  readonly source: SourceKind;
  healthcheck(config: TConfig): Promise<HealthcheckResult>;
  fetchSince(cursor: string | null, config: TConfig, context: RunContext): Promise<RawSourceItem[]>;
  normalize(rawItem: RawSourceItem, config: TConfig, context: RunContext): Promise<NormalizedSourceItem>;
  backfill(range: { from: Date; to: Date }, config: TConfig, context: RunContext): Promise<RawSourceItem[]>;
  cleanup(retentionPolicy: { retentionDays: number }, context: RunContext): Promise<number>;
}
