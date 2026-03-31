import { createDeterministicId, hashParts } from "../lib/ids.js";
import { hashText } from "../lib/ids.js";
import type {
  ContentOpportunity,
  CreateEnrichDecision,
  EnrichmentLogEntry,
  EvidenceReference,
  NormalizedSourceItem,
  PROFILE_IDS,
  ScreeningResult,
  UserRecord
} from "../domain/types.js";
import { PROFILE_IDS as PROFILE_ID_VALUES, normalizeGtmFields } from "../domain/types.js";
import {
  buildEvidenceReferences,
  dedupeEvidenceReferences,
  evidenceSignature,
  selectPrimaryEvidence
} from "./evidence.js";
import { screeningBatchSchema, createEnrichDecisionSchema, linearEnrichmentPolicySchema } from "../config/schema.js";
import type { LinearEnrichmentClassification } from "../config/schema.js";
import type { LlmClient, LlmUsage } from "./llm.js";
import { sourceItemDbId } from "../db/repositories.js";
import { isBlockedByPublishability } from "./evidence-pack.js";
import { resolveSpeakerContext, buildExtractionDepthBlock } from "../lib/speaker-context.js";
import type { SpeakerContextSource } from "../lib/speaker-context.js";
import { tokenizeV1, tokenizeV2, removeStopWords, jaccardSimilarity, hasMeaningfulOverlap, assessAngleSharpness } from "../lib/text.js";
import type { AngleSharpnessResult } from "../lib/text.js";
import type { AngleQualitySignals } from "../domain/types.js";

// --- Prefilter ---

export function prefilterSourceItems(
  items: NormalizedSourceItem[],
  opts: { freshnessWindowDays?: number } = {}
): { retained: NormalizedSourceItem[]; skipped: Array<{ item: NormalizedSourceItem; reason: string }> } {
  const windowDays = opts.freshnessWindowDays ?? 30;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const retained: NormalizedSourceItem[] = [];
  const skipped: Array<{ item: NormalizedSourceItem; reason: string }> = [];

  for (const item of items) {
    if (new Date(item.occurredAt).getTime() < cutoff) {
      skipped.push({ item, reason: `Older than ${windowDays} days` });
      continue;
    }
    if (item.text.trim().length < 20) {
      skipped.push({ item, reason: "Text too short (< 20 chars)" });
      continue;
    }
    retained.push(item);
  }

  return { retained, skipped };
}

// --- Screening ---

export async function screenSourceItems(params: {
  items: NormalizedSourceItem[];
  evidenceMap: Map<string, EvidenceReference[]>;
  llmClient: LlmClient;
  doctrineMarkdown: string;
  sensitivityMarkdown: string;
  userDescriptions: string;
}): Promise<{ results: Map<string, ScreeningResult>; usageEvents: Array<{ step: string; usage: LlmUsage }> }> {
  const results = new Map<string, ScreeningResult>();
  const usageEvents: Array<{ step: string; usage: LlmUsage }> = [];
  const batchSize = 15;

  for (let i = 0; i < params.items.length; i += batchSize) {
    const batch = params.items.slice(i, i + batchSize);
    const itemPrompts = batch.map((item) => {
      const evidence = params.evidenceMap.get(item.externalId) ?? [];
      const evidenceText = evidence.map((e) => `  - ${e.excerpt.slice(0, 200)}`).join("\n");
      return [
        `### Source item: ${item.externalId}`,
        `Title: ${item.title}`,
        `Summary: ${item.summary}`,
        `Text (first 1000 chars): ${item.text.slice(0, 1000)}`,
        evidence.length > 0 ? `Evidence excerpts:\n${evidenceText}` : ""
      ].filter(Boolean).join("\n");
    }).join("\n\n---\n\n");

    const system = [
      "You are an editorial intelligence agent. Your job is to screen source items for content opportunity potential.",
      "",
      "## Company Doctrine (Layer 1)",
      params.doctrineMarkdown,
      "",
      "## Sensitivity Rules",
      params.sensitivityMarkdown,
      "",
      "## Available owners and their territories",
      params.userDescriptions,
      "",
      "## Screening contract",
      "Apply the doctrine strictly. Default to skip.",
      "- Retain only if the item reveals something real about how cabinets buy, produce, control, migrate, or experience payroll (Doctrine §10: Retain).",
      "- Skip if the item is generic, internal-only, obvious, weakly sourced, or could come from any B2B SaaS company (Doctrine §7, §8, §11).",
      "- The quality bar is: specific, traceable, consequential, non-generic, position-sharpening (Doctrine §4). All five must plausibly hold.",
      "- Prefer proof over opinion, observations over slogans, frictions over abstractions.",
      "- When in doubt, skip. A retained item that is below the bar wastes all downstream pipeline stages.",
      "",
      "For each source item, decide: skip (not relevant) or retain (potential content opportunity).",
      "If retaining, suggest an owner displayName if obvious, and hint at create vs enrich.",
      "Return JSON with an 'items' array matching the screeningBatch schema."
    ].join("\n");

    const fallback = () => ({
      items: batch.map((item) => ({
        sourceItemId: item.externalId,
        decision: "skip" as const,
        rationale: "Fallback: skipped — LLM unavailable, requires retry",
        createOrEnrich: "unknown" as const,
        relevanceScore: 0,
        sensitivityFlag: false,
        sensitivityCategories: []
      }))
    });

    const response = await params.llmClient.generateStructured({
      step: "screening",
      system,
      prompt: itemPrompts,
      schema: screeningBatchSchema,
      allowFallback: true,
      fallback
    });

    usageEvents.push({ step: "screening", usage: response.usage });
    const isFallback = response.mode === "fallback";

    for (const result of response.output.items) {
      const screening: ScreeningResult = {
        decision: result.decision,
        rationale: result.rationale,
        ownerSuggestion: result.ownerSuggestion,
        createOrEnrich: result.createOrEnrich,
        relevanceScore: result.relevanceScore,
        sensitivityFlag: result.sensitivityFlag,
        sensitivityCategories: result.sensitivityCategories,
        fallback: isFallback || undefined
      };
      results.set(result.sourceItemId, screening);
    }

    // Fill in any items not returned by the LLM — fail-closed, retryable
    for (const item of batch) {
      if (!results.has(item.externalId)) {
        results.set(item.externalId, {
          decision: "skip",
          rationale: "Not returned by screening LLM — deferred for retry",
          createOrEnrich: "unknown",
          relevanceScore: 0,
          sensitivityFlag: false,
          sensitivityCategories: [],
          fallback: true
        });
      }
    }
  }

  return { results, usageEvents };
}

// --- Linear Enrichment Policy ---

const LINEAR_ENRICHMENT_FALLBACK: LinearEnrichmentClassification = {
  classification: "manual-review-needed",
  rationale: "LLM evaluation failed",
  customerVisibility: "ambiguous",
  sensitivityLevel: "safe",
  evidenceStrength: 0,
  reviewNote: "Automatic hold: LLM unavailable"
};

