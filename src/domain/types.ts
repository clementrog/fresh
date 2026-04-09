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

export const SOURCE_KINDS = ["notion", "claap", "linear", "market-findings", "market-research", "hubspot", "github"] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

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

// --- GTM classification enums ---

export const TARGET_SEGMENTS = ["cabinet-owner", "production-manager", "payroll-manager", "it-lead"] as const;
export type TargetSegment = (typeof TARGET_SEGMENTS)[number];

export const EDITORIAL_PILLARS = ["insight", "proof", "perspective", "personality"] as const;
export type EditorialPillar = (typeof EDITORIAL_PILLARS)[number];

export const AWARENESS_TARGETS = ["unaware", "problem-aware", "solution-aware", "active-buyer"] as const;
export type AwarenessTarget = (typeof AWARENESS_TARGETS)[number];

export const CONTENT_MOTIONS = ["category", "demand-capture", "trust", "recruiting"] as const;
export type ContentMotion = (typeof CONTENT_MOTIONS)[number];

// --- GTM normalization (single boundary function) ---

function normalizeGtmEnum<T extends string>(value: string | null | undefined, allowed: readonly T[]): T | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  return (allowed as readonly string[]).includes(trimmed) ? trimmed as T : undefined;
}

function normalizeGtmFreeform(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalize a GTM field for operator-edit persistence.
 *
 * Input semantics:
 *  - undefined → field absent from source → undefined (skip write, preserve existing DB value)
 *  - null      → operator explicitly cleared → "" (persists clear to DB)
 *  - ""        → operator explicitly cleared → "" (persists clear to DB)
 *  - valid enum string → normalized lowercase (persists to DB)
 *  - non-empty invalid string → undefined (skip write, preserve existing DB value)
 */
function operatorEditGtmEnum<T extends string>(value: string | null | undefined, allowed: readonly T[]): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "";
  const trimmed = value.trim();
  if (trimmed === "") return "";
  const lower = trimmed.toLowerCase();
  return (allowed as readonly string[]).includes(lower) ? lower : undefined;
}

function operatorEditGtmFreeform(value: string | null | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "";
  return value.trim();
}

export function normalizeGtmFieldsForOperatorEdit(raw: {
  targetSegment?: string | null;
  editorialPillar?: string | null;
  awarenessTarget?: string | null;
  buyerFriction?: string | null;
  contentMotion?: string | null;
}): {
  targetSegment?: string;
  editorialPillar?: string;
  awarenessTarget?: string;
  buyerFriction?: string;
  contentMotion?: string;
} {
  return {
    targetSegment: operatorEditGtmEnum(raw.targetSegment, TARGET_SEGMENTS),
    editorialPillar: operatorEditGtmEnum(raw.editorialPillar, EDITORIAL_PILLARS),
    awarenessTarget: operatorEditGtmEnum(raw.awarenessTarget, AWARENESS_TARGETS),
    buyerFriction: operatorEditGtmFreeform(raw.buyerFriction),
    contentMotion: operatorEditGtmEnum(raw.contentMotion, CONTENT_MOTIONS),
  };
}

export function normalizeGtmFields(raw: {
  targetSegment?: string | null;
  editorialPillar?: string | null;
  awarenessTarget?: string | null;
  buyerFriction?: string | null;
  contentMotion?: string | null;
}): {
  targetSegment?: string;
  editorialPillar?: string;
  awarenessTarget?: string;
  buyerFriction?: string;
  contentMotion?: string;
} {
  return {
    targetSegment: normalizeGtmEnum(raw.targetSegment, TARGET_SEGMENTS),
    editorialPillar: normalizeGtmEnum(raw.editorialPillar, EDITORIAL_PILLARS),
    awarenessTarget: normalizeGtmEnum(raw.awarenessTarget, AWARENESS_TARGETS),
    buyerFriction: normalizeGtmFreeform(raw.buyerFriction),
    contentMotion: normalizeGtmEnum(raw.contentMotion, CONTENT_MOTIONS),
  };
}

