// ---------------------------------------------------------------------------
// Sales signal types
// ---------------------------------------------------------------------------

export const SALES_SIGNAL_TYPES = [
  "feature_shipped",
  "proof_created",
  "deal_state_change",
  "content_published",
  "market_event",
  "competitor_mentioned",
  "blocker_identified",
  "next_step_missing",
  "urgent_timeline",
  "deal_stale",
  "positive_momentum",
  "negative_momentum",
  "champion_identified",
  "budget_surfaced",
  "deal_going_cold",
  "lead_engaged",
  "lead_ready_for_deal",
  "lead_re_engaged"
] as const;

export type SalesSignalType = (typeof SALES_SIGNAL_TYPES)[number];

// ---------------------------------------------------------------------------
// Recommendation lifecycle
// ---------------------------------------------------------------------------

export const RECOMMENDATION_STATUSES = [
  "new",
  "viewed",
  "drafted",
  "dismissed",
  "snoozed",
  "acted",
  "archived"
] as const;

export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export const DISMISS_REASONS = [
  "already_handled",
  "not_relevant",
  "bad_timing",
  "weak_proof",
  "wrong_angle"
] as const;

export type DismissReason = (typeof DISMISS_REASONS)[number];

export const NEXT_STEP_TYPES = [
  "email_follow_up",
  "linkedin_message",
  "send_proof_asset",
  "reactivation_call"
] as const;

export type NextStepType = (typeof NEXT_STEP_TYPES)[number];

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

// ---------------------------------------------------------------------------
// Structured extraction categories (the 7 allowed by PRD section 8.3)
// ---------------------------------------------------------------------------

export const EXTRACTION_CATEGORIES = [
  "objection_mentioned",
  "requested_capability",
  "competitor_reference",
  "urgency_timing",
  "budget_sensitivity",
  "persona_stakeholder",
  "compliance_security",
  "sentiment"
] as const;

export type ExtractionCategory = (typeof EXTRACTION_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Analytics action types (per execution-readiness rule E)
// ---------------------------------------------------------------------------

export const RECOMMENDATION_ACTION_TYPES = [
  "surfaced",
  "opened",
  "detail_viewed",
  "drafted",
  "copied",
  "dismissed",
  "snoozed",
  "acted"
] as const;

export type RecommendationActionType = (typeof RECOMMENDATION_ACTION_TYPES)[number];

// ---------------------------------------------------------------------------
// HubSpot engagement types
// ---------------------------------------------------------------------------

export const ENGAGEMENT_TYPES = ["email", "note", "call", "meeting"] as const;

export type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Draft channel types
// ---------------------------------------------------------------------------

export const CHANNEL_TYPES = ["email", "linkedin_message"] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];

// ---------------------------------------------------------------------------
// Record interfaces (map to Prisma models)
// ---------------------------------------------------------------------------

export interface SalesDealRecord {
  id: string;
  companyId: string;
  hubspotDealId: string;
  dealName: string;
  pipeline: string;
  stage: string;
  amount: number | null;
  ownerEmail: string | null;
  hubspotOwnerId: string | null;
  lastActivityDate: Date | null;
  closeDateExpected: Date | null;
  propertiesJson: Record<string, unknown>;
  staleDays: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SalesContactRecord {
  id: string;
  companyId: string;
  hubspotContactId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  propertiesJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface SalesHubspotCompanyRecord {
  id: string;
  companyId: string;
  hubspotCompanyId: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: string | null;
  propertiesJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface SalesActivityRecord {
  id: string;
  companyId: string;
  hubspotEngagementId: string;
  type: EngagementType;
  body: string | null;
  timestamp: Date;
  dealId: string | null;
  contactId: string | null;
  extractedAt: Date | null;
  rawTextExpiresAt: Date | null;
  rawTextCleaned: boolean;
  createdAt: Date;
}

export interface SalesSignalRecord {
  id: string;
  companyId: string;
  signalType: SalesSignalType;
  title: string;
  description: string;
  sourceItemId: string | null;
  dealId: string | null;
  confidence: ConfidenceLevel;
  metadataJson: Record<string, unknown>;
  matchedAt: Date | null;
  detectedAt: Date;
  createdAt: Date;
}

export interface SalesExtractedFactRecord {
  id: string;
  companyId: string;
  activityId: string | null;
  dealId: string;
  category: ExtractionCategory;
  label: string;
  extractedValue: string;
  confidence: number;
  sourceText: string;
  createdAt: Date;
}

export interface SalesRecommendationRecord {
  id: string;
  companyId: string;
  dealId: string;
  signalId: string;
  userId: string | null;
  whyNow: string;
  recommendedAngle: string;
  nextStepType: NextStepType;
  matchedContextJson: Record<string, unknown>;
  confidence: ConfidenceLevel;
  priorityRank: number;
  status: RecommendationStatus;
  dismissReason: DismissReason | null;
  snoozedUntil: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecommendationActionRecord {
  id: string;
  recommendationId: string;
  userId: string | null;
  actionType: RecommendationActionType;
  reason: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: Date;
}

export interface SalesDraftRecord {
  id: string;
  companyId: string;
  recommendationId: string;
  channelType: ChannelType;
  subject: string | null;
  body: string;
  repProfileId: string | null;
  confidenceScore: number;
  createdAt: Date;
}

export interface SalesDoctrineRecord {
  id: string;
  companyId: string;
  version: number;
  doctrineJson: SalesDoctrineConfig;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Doctrine configuration shape
// ---------------------------------------------------------------------------

export interface SalesDoctrineConfig {
  hubspotPipelineId: string;
  recommendationGenerationEnabled: boolean;
  stalenessThresholdDays: number;
  minConfidenceToSurface: ConfidenceLevel;
  maxRecsPerDealPerWeek: number;
  maxRecsPerUserPerDay: number;
  dismissCooldownDays: number;
  meetingSuppressionDays: number;
  positioningRules: string[];
  followUpRules: string[];
  proofHierarchy: string[];
  personaGuidance: string[];
  exclusionRules: ExclusionRules;
  framingRules: string[];
  stageLabels?: Record<string, string>;
  intelligenceStages?: string[];
}

export interface ExclusionRules {
  excludedDealIds: string[];
  excludedStages: string[];
  minDealValue: number | null;
  lostDealCooldownDays: number;
}

// ---------------------------------------------------------------------------
// Rep style profile (stored in User.baseProfile JSON for Sales users)
// ---------------------------------------------------------------------------

export interface RepStyleProfile {
  tone: string;
  lengthPreference: "short" | "medium" | "long";
  directness: "direct" | "consultative" | "warm";
  language: string;
  openingStyle: string;
  closingStyle: string;
  signatureConventions: string;
}