export async function evaluateLinearEnrichmentPolicy(params: {
  items: NormalizedSourceItem[];
  llmClient: LlmClient;
  doctrineMarkdown: string;
  sensitivityMarkdown: string;
}): Promise<{
  results: Map<string, LinearEnrichmentClassification>;
  usageEvents: Array<{ step: string; usage: LlmUsage }>;
}> {
  const results = new Map<string, LinearEnrichmentClassification>();
  const usageEvents: Array<{ step: string; usage: LlmUsage }> = [];

  const system = [
    "You are an editorial policy evaluator for a content pipeline. Your job is to classify Linear issues and project updates for enrichment eligibility.",
    "",
    "## Company Doctrine",
    params.doctrineMarkdown,
    "",
    "## Sensitivity Rules",
    params.sensitivityMarkdown,
    "",
    "## Classification rules",
    "",
    "Classify each Linear item into one of four categories:",
    "",
    "### editorial-lead",
    "The item has standalone editorial potential — it can anchor a new content opportunity, not just support an existing one.",
    "This tier is for SHIPPED features, completed projects, or major product announcements that tell a compelling story for payroll experts, accountants, or HR decision-makers.",
    "Strong signals for editorial-lead:",
    "- Project updates marked as completed with a product announcement (often starting with '🎉 Nouveauté produit')",
    "- Major feature launches: new convention support (e.g. HCR), new module (e.g. DSN filing), new portal or workflow",
    "- R&D or moonshot projects that reached completion: engine performance breakthroughs, new integrations (net-entreprises, SIRH), innovative UX (clickable PDF bulletins)",
    "- Items that combine: (1) a concrete shipped capability, (2) a clear benefit for end users, (3) enough substance to write a 500+ word article",
    "Examples: 'Nouveauté produit: le bulletin détaillé devient cliquable', 'HCR convention fully supported on Linc', 'DSN connection with net-entreprises deployed'",
    "",
    "### enrich-worthy",
    "The item describes a customer-visible, shipped capability or concrete outcome that can strengthen an existing content opportunity, but is too narrow for a standalone article.",
    "Examples: 'Shipped: new onboarding dashboard for mid-market clients', 'Released: automated DSN compliance check', 'CP counting in working days for HCR'",
    "",
    "### ignore",
    "The item is internal noise: refactors, tech debt, CI/CD fixes, dependency bumps, test improvements, or vague tickets with no customer-facing substance.",
    "Examples: 'Upgrade Node to v22', 'Fix flaky test in CI', 'Refactor auth middleware', 'Add logging to ingestion pipeline'",
    "",
    "### manual-review-needed",
    "The item is ambiguous, roadmap-sensitive, pre-shipping, or could be promise-like. It might have value but needs human judgment before enriching public content.",
    "Examples: 'Upcoming: AI-powered payroll suggestions', 'Q3 roadmap: compliance automation v2', 'Beta: predictive scheduling'",
    "",
    "## customerVisibility",
    "- shipped: already live and available to customers",
    "- in-progress: actively being built but not yet shipped",
    "- internal-only: internal tooling, infra, or process",
    "- ambiguous: unclear from the item text",
    "",
    "## sensitivityLevel",
    "- safe: no risk in referencing publicly",
    "- roadmap-sensitive: reveals future plans not yet announced",
    "- pre-shipping: work in progress that might not ship as described",
    "- promise-like: reads like a commitment to customers",
    "",
    "## Tie-breaking rules",
    "- Between editorial-lead and enrich-worthy: choose editorial-lead only when the item has enough substance and scope for a standalone article. A single narrow fix is enrich-worthy even if shipped.",
    "- Between enrich-worthy and manual-review-needed: choose manual-review-needed if the item is pre-shipping or roadmap-sensitive.",
    "- When genuinely unsure, choose manual-review-needed. It is always safer to hold an item for review than to auto-enrich or auto-ignore.",
    "",
    "Return JSON matching the linearEnrichmentPolicy schema."
  ].join("\n");

  for (const item of params.items) {
    const meta = item.metadata ?? {};
    const prompt = [
      "## Linear item to classify",
      `Title: ${item.title}`,
      `Summary: ${item.summary}`,
      `Text (first 1000 chars): ${item.text.slice(0, 1000)}`,
      `Item type: ${meta.itemType ?? "unknown"}`,
      `State: ${meta.stateName ?? meta.projectState ?? "unknown"}`,
      `Project health: ${meta.projectHealth ?? "n/a"}`,
      `Team: ${meta.teamName ?? "unknown"}`,
      `Priority: ${meta.priority ?? "unknown"}`,
      `Labels: ${Array.isArray(meta.labels) ? (meta.labels as string[]).join(", ") : "none"}`,
      `Project: ${meta.projectName ?? "none"}`,
      `Created at: ${meta.createdAt ?? "unknown"}`,
      `Completed at: ${meta.completedAt ?? "not completed"}`
    ].join("\n");

    try {
      const response = await params.llmClient.generateStructured({
        step: "linear-enrichment-policy",
        system,
        prompt,
        schema: linearEnrichmentPolicySchema,
        allowFallback: true,
        fallback: () => LINEAR_ENRICHMENT_FALLBACK
      });

      usageEvents.push({ step: "linear-enrichment-policy", usage: response.usage });
      results.set(item.externalId, response.output);
    } catch {
      results.set(item.externalId, LINEAR_ENRICHMENT_FALLBACK);
    }
  }

  return { results, usageEvents };
}

// --- Dedup configuration (env-var rollback switches) ---
// Thresholds below are TEMPORARY UNCALIBRATED DEFAULTS chosen by inspection,
// not by replay against labeled real data.  They must be validated via Phase 0
// baseline measurement before claiming calibration is complete.  Override with
// env vars for tuning; set DEDUP_WARNINGS_ENABLED=false to disable entirely.

export const DEDUP_CANDIDATE_WINDOW = parseInt(process.env.DEDUP_CANDIDATE_WINDOW ?? "200", 10);
export const DEDUP_SCORING_VERSION = (process.env.DEDUP_SCORING_VERSION ?? "v2") as "v1" | "v2";
export const DEDUP_WARNINGS_ENABLED = process.env.DEDUP_WARNINGS_ENABLED !== "false";
/** Temporary default — must be calibrated against labeled duplicate/non-duplicate pairs. */
export const DEDUP_WARNING_THRESHOLD = parseFloat(process.env.DEDUP_WARNING_THRESHOLD ?? "0.20");
/** Temporary default — must be calibrated against labeled duplicate/non-duplicate pairs. */
export const DEDUP_CONFIDENCE_CUTOFF = parseFloat(process.env.DEDUP_CONFIDENCE_CUTOFF ?? "0.70");

// --- Angle quality gate mode ---
// "v2" = full contract enforcement (default), "v1" = legacy length-only, "observe" = run v2 but use v1 verdict
export type AngleQualityGateMode = "v1" | "v2" | "observe";
/** Read at call time so tests can override via process.env */
export function getAngleQualityGateMode(): AngleQualityGateMode {
  return (process.env.ANGLE_QUALITY_GATE ?? "v2") as AngleQualityGateMode;
}
// Backwards-compat: exported constant for import convenience (reads at module load)
export const ANGLE_QUALITY_GATE = getAngleQualityGateMode();
/** Kill switch for displacement rescue — independent of warnings.  Set to "false" to disable. */
export const DEDUP_RESCUE_ENABLED = process.env.DEDUP_RESCUE_ENABLED !== "false";

// --- Extraction depth mode ---
// "observe" = resolve context + emit telemetry only (default), "enabled" = inject into prompts, "disabled" = same as observe
export type ExtractionDepthMode = "enabled" | "disabled" | "observe";
export function getExtractionDepthMode(): ExtractionDepthMode {
  return (process.env.EXTRACTION_DEPTH_MODE ?? "observe") as ExtractionDepthMode;
}

function tokenizeForScoring(text: string): Set<string> {
  if (DEDUP_SCORING_VERSION === "v1") {
    return new Set(tokenizeV1(text));
  }
  return new Set(removeStopWords(tokenizeV2(text)));
}

// --- Narrow Candidates ---

export interface CandidateResult {
  /** Top 5 candidates by boosted score, plus up to 2 displaced topical matches rescued by boost reordering. */
  candidates: ContentOpportunity[];
  /** Highest boosted score (includes owner/evidence boosts) — used for candidate ranking. */
  topScore: number;
  /** Highest raw topical Jaccard across ALL scored opportunities — used for duplicate warning thresholds. */
  topTopicalScore: number;
  /** Candidate with the highest boosted score — passed to LLM. */
  topCandidate?: ContentOpportunity;
  /** Candidate with the highest raw topical overlap — used for duplicate warning metadata.
   *  May differ from topCandidate when owner/evidence boosts reorder the ranking. */
  bestTopicalCandidate?: ContentOpportunity;
  /** Number of candidates rescued by displacement detection (0 when no boost reordering occurred). */
  rescuedCount: number;
}

export function narrowCandidateOpportunities(
  item: NormalizedSourceItem,
  screening: ScreeningResult,
  opportunities: ContentOpportunity[],
  companyId: string,
  opts: { enableOwnerBoost?: boolean; enableRescue?: boolean } = {}
): CandidateResult {
  const itemWords = tokenizeForScoring(`${item.title} ${item.summary}`);
  const itemDbId = sourceItemDbId(companyId, item.externalId);
  const enableOwnerBoost = opts.enableOwnerBoost ?? true;
  const enableRescue = opts.enableRescue ?? DEDUP_RESCUE_ENABLED;

  const scored = opportunities.map((opp) => {
    const oppWords = tokenizeForScoring(`${opp.title} ${opp.angle} ${opp.whatItIsAbout}`);
    const topicalScore = jaccardSimilarity(itemWords, oppWords);

    let boostedScore = topicalScore;
    if (enableOwnerBoost && screening.ownerSuggestion && opp.ownerProfile === screening.ownerSuggestion) {
      boostedScore += 0.2;
    }
    if (opp.evidence.some((e) => e.sourceItemId === itemDbId)) {
      boostedScore += 0.3;
    }

    return { opp, topicalScore, boostedScore };
  });

  // Best topical match — independent of boosts, across all scored opportunities
  let bestTopicalEntry: typeof scored[0] | undefined;
  for (const entry of scored) {
    if (!bestTopicalEntry || entry.topicalScore > bestTopicalEntry.topicalScore) {
      bestTopicalEntry = entry;
    }
  }

  // Primary ranking: top 5 by boosted score (legacy behavior)
  const boostedTop = scored
    .filter((entry) => entry.boostedScore > 0.05)
    .sort((a, b) => b.boostedScore - a.boostedScore)
    .slice(0, 5);

  // Displacement rescue: restore strong topical matches that boosts pushed out.
  // Compare boosted top-5 against raw-topical top-5.  Candidates in the topical
  // set but not the boosted set were displaced by owner/evidence boosts.
  let topicalRescue: typeof scored = [];
  if (enableRescue) {
    const topicalTop = scored
      .filter((entry) => entry.topicalScore > 0.05)
      .sort((a, b) => b.topicalScore - a.topicalScore)
      .slice(0, 5);

    const boostedIds = new Set(boostedTop.map((e) => e.opp.id));
    topicalRescue = topicalTop
      .filter((e) => !boostedIds.has(e.opp.id) && e.topicalScore >= 0.10)
      .slice(0, 2);
  }

  const filtered = [...boostedTop, ...topicalRescue];

  return {
    candidates: filtered.map((entry) => entry.opp),
    topScore: boostedTop.length > 0 ? boostedTop[0].boostedScore : 0,
    topTopicalScore: bestTopicalEntry?.topicalScore ?? 0,
    topCandidate: boostedTop.length > 0 ? boostedTop[0].opp : undefined,
    bestTopicalCandidate: bestTopicalEntry && bestTopicalEntry.topicalScore > 0
      ? bestTopicalEntry.opp : undefined,
    rescuedCount: topicalRescue.length
  };
}