export type RunType =
  | "ingest:run"
  | "market-research:run"
  | "intelligence:run"
  | "draft:generate"
  | "draft:generate-ready"
  | "server:start"
  | "cleanup:retention"
  | "backfill:evidence"
  | "cleanup:claap-publishability"
  | "tone:inspect"
  | "sales:sync"
  | "sales:extract"
  | "sales:detect"
  | "sales:match"
  | "sales:cleanup";

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
  maxRecordingsPerRun: number;
}

export interface LinearSourceConfig extends SourceSyncConfig {
  source: "linear";
  workspaceIds: string[];
  includeIssues: boolean;
  includeProjectUpdates: boolean;
  includeIssueComments: boolean;
  teamKeys?: string[];
  includeProjects?: boolean;
  projectStateFilter?: string[];
}

export interface MarketFindingsSourceConfig extends SourceSyncConfig {
  source: "market-findings";
  directory: string;
}

export interface GitHubSourceConfig extends SourceSyncConfig {
  source: "github";
  orgSlug: string;
  repos: string[];
  includeMergedPRs: boolean;
  includeClosedIssues: boolean;
  includeReleases: boolean;
  labelFilters?: { include?: string[]; exclude?: string[] };
  maxItemsPerRun?: number;
}

export interface MarketResearchRuntimeConfig {
  enabled: boolean;
  storeRawText: boolean;
  retentionDays: number;
  rateLimit: RateLimitConfig;
  maxResultsPerQuery: number;
}

export type ConnectorConfig =
  | NotionSourceConfig
  | ClaapSourceConfig
  | LinearSourceConfig
  | MarketFindingsSourceConfig
  | GitHubSourceConfig;

export interface RawSourceItem {
  id: string;
  cursor: string;
  payload: Record<string, unknown>;
}

export interface FetchResult {
  items: RawSourceItem[];
  /**
   * Authoritative resume cursor set by the connector.
   * - Non-null: caller MUST persist this value as-is (no derivation).
   * - Null: connector does not manage its own cursor; caller falls back
   *   to deriving cursor from items via maxCursorValue().
   */
  nextCursor: string | null;
  /** Per-partition warnings (e.g., repo-level failures). */
  warnings: string[];
  /** True if not all available items were returned (cap hit, partition failure, budget exhaustion). */
  partialCompletion: boolean;
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
  speakerAliases: string[];
  sampleExcerpts: string[];
  sourcePath: string;
  /** @compat Retained for Prisma schema backward compatibility. Written on upsert but never used for routing or display. Remove with follow-up schema migration. */
  notionPageId?: string;
  /** @compat Retained for Prisma schema backward compatibility (non-nullable column). Written on upsert but never used for routing or display. Remove with follow-up schema migration. */
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
  /** True when the result came from a fallback path (LLM unavailable or partial response). Items with fallback=true should not be marked as processed so they can be retried. */
  fallback?: boolean;
  // --- Structural reading (filled by screening LLM when it can) ---
  /** One-sentence summary of the LITERAL (operational/concrete) reading of the signal. */
  literalReading?: string;
  /** One-sentence summary of the STRUCTURAL (market/category/wedge/speed) reading, if any. */
  structuralReading?: string;
  /** True when the signal materially reveals something broader than the incident — a
   *  pattern about the market, category shift, company wedge, or execution speed. */
  hasStructuralSignificance?: boolean;
  /** True when this synthesized-market signal would need first-party proof to
   *  legitimately drive founder (baptiste), product-lead (virginie), or
   *  corporate voices. Advisory from the LLM; enforcement happens in the
   *  deterministic routing gate. */
  needsFirstPartyCorroboration?: boolean;
  /** The owner originally suggested by the LLM, preserved for audit when the
   *  deterministic routing gate has overridden or cleared `ownerSuggestion`. */
  llmOwnerSuggestion?: string;
}

export interface EnrichmentLogEntry {
  createdAt: string;
  rawSourceItemId: string;
  evidenceIds: string[];
  contextComment: string;
  suggestedAngleUpdate?: string;
  suggestedWhyNowUpdate?: string;
  suggestedEditorialClaimUpdate?: string;
  ownerSuggestionUpdate?: string;
  confidence: number;
  reason: string;
  provenanceType?: string;
  originSourceUrl?: string;
  originExcerpts?: string[];
}

export type ReadinessTier = "ready" | "promising" | "needs-more-proof";