// --- Create/Enrich Decision ---

type SourceCreationMode = "create-capable" | "enrich-only";

export function getSourceCreationMode(item: NormalizedSourceItem): SourceCreationMode {
  // This is intentionally based on the audited normalization shape emitted today:
  // - src/connectors/notion.ts sets metadata.notionKind for structured Notion insights/signals
  // - src/connectors/claap.ts does not emit an equivalent insight marker
  // - src/connectors/linear.ts emits operational itemType metadata only
  const notionKind = typeof item.metadata?.notionKind === "string" ? item.metadata.notionKind : undefined;

  switch (item.source) {
    case "market-research":
    case "market-findings":
      return "create-capable";
    case "notion":
      return notionKind === "market-insight" || notionKind === "claap-signal"
        ? "create-capable"
        : "enrich-only";
    case "claap": {
      const signalKind = typeof item.metadata?.signalKind === "string"
        ? item.metadata.signalKind : undefined;
      return signalKind === "claap-signal" ? "create-capable" : "enrich-only";
    }
    case "linear": {
      const linearClass = typeof item.metadata?.linearEnrichmentClassification === "string"
        ? item.metadata.linearEnrichmentClassification : undefined;
      return linearClass === "editorial-lead" ? "create-capable" : "enrich-only";
    }
    case "hubspot":
      return "enrich-only";
    default:
      return "enrich-only";
  }
}

function createBlockedBySourceReason(item: NormalizedSourceItem) {
  return `${item.source} items are evidence-shaped in the current pipeline and may only enrich an existing opportunity or be skipped.`;
}

function isCuratedSource(item: NormalizedSourceItem): boolean {
  const notionKind = typeof item.metadata?.notionKind === "string"
    ? item.metadata.notionKind : undefined;
  switch (item.source) {
    case "market-research":
    case "market-findings":
      return true;
    case "notion":
      return notionKind === "market-insight" || notionKind === "claap-signal";
    case "claap": {
      const signalKind = typeof item.metadata?.signalKind === "string"
        ? item.metadata.signalKind : undefined;
      return signalKind === "claap-signal";
    }
    case "linear": {
      const linearClass = typeof item.metadata?.linearEnrichmentClassification === "string"
        ? item.metadata.linearEnrichmentClassification : undefined;
      return linearClass === "editorial-lead";
    }
    case "hubspot":
      return false;
    default:
      return false;
  }
}

export function normalizeCreateEnrichDecision(params: {
  creationMode: SourceCreationMode;
  candidates: ContentOpportunity[];
  decision: CreateEnrichDecision;
  topCandidateScore: number;
  curated: boolean;
}): CreateEnrichDecision {
  const hasValidTarget = Boolean(
    params.decision.targetOpportunityId
    && params.candidates.some((candidate) => candidate.id === params.decision.targetOpportunityId)
  );
  const topCandidate = params.candidates[0];

  if (params.creationMode === "create-capable") {
    if (params.decision.action === "enrich" && params.decision.targetOpportunityId && !hasValidTarget) {
      return { ...params.decision, action: "create", targetOpportunityId: undefined };
    }
    // Ambiguous overlap: curated source with weak match and low LLM confidence → prefer create
    if (
      params.decision.action === "enrich"
      && params.curated
      && params.topCandidateScore < 0.3
      && params.decision.confidence < 0.6
    ) {
      return {
        ...params.decision,
        action: "create",
        targetOpportunityId: undefined,
        rationale: `${params.decision.rationale} Converted to create: curated source with weak candidate match (score ${params.topCandidateScore.toFixed(2)}) and low LLM confidence (${params.decision.confidence}).`
      };
    }
    return params.decision;
  }

  if (params.decision.action === "skip") {
    return {
      ...params.decision,
      targetOpportunityId: undefined
    };
  }

  if (params.decision.action === "enrich" && hasValidTarget) {
    return params.decision;
  }

  // Enrich-only sources can never create new opportunities. If we already found a plausible match,
  // convert create/invalid-enrich outputs into enrichment on the strongest candidate.
  if (topCandidate) {
    return {
      ...params.decision,
      action: "enrich",
      targetOpportunityId: topCandidate.id,
      rationale:
        params.decision.action === "create"
          ? `${params.decision.rationale} This source can only enrich existing opportunities, so the decision was converted to the strongest existing match.`
          : `${params.decision.rationale} The requested enrichment target was invalid, so the decision was converted to the strongest existing match.`
    };
  }

  return {
    ...params.decision,
    action: "skip",
    targetOpportunityId: undefined,
    rationale: `${params.decision.rationale} No existing opportunity matched closely enough, and this source cannot create new opportunities.`
  };
}

// --- Angle quality contract ---

export interface AngleContractDimensionResult {
  pass: boolean;
  reason: string;
}

export interface AngleContractResult {
  verdict: "pass" | "warn" | "fail";
  dimensionResults: {
    specificity: AngleContractDimensionResult;
    consequence: AngleContractDimensionResult;
    tensionOrContrast: AngleContractDimensionResult;
    traceableEvidence: AngleContractDimensionResult;
    positionSharpening: AngleContractDimensionResult;
  };
  sharpness: AngleSharpnessResult;
  passedCount: number;
  gateDecisionPath: string[];
}

export interface AngleQualityEvent {
  sourceItemId: string;
  angle: string;
  editorialClaim?: string;
  action: "passed" | "warned" | "blocked-skip" | "blocked-enrich" | "enrich-no-substance";
  gateMode: AngleQualityGateMode;
  contractResult: AngleContractResult | null;
  curated: boolean;
}

export interface SpeakerContextEvent {
  sourceItemId: string;
  speakerName?: string;
  profileHint?: string;
  resolved?: { profileId: string; role: string; source: SpeakerContextSource };
  depthMode: ExtractionDepthMode;
  promptModified: boolean;
}

const DOMAIN_TERMS_FOR_POSITION = /\b(linc|cabinet|cabinets|paie|payroll|dsn|hcr|ccn|dpae|bulletin|fiche|solde|regularisation|régularisation|migration|conformit|compliance)\b/i;

function checkDimension(
  signalValue: string | undefined,
  crossCheck: boolean,
  crossCheckReason: string
): AngleContractDimensionResult {
  const signalPresent = signalValue !== undefined
    && signalValue.trim().length >= 15
    && signalValue.trim().toLowerCase() !== "none";
  if (signalPresent && crossCheck) return { pass: true, reason: "signal and cross-check passed" };
  if (!signalPresent && crossCheck) return { pass: crossCheck, reason: "signal absent but cross-check passed" };
  if (signalPresent && !crossCheck) return { pass: false, reason: crossCheckReason };
  return { pass: false, reason: `signal ${signalPresent ? "present" : "absent"}; ${crossCheckReason}` };
}

export function evaluateAngleContract(params: {
  decision: CreateEnrichDecision;
  item: NormalizedSourceItem;
  evidence: EvidenceReference[];
  curated: boolean;
}): AngleContractResult {
  const { decision, item, evidence, curated } = params;
  const signals = decision.angleQualitySignals;
  const gateDecisionPath: string[] = [];

  // Deterministic sharpness assessment
  const sharpness = assessAngleSharpness(decision.angle, item.title);
  gateDecisionPath.push(`sharpness: ${sharpness.isSharp ? "pass" : `fail (${sharpness.failedChecks.join(", ")})`}`);

  // Cross-checks for each dimension
  const angleTokens = removeStopWords(tokenizeV2(decision.angle));
  const topicTokens = removeStopWords(tokenizeV2(decision.whatItIsAbout));
  const angleSet = new Set(angleTokens);
  const topicSet = new Set(topicTokens);
  const angleTopicJaccard = jaccardSimilarity(angleSet, topicSet);

  const specificity = checkDimension(
    signals?.specificity,
    angleTopicJaccard < 0.6,
    `angle too similar to topic (Jaccard ${angleTopicJaccard.toFixed(2)} >= 0.6)`
  );

  const consequenceText = (signals?.consequence ?? "").toLowerCase();
  const hasChangeLanguage = /\b(chang\w*|improv\w*|reduc\w*|increas\w*|eliminat\w*|enabl\w*|sav\w*|prevent\w*|decid\w*|prioritiz\w*|migrat\w*|organiz\w*|control\w*|explain\w*|review\w*|delay\w*|block\w*|cost\w*|acceler\w*|simplif\w*)\b/i.test(consequenceText);
  const consequence = checkDimension(
    signals?.consequence,
    hasChangeLanguage || (signals?.consequence === undefined && sharpness.checks.hasStake),
    "no action/change language in consequence"
  );

  const claimOrAngle = (decision.editorialClaim ?? decision.angle).toLowerCase();
  const hasTensionInClaim = sharpness.checks.hasStake;
  const tensionOrContrast = checkDimension(
    signals?.tensionOrContrast,
    hasTensionInClaim,
    "no tension/contrast in editorial claim or angle"
  );

  const hasSubstantiveEvidence = evidence.some((e) => e.excerpt && e.excerpt.trim().length >= 30);
  const traceableEvidence = checkDimension(
    signals?.traceableEvidence,
    hasSubstantiveEvidence,
    "no evidence excerpt >= 30 chars"
  );

  const posSignal = (signals?.positionSharpening ?? "").toLowerCase();
  const hasDomainRef = DOMAIN_TERMS_FOR_POSITION.test(posSignal) || DOMAIN_TERMS_FOR_POSITION.test(claimOrAngle);
  const positionSharpening = checkDimension(
    signals?.positionSharpening,
    hasDomainRef,
    "no domain term reference in position-sharpening"
  );

  const dimensionResults = { specificity, consequence, tensionOrContrast, traceableEvidence, positionSharpening };
  const allDims = Object.values(dimensionResults);
  const passedCount = allDims.filter((d) => d.pass).length;

  // Sharpness-critical dimensions (never relaxable)
  const criticalPass = specificity.pass && consequence.pass && tensionOrContrast.pass;
  // Evidence/positioning dimensions (relaxable for curated)
  const relaxablePass = traceableEvidence.pass && positionSharpening.pass;
  const relaxableCount = [traceableEvidence, positionSharpening].filter((d) => d.pass).length;

  let verdict: "pass" | "warn" | "fail";
  if (sharpness.isSharp && criticalPass && relaxablePass) {
    verdict = "pass";
    gateDecisionPath.push("all 5 dimensions passed");
  } else if (sharpness.isSharp && criticalPass && curated && relaxableCount >= 1) {
    verdict = "warn";
    gateDecisionPath.push(`curated warn: ${passedCount}/5 dimensions (${5 - passedCount} relaxed)`);
  } else {
    verdict = "fail";
    const reasons: string[] = [];
    if (!sharpness.isSharp) reasons.push("sharpness failed");
    if (!criticalPass) {
      if (!specificity.pass) reasons.push("specificity failed");
      if (!consequence.pass) reasons.push("consequence failed");
      if (!tensionOrContrast.pass) reasons.push("tension/contrast failed");
    }
    if (!relaxablePass && !curated) {
      if (!traceableEvidence.pass) reasons.push("traceable evidence failed");
      if (!positionSharpening.pass) reasons.push("position-sharpening failed");
    }
    gateDecisionPath.push(`fail: ${reasons.join(", ")}`);
  }

  return { verdict, dimensionResults, sharpness, passedCount, gateDecisionPath };
}

// --- Enrich downgrade: find a concrete content match ---

function findConcreteEnrichCandidate(params: {
  item: NormalizedSourceItem;
  evidence: EvidenceReference[];
  candidates: ContentOpportunity[];
}): ContentOpportunity | null {
  const itemTokens = tokenizeV2(params.item.title + " " + params.item.summary);
  const itemEvidenceSignatures = new Set(params.evidence.map(evidenceSignature));

  type ScoredCandidate = { opp: ContentOpportunity; jaccard: number };
  const matches: ScoredCandidate[] = [];

  for (const opp of params.candidates) {
    const oppTokens = tokenizeV2(opp.title + " " + opp.angle + " " + opp.whatItIsAbout);

    // Check 1: meaningful keyword overlap (bigrams or shared non-stopword tokens)
    if (!hasMeaningfulOverlap(oppTokens, itemTokens)) continue;

    // Check 2: new evidence available (at least one excerpt not already on this opportunity)
    const existingSignatures = new Set(opp.evidence.map(evidenceSignature));
    const hasNewEvidence = params.evidence.some(
      (e) => !existingSignatures.has(evidenceSignature(e))
    );
    if (!hasNewEvidence) continue;

    // Tiebreaker: raw Jaccard score
    const oppClean = new Set(removeStopWords(oppTokens));
    const itemClean = new Set(removeStopWords(itemTokens));
    const jaccard = jaccardSimilarity(oppClean, itemClean);
    matches.push({ opp, jaccard });
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.jaccard - a.jaccard);
  return matches[0].opp;
}

// --- Quality gate ---

function enforceCreateQualityGateLegacy(params: {
  item: NormalizedSourceItem;
  decision: CreateEnrichDecision;
  curated: boolean;
}): { decision: CreateEnrichDecision; failureReasons: string[] } {
  const failureReasons: string[] = [];
  const summaryLength = params.item.summary.trim().length;
  const textLength = params.item.text.trim().length;

  if (params.curated) {
    if (params.decision.confidence < 0.4) failureReasons.push("confidence below 0.4");
    if (params.decision.title.trim().length < 6) failureReasons.push("title too short");
    if (params.decision.angle.trim().length < 10) failureReasons.push("angle too short");
    if (params.decision.whatItIsAbout.trim().length < 10) failureReasons.push("what-it-is-about too short");
    if (summaryLength < 30 && textLength < 60) failureReasons.push("source evidence is too thin");
  } else {
    if (params.decision.confidence < 0.7) failureReasons.push("confidence below 0.7");
    if (params.decision.title.trim().length < 16) failureReasons.push("title too short");
    if (params.decision.angle.trim().length < 24) failureReasons.push("angle too short");
    if (params.decision.whyNow.trim().length < 24) failureReasons.push("why-now too short");
    if (params.decision.whatItIsAbout.trim().length < 24) failureReasons.push("what-it-is-about too short");
    if (summaryLength < 60 && textLength < 180) failureReasons.push("source evidence is too thin");
  }

  if (failureReasons.length === 0) return { decision: params.decision, failureReasons };

  return {
    decision: {
      ...params.decision,
      action: "skip",
      targetOpportunityId: undefined,
      rationale: `${params.decision.rationale} Skipped create because the quality gate failed: ${failureReasons.join("; ")}.`
    },
    failureReasons
  };
}

export function enforceCreateQualityGate(params: {
  item: NormalizedSourceItem;
  decision: CreateEnrichDecision;
  curated: boolean;
  evidence: EvidenceReference[];
  candidates: ContentOpportunity[];
}): { decision: CreateEnrichDecision; contractResult: AngleContractResult | null } {
  if (params.decision.action !== "create") {
    return { decision: params.decision, contractResult: null };
  }

  // Action-aware field validation: create requires non-empty opportunity fields
  const requiredFields = ["title", "angle", "whyNow", "whatItIsAbout", "whatItIsNotAbout", "suggestedFormat", "territory"] as const;
  const emptyFields = requiredFields.filter((f) => !params.decision[f]?.trim());
  if (emptyFields.length > 0) {
    return {
      decision: {
        ...params.decision,
        action: "skip",
        targetOpportunityId: undefined,
        rationale: `${params.decision.rationale} Skipped create: required fields empty (${emptyFields.join(", ")}).`,
        skipReasons: [`required fields empty: ${emptyFields.join(", ")}`]
      },
      contractResult: null
    };
  }

  const gateMode = getAngleQualityGateMode();

  // v1 legacy checks (always run as baseline)
  const legacy = enforceCreateQualityGateLegacy({
    item: params.item,
    decision: params.decision,
    curated: params.curated
  });

  if (gateMode === "v1") {
    return { decision: legacy.decision, contractResult: null };
  }

  // v2 / observe: run full contract
  const contractResult = evaluateAngleContract({
    decision: params.decision,
    item: params.item,
    evidence: params.evidence,
    curated: params.curated
  });

  // In observe mode, return v1 verdict but include v2 contract result for telemetry.
  // Append what v2 would have done so telemetry can report correctly.
  if (gateMode === "observe") {
    if (contractResult.verdict === "fail") {
      const enrichCandidate = findConcreteEnrichCandidate({
        item: params.item,
        evidence: params.evidence,
        candidates: params.candidates
      });
      if (enrichCandidate) {
        contractResult.gateDecisionPath.push(`[observe] would enrich on "${enrichCandidate.title}"`);
      }
    }
    return { decision: legacy.decision, contractResult };
  }

  // v2 mode: v1 must also pass (baseline length/confidence checks)
  if (legacy.failureReasons.length > 0) {
    return {
      decision: legacy.decision,
      contractResult
    };
  }

  // v2 verdict
  if (contractResult.verdict === "pass") {
    return { decision: params.decision, contractResult };
  }

  if (contractResult.verdict === "warn") {
    return {
      decision: {
        ...params.decision,
        rationale: `${params.decision.rationale} [Angle quality warning: ${contractResult.gateDecisionPath.join("; ")}]`
      },
      contractResult
    };
  }

  // verdict === "fail": try enrich downgrade with concrete content match
  const enrichCandidate = findConcreteEnrichCandidate({
    item: params.item,
    evidence: params.evidence,
    candidates: params.candidates
  });

  if (enrichCandidate) {
    return {
      decision: {
        ...params.decision,
        action: "enrich",
        targetOpportunityId: enrichCandidate.id,
        rationale: `${params.decision.rationale} Angle quality gate failed (${contractResult.gateDecisionPath.join("; ")}). Downgraded to enrich on "${enrichCandidate.title}" based on concrete content match.`
      },
      contractResult
    };
  }

  return {
    decision: {
      ...params.decision,
      action: "skip",
      targetOpportunityId: undefined,
      rationale: `${params.decision.rationale} Angle quality gate failed: ${contractResult.gateDecisionPath.join("; ")}.`,
      skipReasons: contractResult.gateDecisionPath
    },
    contractResult
  };
}