export type ClaimPosture = "insight-only" | "customer-pain" | "product-claim" | "mixed";
export type ProductBackingState = "backed-live" | "backed-in-progress" | "unbacked";

export interface DraftReadinessAssessment {
  status: "ready" | "needs-more-proof";
  hasOriginatingSource: boolean;
  hasSupportingEvidence: boolean;
  hasConcreteAngle: boolean;
  hasDraftableMaterial: boolean;
  missingElements: string[];
  readinessTier: ReadinessTier;
  operatorGuidance: string[];
  claimPosture: ClaimPosture;
  productBacking: ProductBackingState;
}

export interface AngleQualitySignals {
  specificity: string;
  consequence: string;
  tensionOrContrast: string;
  traceableEvidence: string;
  positionSharpening: string;
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
  editorialClaim?: string;
  angleQualitySignals?: AngleQualitySignals;
  skipReasons?: string[];
  targetSegment?: string;
  editorialPillar?: string;
  awarenessTarget?: string;
  buyerFriction?: string;
  contentMotion?: string;
}

export interface ContentOpportunity {
  id: string;
  sourceFingerprint: string;
  title: string;
  ownerProfile?: ProfileId;
  ownerUserId?: string;
  companyId?: string;
  narrativePillar?: string;
  targetSegment?: string;
  editorialPillar?: string;
  awarenessTarget?: string;
  buyerFriction?: string;
  contentMotion?: string;
  angle: string;
  editorialClaim?: string;
  whyNow: string;
  whatItIsAbout: string;
  whatItIsNotAbout: string;
  evidence: EvidenceReference[];
  primaryEvidence: EvidenceReference;
  supportingEvidenceCount: number;
  evidenceFreshness: number;
  evidenceExcerpts: string[];
  routingStatus?: string;
  readiness?: ContentReadiness;
  status: ContentStatus;
  suggestedFormat: string;
  enrichmentLog: EnrichmentLogEntry[];
  editorialOwner?: string;
  editorialNotes?: string;
  dedupFlag?: string;
  /** @compat Retained for Prisma schema backward compatibility. Read from DB rows but never acted on. Remove with follow-up schema migration. */
  notionEditsPending?: boolean;
  selectedAt?: string;
  v1History?: string[];
  /** @compat Retained for Prisma schema backward compatibility. Written on upsert but never used for routing or display. Remove with follow-up schema migration. */
  notionPageId?: string;
  /** @compat Retained for Prisma schema backward compatibility (non-nullable column). Written on upsert but never used for routing or display. Remove with follow-up schema migration. */
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
  opportunitiesCreated: number;
  draftsCreated: number;
  llmFallbacks: number;
  llmValidationFailures: number;
  /** @compat Always 0 after Notion output removal. Retained for Prisma countersJson backward compatibility. Remove with follow-up schema migration. */
  notionCreates: number;
  /** @compat Always 0 after Notion output removal. Retained for Prisma countersJson backward compatibility. Remove with follow-up schema migration. */
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
  /** @compat Retained for Prisma schema backward compatibility. Written on upsert but never used for routing or display. Remove with follow-up schema migration. */
  notionPageId?: string;
  /** @compat Retained for Prisma schema backward compatibility (non-nullable column). Written on upsert but never used for routing or display. Remove with follow-up schema migration. */
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

export type LlmProvider = "openai" | "anthropic" | "claude-cli";

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

export interface SourceConnector<TConfig extends ConnectorConfig = ConnectorConfig> {
  readonly source: SourceKind;
  healthcheck(config: TConfig): Promise<HealthcheckResult>;
  fetchSince(cursor: string | null, config: TConfig, context: RunContext): Promise<RawSourceItem[]>;
  /** Optional: return structured result with authoritative cursor. */
  fetchSinceV2?(cursor: string | null, config: TConfig, context: RunContext): Promise<FetchResult>;
  normalize(rawItem: RawSourceItem, config: TConfig, context: RunContext): Promise<NormalizedSourceItem>;
  backfill(range: { from: Date; to: Date }, config: TConfig, context: RunContext): Promise<RawSourceItem[]>;
  cleanup(retentionPolicy: { retentionDays: number }, context: RunContext): Promise<number>;
}