export async function decideCreateOrEnrich(params: {
  item: NormalizedSourceItem;
  evidence: EvidenceReference[];
  screening: ScreeningResult;
  candidates: ContentOpportunity[];
  creationMode: SourceCreationMode;
  curated: boolean;
  topCandidateScore: number;
  llmClient: LlmClient;
  doctrineMarkdown: string;
  userDescriptions: string;
  gtmFoundationMarkdown: string;
  extractionDepthBlock?: string;
  speakerLine?: string;
}): Promise<{ decision: CreateEnrichDecision; usage: LlmUsage }> {
  const candidateDescriptions = params.candidates.length > 0
    ? params.candidates.map((c) => [
        `- ID: ${c.id}`,
        `  Title: ${c.title}`,
        `  Angle: ${c.angle}`,
        `  Why now: ${c.whyNow}`,
        `  Evidence: ${c.evidence.slice(0, 3).map((e) => e.excerpt.slice(0, 150)).join(" | ")}`
      ].join("\n")).join("\n")
    : "No existing opportunities match.";

  const system = [
    "You are an editorial intelligence agent deciding whether to create a new content opportunity, enrich an existing one, or skip.",
    "",
    "## Company Doctrine",
    params.doctrineMarkdown,
    "",
    "## Available owners",
    params.userDescriptions,
    "",
    ...(params.extractionDepthBlock ? [params.extractionDepthBlock, ""] : []),
    ...(params.gtmFoundationMarkdown ? [
      "## GTM Foundation",
      params.gtmFoundationMarkdown,
      "",
      "## GTM classification",
      "For each opportunity, also classify these optional fields:",
      "- targetSegment: who is this post really for? One of: cabinet-owner, production-manager, payroll-manager, it-lead",
      "- editorialPillar: what kind of editorial move? One of: insight, proof, perspective, personality",
      "- awarenessTarget: how aware is the intended reader? One of: unaware, problem-aware, solution-aware, active-buyer",
      "- buyerFriction: the specific blocker or hesitation this content addresses (freeform, be specific)",
      "- contentMotion: why does this content exist in the GTM motion? One of: category, demand-capture, trust, recruiting",
      "",
    ] : []),
    "## Angle quality contract",
    "",
    "### Three levels of editorial specificity",
    "- `whatItIsAbout`: the broad subject/topic",
    "- `angle`: the specific editorial framing — MUST go beyond the topic",
    "- `editorialClaim`: the position, tension, or consequence — what makes this worth reading",
    "",
    "### Quality self-assessment",
    "For create/enrich, provide `angleQualitySignals`:",
    "- specificity: What concrete fact/tension makes this specific?",
    "- consequence: What changes for the reader/cabinet?",
    "- tensionOrContrast: What contradiction/surprise exists? Write \"none\" if genuinely absent.",
    "- traceableEvidence: What source material backs this? Quote or cite.",
    "- positionSharpening: How does this define Linc's position vs generic commentary?",
    "",
    "### Do NOT create when:",
    "- Angle is a topic label or broad question",
    "- Angle could appear in any B2B SaaS content calendar",
    "- No concrete stake, consequence, or tension",
    "- Evidence too thin, future/speculative, or technically true but editorially useless",
    "Use enrich (if candidate matches) or skip with skipReasons instead.",
    "",
    "### Enrich requirements",
    "Enrich only when the source adds a concrete new proof point, a sharper angle, or a distinct evidence thread. Do not enrich just because the topic overlaps.",
    "",
    "### Examples",
    "BAD angles (will be blocked): \"Payroll automation trends\" (topic label), \"The importance of reliability\" (generic), \"How cabinets think about migration\" (no claim)",
    "GOOD angles: \"Cabinets run dual payroll for 3 months because no vendor proves parity upfront\", \"DSN regularization failures cost 2-3h per cycle but most assume it's unavoidable\", \"Clickable payslip gives cabinets proof of calculation logic for the first time\"",
    "",
    params.creationMode === "enrich-only"
      ? "This source is evidence-shaped and may only enrich an existing opportunity or be skipped. Never create a new opportunity from it."
      : params.curated
        ? "This is a curated source with established provenance. Create a new opportunity if the angle is sharp and specific — even if the framing is rough. Focus on whether real substance exists, not on presentation quality."
        : "This source may create a new opportunity if it contains a reusable insight with enough substance and a sharp, specific angle.",
    "",
    params.creationMode === "enrich-only"
      ? "Decide: 'enrich' an existing opportunity (provide targetOpportunityId) or 'skip'."
      : params.candidates.length > 0
        ? "Decide: 'create' a new opportunity, 'enrich' an existing one (provide targetOpportunityId), or 'skip'."
        : "No existing opportunities match. Decide whether to 'create' a new opportunity or 'skip'.",
    "Return JSON matching the createEnrichDecision schema.",
    "For skip actions: provide rationale and skipReasons. Opportunity fields (title, angle, etc.) may be empty strings. Do NOT fabricate fields to make a skip look like an opportunity.",
    "For create actions: all opportunity fields must be substantive and non-empty.",
    "For enrich actions: if the enrichment only adds new evidence and the existing angle/whyNow are already good, you may leave those fields empty or matching the existing values. Do not fabricate changes. Provide non-empty fields only when you have a genuinely sharper angle or updated whyNow to suggest."
  ].join("\n");

  const prompt = [
    `## Source item`,
    `Title: ${params.item.title}`,
    ...(params.speakerLine ? [params.speakerLine] : []),
    `Summary: ${params.item.summary}`,
    `Text (first 1000 chars): ${params.item.text.slice(0, 1000)}`,
    `Source: ${params.item.source}`,
    `Creation mode: ${params.creationMode}`,
    `Date: ${params.item.occurredAt}`,
    "",
    `## Evidence excerpts`,
    ...params.evidence.map((e) => `- ${e.excerpt.slice(0, 300)}`),
    "",
    `## Screening hint`,
    `Create or enrich hint: ${params.screening.createOrEnrich}`,
    `Owner suggestion: ${params.screening.ownerSuggestion ?? "none"}`,
    "",
    `## Candidate opportunities`,
    candidateDescriptions
  ].join("\n");

  const fallback = (): CreateEnrichDecision => {
    if (params.creationMode === "enrich-only") {
      return {
        action: params.candidates[0] ? "enrich" : "skip",
        targetOpportunityId: params.candidates[0]?.id,
        rationale: params.candidates[0]
          ? "LLM fallback — enriching the strongest existing match for an evidence-shaped source."
          : "LLM fallback — skipped because this evidence-shaped source has no strong existing match.",
        title: params.item.title,
        ownerDisplayName: params.screening.ownerSuggestion,
        territory: "general",
        angle: params.item.summary.slice(0, 200),
        whyNow: `Fresh evidence from ${params.item.source} on ${params.item.occurredAt}`,
        whatItIsAbout: params.item.summary,
        whatItIsNotAbout: "Requires editorial review — generated from LLM fallback.",
        suggestedFormat: "Narrative lesson post",
        confidence: 0.4
      };
    }

    return {
      action: "skip",
      rationale: "LLM fallback — skipped because structured output failed. Create-capable sources require a real LLM decision to create.",
      title: "",
      territory: "",
      angle: "",
      whyNow: "",
      whatItIsAbout: "",
      whatItIsNotAbout: "",
      suggestedFormat: "",
      confidence: 0,
      skipReasons: ["LLM structured output failed"]
    };
  };

  const response = await params.llmClient.generateStructured({
    step: "create-enrich",
    system,
    prompt,
    schema: createEnrichDecisionSchema,
    allowFallback: true,
    fallback
  });

  const decision = normalizeCreateEnrichDecision({
    creationMode: params.creationMode,
    candidates: params.candidates,
    decision: response.output,
    topCandidateScore: params.topCandidateScore,
    curated: params.curated
  });

  return { decision, usage: response.usage };
}

// --- Build New Opportunity ---

export function buildNewOpportunity(params: {
  decision: CreateEnrichDecision;
  sourceItem: NormalizedSourceItem;
  evidence: EvidenceReference[];
  companyId: string;
  ownerUserId?: string;
  users?: UserRecord[];
}): ContentOpportunity | null {
  if (params.evidence.length === 0) return null;

  const sourceFingerprint = hashParts([
    params.sourceItem.externalId,
    params.ownerUserId ?? "unassigned",
    params.decision.angle
  ]);
  const id = createDeterministicId("opportunity", [params.companyId, sourceFingerprint]);

  const primaryEvidence = selectPrimaryEvidence(params.evidence);
  if (!primaryEvidence) return null;

  // Determine ownerProfile for backward compat
  let ownerProfile: (typeof PROFILE_IDS)[number] | undefined;
  if (params.ownerUserId && params.users) {
    const user = params.users.find((u) => u.id === params.ownerUserId);
    if (user && (PROFILE_ID_VALUES as readonly string[]).includes(user.displayName)) {
      ownerProfile = user.displayName as (typeof PROFILE_IDS)[number];
    }
  }

  return {
    id,
    companyId: params.companyId,
    sourceFingerprint,
    title: params.decision.title,
    ownerProfile,
    ownerUserId: params.ownerUserId,
    narrativePillar: params.decision.territory,
    ...normalizeGtmFields({
      targetSegment: params.decision.targetSegment,
      editorialPillar: params.decision.editorialPillar,
      awarenessTarget: params.decision.awarenessTarget,
      buyerFriction: params.decision.buyerFriction,
      contentMotion: params.decision.contentMotion,
    }),
    angle: params.decision.angle,
    editorialClaim: params.decision.editorialClaim,
    whyNow: params.decision.whyNow,
    whatItIsAbout: params.decision.whatItIsAbout,
    whatItIsNotAbout: params.decision.whatItIsNotAbout,
    evidence: params.evidence,
    primaryEvidence,
    supportingEvidenceCount: Math.max(0, params.evidence.length - 1),
    evidenceFreshness: primaryEvidence.freshnessScore,
    evidenceExcerpts: params.evidence.map((e) => e.excerpt),
    routingStatus: "Routed",
    readiness: "Opportunity only",
    status: "To review",
    suggestedFormat: params.decision.suggestedFormat,
    enrichmentLog: [],
    v1History: [],
    notionPageFingerprint: sourceFingerprint
  };
}

// --- Build Enrichment Update ---

export function buildEnrichmentUpdate(params: {
  existing: ContentOpportunity;
  decision: CreateEnrichDecision;
  sourceItem: NormalizedSourceItem;
  newEvidence: EvidenceReference[];
  ownerUserId?: string;
}): {
  updatedOpportunity: ContentOpportunity;
  logEntry: EnrichmentLogEntry;
  addedEvidence: EvidenceReference[];
} {
  // Dedupe new evidence against existing
  const allRawEvidence = [...params.existing.evidence, ...params.newEvidence];
  const allEvidence = dedupeEvidenceReferences(allRawEvidence);
  const existingSignatures = new Set(params.existing.evidence.map(evidenceSignature));
  const addedEvidence = params.newEvidence.filter(
    (e) => !existingSignatures.has(evidenceSignature(e))
  );

  const primaryEvidence = selectPrimaryEvidence(allEvidence);

  // Sanitize enrich outputs: blank/empty strings must not become suggested updates
  const sanitizedAngle = params.decision.angle?.trim() || undefined;
  const sanitizedWhyNow = params.decision.whyNow?.trim() || undefined;
  const sanitizedClaim = params.decision.editorialClaim?.trim() || undefined;

  const logEntry: EnrichmentLogEntry = {
    createdAt: new Date().toISOString(),
    rawSourceItemId: params.sourceItem.externalId,
    evidenceIds: addedEvidence.map((e) => e.id),
    contextComment: params.decision.rationale,
    suggestedAngleUpdate: sanitizedAngle && sanitizedAngle !== params.existing.angle ? sanitizedAngle : undefined,
    suggestedWhyNowUpdate: sanitizedWhyNow && sanitizedWhyNow !== params.existing.whyNow ? sanitizedWhyNow : undefined,
    suggestedEditorialClaimUpdate: sanitizedClaim && sanitizedClaim !== (params.existing.editorialClaim ?? undefined) ? sanitizedClaim : undefined,
    ownerSuggestionUpdate: params.ownerUserId && params.ownerUserId !== params.existing.ownerUserId
      ? params.ownerUserId
      : undefined,
    confidence: params.decision.confidence,
    reason: params.decision.rationale
  };

  // No visible field mutations — keep existing title/angle/whyNow/owner
  const updatedOpportunity: ContentOpportunity = {
    ...params.existing,
    evidence: allEvidence,
    primaryEvidence: primaryEvidence ?? params.existing.primaryEvidence,
    supportingEvidenceCount: Math.max(0, allEvidence.length - 1),
    evidenceFreshness: primaryEvidence?.freshnessScore ?? params.existing.evidenceFreshness,
    evidenceExcerpts: allEvidence.map((e) => e.excerpt),
    enrichmentLog: [...params.existing.enrichmentLog, logEntry]
  };

  return { updatedOpportunity, logEntry, addedEvidence };
}

// --- Build Evidence for New Pipeline ---

export function buildIntelligenceEvidence(
  item: NormalizedSourceItem,
  companyId: string,
  maxExcerpts = 3
): EvidenceReference[] {
  const base = buildEvidenceReferences(item, maxExcerpts);
  return base.map((e, index) => ({
    ...e,
    id: createDeterministicId("evidence", [companyId, item.externalId, e.excerptHash, index]),
    sourceItemId: sourceItemDbId(companyId, item.externalId)
  }));
}

// --- Main Orchestrator ---

/**
 * Async callback the pipeline invokes before creating a new opportunity.
 * Returns the existing opportunity's id+title if one already exists with
 * evidence from the same originating source item, or null if safe to create.
 *
 * The default (undefined) falls back to in-memory workingOpportunities only.
 * The real caller passes a DB-backed implementation for durable dedupe.
 */
export type OriginDedupeCheck = (sourceItemDbId: string) => Promise<{ id: string; title: string } | null>;

export interface IntelligencePipelineParams {
  items: NormalizedSourceItem[];
  companyId: string;
  llmClient: LlmClient;
  doctrineMarkdown: string;
  sensitivityMarkdown: string;
  userDescriptions: string;
  users: UserRecord[];
  layer2Defaults: string[];
  layer3Defaults: string[];
  gtmFoundationMarkdown: string;
  extractionProfilesMarkdown: string;
  recentOpportunities: ContentOpportunity[];
  /** DB-backed origin dedupe. When provided, called before every create decision. */
  checkOriginDedupe?: OriginDedupeCheck;
}

export interface DedupEvent {
  sourceItemId: string;
  timestamp: string;
  action:
    | "origin-dedup-hit"
    | "origin-dedup-miss"
    | "candidate-window"
    | "candidate-match"
    | "candidate-miss"
    | "create-with-warning"
    | "create-clean"
    | "enrich-by-llm"
    | "enrich-by-origin";
  matchedOpportunityId?: string;
  matchedOpportunityTitle?: string;
  /** Raw topical Jaccard (no boosts) — the score used for duplicate warning thresholds. */
  topicalScore?: number;
  /** Boosted score (topical + owner + evidence boosts) — the score used for candidate ranking. */
  boostedScore?: number;
  llmConfidence?: number;
  reason: string;
}

export interface IntelligencePipelineResult {
  screeningResults: Map<string, ScreeningResult>;
  created: ContentOpportunity[];
  enriched: Array<{ opportunity: ContentOpportunity; logEntry: EnrichmentLogEntry; addedEvidence: EvidenceReference[] }>;
  skipped: Array<{ sourceItemId: string; reason: string }>;
  usageEvents: Array<{ step: string; usage: LlmUsage }>;
  dedupEvents: DedupEvent[];
  angleQualityEvents: AngleQualityEvent[];
  speakerContextEvents: SpeakerContextEvent[];
  processedSourceItemIds: string[];
  linearReviewItems: Array<{
    item: NormalizedSourceItem;
    classification: LinearEnrichmentClassification;
  }>;
  linearClassifications: Map<string, LinearEnrichmentClassification>;
}

export async function runIntelligencePipeline(
  params: IntelligencePipelineParams
): Promise<IntelligencePipelineResult> {
  const result: IntelligencePipelineResult = {
    screeningResults: new Map(),
    created: [],
    enriched: [],
    skipped: [],
    usageEvents: [],
    dedupEvents: [],
    angleQualityEvents: [],
    speakerContextEvents: [],
    processedSourceItemIds: [],
    linearReviewItems: [],
    linearClassifications: new Map()
  };

  // 1. Prefilter
  const { retained, skipped } = prefilterSourceItems(params.items);
  for (const entry of skipped) {
    result.skipped.push({ sourceItemId: entry.item.externalId, reason: entry.reason });
    result.processedSourceItemIds.push(entry.item.externalId);
  }

  if (retained.length === 0) {
    return result;
  }

  // 2. Build evidence per retained item
  const evidenceMap = new Map<string, EvidenceReference[]>();
  for (const item of retained) {
    evidenceMap.set(item.externalId, buildIntelligenceEvidence(item, params.companyId));
  }

  // 3. Screen
  const screening = await screenSourceItems({
    items: retained,
    evidenceMap,
    llmClient: params.llmClient,
    doctrineMarkdown: params.doctrineMarkdown,
    sensitivityMarkdown: params.sensitivityMarkdown,
    userDescriptions: params.userDescriptions
  });
  result.usageEvents.push(...screening.usageEvents);
  result.screeningResults = screening.results;

  // Process screening results
  const retainedAfterScreening: Array<{ item: NormalizedSourceItem; screening: ScreeningResult }> = [];
  for (const item of retained) {
    const sr = screening.results.get(item.externalId);
    if (!sr || sr.decision === "skip") {
      result.skipped.push({
        sourceItemId: item.externalId,
        reason: sr?.rationale ?? "Screened out"
      });
      // Fallback-skipped items stay unprocessed so they can be retried next run
      if (!sr?.fallback) {
        result.processedSourceItemIds.push(item.externalId);
      }
      continue;
    }
    retainedAfterScreening.push({ item, screening: sr });
  }

  // 4. Linear enrichment policy — triage Linear items before create/enrich
  const linearItems = retainedAfterScreening.filter(({ item }) => item.source === "linear");
  const nonLinearItems = retainedAfterScreening.filter(({ item }) => item.source !== "linear");

  let linearEnrichWorthy: Array<{ item: NormalizedSourceItem; screening: ScreeningResult }> = [];

  if (linearItems.length > 0) {
    try {
      const linearEval = await evaluateLinearEnrichmentPolicy({
        items: linearItems.map(({ item }) => item),
        llmClient: params.llmClient,
        doctrineMarkdown: params.doctrineMarkdown,
        sensitivityMarkdown: params.sensitivityMarkdown
      });
      result.usageEvents.push(...linearEval.usageEvents);

      for (const { item, screening: sr } of linearItems) {
        const classification = linearEval.results.get(item.externalId) ?? LINEAR_ENRICHMENT_FALLBACK;
        result.linearClassifications.set(item.externalId, classification);

        if (classification.classification === "ignore") {
          result.skipped.push({
            sourceItemId: item.externalId,
            reason: `Linear enrichment policy: ignore — ${classification.rationale}`
          });
          result.processedSourceItemIds.push(item.externalId);
        } else if (classification.classification === "manual-review-needed") {
          result.linearReviewItems.push({ item, classification });
          result.skipped.push({
            sourceItemId: item.externalId,
            reason: `Linear enrichment policy: held for manual review — ${classification.rationale}`
          });
          result.processedSourceItemIds.push(item.externalId);
        } else {
          // editorial-lead or enrich-worthy — stamp classification onto in-memory item metadata
          item.metadata = {
            ...item.metadata,
            linearEnrichmentClassification: classification.classification,
            linearEnrichmentRationale: classification.rationale,
            linearCustomerVisibility: classification.customerVisibility,
            linearSensitivityLevel: classification.sensitivityLevel,
            linearEvidenceStrength: classification.evidenceStrength,
            linearReviewNote: classification.reviewNote
          };
          linearEnrichWorthy.push({ item, screening: sr });
        }
      }
    } catch (error) {
      // Fail-closed: classify ALL Linear items as manual-review-needed
      const failReason = "Linear enrichment policy evaluation failed; all items held for review";
      for (const { item } of linearItems) {
        const failClassification: LinearEnrichmentClassification = {
          classification: "manual-review-needed",
          rationale: failReason,
          customerVisibility: "ambiguous",
          sensitivityLevel: "safe",
          evidenceStrength: 0,
          reviewNote: failReason
        };
        result.linearClassifications.set(item.externalId, failClassification);
        result.linearReviewItems.push({ item, classification: failClassification });
        result.skipped.push({
          sourceItemId: item.externalId,
          reason: `Linear enrichment policy: held for manual review — ${failReason}`
        });
        result.processedSourceItemIds.push(item.externalId);
      }
    }
  }

  const itemsForCreateEnrich = [...nonLinearItems, ...linearEnrichWorthy];

  // 5. Create/enrich per retained item
  // Mutable candidate pool: opportunities created/enriched within this run become
  // immediately visible to subsequent items, preventing duplicate creation when
  // multiple related source items land in the same batch.
  const workingOpportunities = [...params.recentOpportunities];

  for (const { item, screening: sr } of itemsForCreateEnrich) {
    // --- Speaker context: resolve once per item, emit before any branch ---
    const speakerCtx = resolveSpeakerContext({ item, users: params.users });
    const depthMode = getExtractionDepthMode();
    const isDepthActive = depthMode === "enabled"
      && speakerCtx !== undefined
      && params.extractionProfilesMarkdown.length > 0;
    result.speakerContextEvents.push({
      sourceItemId: item.externalId,
      speakerName: item.speakerName,
      profileHint: typeof item.metadata?.profileHint === "string" ? item.metadata.profileHint : undefined,
      resolved: speakerCtx ? { profileId: speakerCtx.profileId, role: speakerCtx.role, source: speakerCtx.source } : undefined,
      depthMode,
      promptModified: isDepthActive,
    });

    if (isBlockedByPublishability(item)) {
      result.skipped.push({ sourceItemId: item.externalId, reason: `Blocked by publishability risk: ${item.metadata?.publishabilityRisk}` });
      result.processedSourceItemIds.push(item.externalId);
      continue;
    }

    try {
      const creationMode = getSourceCreationMode(item);
      const { candidates, topScore, topTopicalScore, topCandidate, bestTopicalCandidate, rescuedCount } = narrowCandidateOpportunities(
        item,
        sr,
        workingOpportunities,
        params.companyId,
        { enableOwnerBoost: creationMode === "create-capable" }
      );
      const curated = isCuratedSource(item);

      // Dedup telemetry: candidate window stats
      result.dedupEvents.push({
        sourceItemId: item.externalId,
        timestamp: new Date().toISOString(),
        action: candidates.length > 0 ? "candidate-match" : "candidate-miss",
        topicalScore: topTopicalScore,
        boostedScore: topScore,
        matchedOpportunityId: bestTopicalCandidate?.id,
        matchedOpportunityTitle: bestTopicalCandidate?.title,
        reason: `Window ${workingOpportunities.length} opps, ${candidates.length} candidates above 0.05${rescuedCount > 0 ? ` (${rescuedCount} rescued)` : ""}, topical ${topTopicalScore.toFixed(3)}, boosted ${topScore.toFixed(3)}`
      });

      if (creationMode === "enrich-only" && candidates.length === 0) {
        result.skipped.push({
          sourceItemId: item.externalId,
          reason: createBlockedBySourceReason(item)
        });
        result.processedSourceItemIds.push(item.externalId);
        continue;
      }

      const evidence = evidenceMap.get(item.externalId) ?? [];

      const { decision, usage } = await decideCreateOrEnrich({
        item,
        evidence,
        screening: sr,
        candidates,
        creationMode,
        curated,
        topCandidateScore: topScore,
        llmClient: params.llmClient,
        doctrineMarkdown: params.doctrineMarkdown,
        userDescriptions: params.userDescriptions,
        gtmFoundationMarkdown: params.gtmFoundationMarkdown,
        extractionDepthBlock: isDepthActive ? buildExtractionDepthBlock(speakerCtx!, params.extractionProfilesMarkdown) : undefined,
        speakerLine: isDepthActive ? `Speaker: ${speakerCtx!.speakerName}` : undefined,
      });
      result.usageEvents.push({ step: "create-enrich", usage });
      const { decision: gatedDecision, contractResult } = enforceCreateQualityGate({
        item, decision, curated, evidence, candidates
      });
      const finalDecision = gatedDecision;

      // Emit angle quality event — always report v2 verdict, not the final action
      // (in observe mode, v1 drives the real decision but telemetry shows what v2 would do)
      if (decision.action === "create" && contractResult) {
        const v2Verdict = contractResult.verdict;
        // Determine blocked-enrich vs blocked-skip:
        // - In v2 mode: check if the gate actually downgraded to enrich
        // - In observe mode: check if the gate path indicates an enrich candidate was found
        const wasDowngradedToEnrich = finalDecision.action === "enrich"
          || contractResult.gateDecisionPath.some(p => p.includes("enrich"));
        const eventAction: AngleQualityEvent["action"] =
          v2Verdict === "pass" ? "passed"
          : v2Verdict === "warn" ? "warned"
          : wasDowngradedToEnrich ? "blocked-enrich"
          : "blocked-skip";
        result.angleQualityEvents.push({
          sourceItemId: item.externalId,
          angle: decision.angle,
          editorialClaim: decision.editorialClaim,
          action: eventAction,
          gateMode: getAngleQualityGateMode(),
          contractResult,
          curated
        });
      } else if (decision.action === "create" && !contractResult) {
        // v1 mode or empty-field skip — no contract result, report based on final action
        const eventAction: AngleQualityEvent["action"] = finalDecision.action === "create" ? "passed" : "blocked-skip";
        result.angleQualityEvents.push({
          sourceItemId: item.externalId,
          angle: decision.angle,
          editorialClaim: decision.editorialClaim,
          action: eventAction,
          gateMode: getAngleQualityGateMode(),
          contractResult: null,
          curated
        });
      }

      // Map ownerDisplayName -> User.id
      let ownerUserId: string | undefined;
      if (finalDecision.ownerDisplayName) {
        const matchedUser = params.users.find((u) => u.displayName === finalDecision.ownerDisplayName);
        if (matchedUser) {
          ownerUserId = matchedUser.id;
        }
      }

      if (finalDecision.action === "create") {
        // Origin dedupe: prevent duplicate opportunity creation from the same
        // originating source item.  Two layers:
        //  1. DB-backed check (checkOriginDedupe) — catches replays even when the
        //     existing opportunity has fallen outside the recentOpportunities window.
        //  2. In-memory workingOpportunities — catches same-run duplicates created
        //     earlier in this batch (not yet persisted to DB).
        const itemDbId = sourceItemDbId(params.companyId, item.externalId);

        // Layer 1: DB-backed check (skipped in unit tests when callback is absent)
        let dedupeHit: { id: string; title: string } | null = null;
        if (params.checkOriginDedupe) {
          dedupeHit = await params.checkOriginDedupe(itemDbId);
        }

        // Layer 2: in-memory fallback (always active — covers same-run creates)
        const inMemoryHit = !dedupeHit
          ? workingOpportunities.find(opp =>
              opp.evidence.some(e => e.sourceItemId === itemDbId)
            )
          : undefined;

        const existingFromSameOrigin = dedupeHit
          ? workingOpportunities.find(o => o.id === dedupeHit!.id)
          : inMemoryHit;

        if (dedupeHit && !existingFromSameOrigin) {
          // Opportunity exists in DB but wasn't in the initial snapshot — skip
          // creation with a clear reason.  We cannot enrich here because we don't
          // have the full opportunity graph in memory.
          result.skipped.push({
            sourceItemId: item.externalId,
            reason: `Origin dedupe: opportunity "${dedupeHit.title}" (${dedupeHit.id}) already has evidence from this source item`
          });
          result.dedupEvents.push({
            sourceItemId: item.externalId,
            timestamp: new Date().toISOString(),
            action: "origin-dedup-hit",
            matchedOpportunityId: dedupeHit.id,
            matchedOpportunityTitle: dedupeHit.title,
            reason: "Origin dedupe hit (DB match, not in working set) — skipped"
          });
        } else if (existingFromSameOrigin) {
          const enrichResult = buildEnrichmentUpdate({
            existing: existingFromSameOrigin,
            decision: finalDecision,
            sourceItem: item,
            newEvidence: evidence,
            ownerUserId
          });

          // Enrich substance check (same guard as LLM enrich path)
          const originHasNewEvidence = enrichResult.addedEvidence.length > 0;
          const originHasSharperAngle = enrichResult.logEntry.suggestedAngleUpdate !== undefined;
          const originHasSharperWhyNow = enrichResult.logEntry.suggestedWhyNowUpdate !== undefined;
          const originHasNewClaim = enrichResult.logEntry.suggestedEditorialClaimUpdate !== undefined;
          const originEnrichHasSubstance = originHasNewEvidence || originHasSharperAngle || originHasSharperWhyNow || originHasNewClaim;

          if (!originEnrichHasSubstance) {
            result.skipped.push({
              sourceItemId: item.externalId,
              reason: `Origin dedupe enrich adds no new evidence or sharper angle to "${existingFromSameOrigin.title}".`
            });
            result.dedupEvents.push({
              sourceItemId: item.externalId,
              timestamp: new Date().toISOString(),
              action: "enrich-by-origin",
              matchedOpportunityId: existingFromSameOrigin.id,
              matchedOpportunityTitle: existingFromSameOrigin.title,
              reason: "Origin dedupe hit — enrich skipped (no substance)"
            });
          } else {
            result.enriched.push({
              opportunity: enrichResult.updatedOpportunity,
              logEntry: enrichResult.logEntry,
              addedEvidence: enrichResult.addedEvidence
            });
            const idx = workingOpportunities.findIndex(o => o.id === existingFromSameOrigin.id);
            if (idx >= 0) workingOpportunities[idx] = enrichResult.updatedOpportunity;
            result.dedupEvents.push({
              sourceItemId: item.externalId,
              timestamp: new Date().toISOString(),
              action: "enrich-by-origin",
              matchedOpportunityId: existingFromSameOrigin.id,
              matchedOpportunityTitle: existingFromSameOrigin.title,
              reason: "Origin dedupe hit — converted create to enrich"
            });
          }
        } else {
          // Phase-1 duplicate warning: if strong TOPICAL overlap (ignoring
          // owner/evidence boosts) and LLM chose "create" with low confidence,
          // attach a reviewer warning + flag.  Uses bestTopicalCandidate, not
          // topCandidate (which is ranked by boosted score and may be a
          // same-owner non-duplicate).
          let dedupWarning = false;
          if (
            DEDUP_WARNINGS_ENABLED &&
            topTopicalScore >= DEDUP_WARNING_THRESHOLD &&
            finalDecision.confidence < DEDUP_CONFIDENCE_CUTOFF &&
            bestTopicalCandidate
          ) {
            dedupWarning = true;
          }

          const opp = buildNewOpportunity({
            decision: finalDecision,
            sourceItem: item,
            evidence,
            companyId: params.companyId,
            ownerUserId,
            users: params.users
          });
          if (opp) {
            if (dedupWarning && bestTopicalCandidate) {
              opp.editorialNotes = `[Possible overlap] Top candidate: "${bestTopicalCandidate.title}" (topical score: ${topTopicalScore.toFixed(2)})`;
              opp.dedupFlag = "Possible duplicate";
            }
            result.created.push(opp);
            workingOpportunities.push(opp);
            result.dedupEvents.push({
              sourceItemId: item.externalId,
              timestamp: new Date().toISOString(),
              action: dedupWarning ? "create-with-warning" : "create-clean",
              topicalScore: topTopicalScore,
              boostedScore: topScore,
              llmConfidence: finalDecision.confidence,
              matchedOpportunityId: bestTopicalCandidate?.id,
              matchedOpportunityTitle: bestTopicalCandidate?.title,
              reason: dedupWarning
                ? `Created with warning: topicalScore=${topTopicalScore.toFixed(3)}, confidence=${finalDecision.confidence.toFixed(2)}`
                : `Clean create: topicalScore=${topTopicalScore.toFixed(3)}, confidence=${finalDecision.confidence.toFixed(2)}`
            });
          }
        }
      } else if (finalDecision.action === "enrich" && finalDecision.targetOpportunityId) {
        const existing = workingOpportunities.find((o) => o.id === finalDecision.targetOpportunityId);
        if (existing) {
          const enrichResult = buildEnrichmentUpdate({
            existing,
            decision: finalDecision,
            sourceItem: item,
            newEvidence: evidence,
            ownerUserId
          });

          // Enrich substance check: verify the enrichment adds real value
          const hasNewEvidence = enrichResult.addedEvidence.length > 0;
          const hasSharperAngle = enrichResult.logEntry.suggestedAngleUpdate !== undefined;
          const hasSharperWhyNow = enrichResult.logEntry.suggestedWhyNowUpdate !== undefined;
          const hasNewClaim = enrichResult.logEntry.suggestedEditorialClaimUpdate !== undefined;
          const enrichHasSubstance = hasNewEvidence || hasSharperAngle || hasSharperWhyNow || hasNewClaim;

          if (!enrichHasSubstance) {
            result.skipped.push({
              sourceItemId: item.externalId,
              reason: `Enrich adds no new evidence or sharper angle to "${existing.title}".`
            });
            result.angleQualityEvents.push({
              sourceItemId: item.externalId,
              angle: finalDecision.angle,
              editorialClaim: finalDecision.editorialClaim,
              action: "enrich-no-substance",
              gateMode: getAngleQualityGateMode(),
              contractResult: null,
              curated
            });
          } else {
            result.enriched.push({
              opportunity: enrichResult.updatedOpportunity,
              logEntry: enrichResult.logEntry,
              addedEvidence: enrichResult.addedEvidence
            });
            const idx = workingOpportunities.findIndex(o => o.id === existing.id);
            if (idx >= 0) workingOpportunities[idx] = enrichResult.updatedOpportunity;
            result.dedupEvents.push({
              sourceItemId: item.externalId,
              timestamp: new Date().toISOString(),
              action: "enrich-by-llm",
              matchedOpportunityId: existing.id,
              matchedOpportunityTitle: existing.title,
              topicalScore: topTopicalScore,
              boostedScore: topScore,
              llmConfidence: finalDecision.confidence,
              reason: `LLM chose enrich target "${existing.title}"`
            });
          }
        }
      } else {
        result.skipped.push({ sourceItemId: item.externalId, reason: finalDecision.rationale });
      }

      result.processedSourceItemIds.push(item.externalId);
    } catch (error) {
      // Per-item failure: do NOT mark as processed
      const message = error instanceof Error ? error.message : "Unknown error";
      result.skipped.push({ sourceItemId: item.externalId, reason: `Error: ${message}` });
    }
  }

  return result;
}
