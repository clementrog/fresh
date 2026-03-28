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
import { PROFILE_IDS as PROFILE_ID_VALUES } from "../domain/types.js";
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
  layer2Defaults: string[];
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
      "## Content Philosophy Defaults (Layer 2)",
      ...params.layer2Defaults.map((d) => `- ${d}`),
      "",
      "## Available owners and their territories",
      params.userDescriptions,
      "",
      "For each source item, decide: skip (not relevant) or retain (potential content opportunity).",
      "If retaining, suggest an owner displayName if obvious, and hint at create vs enrich.",
      "Return JSON with an 'items' array matching the screeningBatch schema."
    ].join("\n");

    const fallback = () => ({
      items: batch.map((item) => ({
        sourceItemId: item.externalId,
        decision: "retain" as const,
        rationale: "Fallback: retained for manual review",
        createOrEnrich: "unknown" as const,
        relevanceScore: 0.5,
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

    for (const result of response.output.items) {
      const screening: ScreeningResult = {
        decision: result.decision,
        rationale: result.rationale,
        ownerSuggestion: result.ownerSuggestion,
        createOrEnrich: result.createOrEnrich,
        relevanceScore: result.relevanceScore,
        sensitivityFlag: result.sensitivityFlag,
        sensitivityCategories: result.sensitivityCategories
      };
      results.set(result.sourceItemId, screening);
    }

    // Fill in any items not returned by the LLM
    for (const item of batch) {
      if (!results.has(item.externalId)) {
        results.set(item.externalId, {
          decision: "retain",
          rationale: "Not returned by screening LLM, retained by default",
          createOrEnrich: "unknown",
          relevanceScore: 0.5,
          sensitivityFlag: false,
          sensitivityCategories: []
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

// --- Narrow Candidates ---

export function narrowCandidateOpportunities(
  item: NormalizedSourceItem,
  screening: ScreeningResult,
  opportunities: ContentOpportunity[],
  companyId: string,
  opts: { enableOwnerBoost?: boolean } = {}
): { candidates: ContentOpportunity[]; topScore: number } {
  const itemWords = tokenize(`${item.title} ${item.summary}`);
  const itemDbId = sourceItemDbId(companyId, item.externalId);
  const enableOwnerBoost = opts.enableOwnerBoost ?? true;

  const scored = opportunities.map((opp) => {
    const oppWords = tokenize(`${opp.title} ${opp.angle} ${opp.whatItIsAbout}`);
    let score = jaccardSimilarity(itemWords, oppWords);

    if (enableOwnerBoost && screening.ownerSuggestion && opp.ownerProfile === screening.ownerSuggestion) {
      score += 0.2;
    }

    if (opp.evidence.some((e) => e.sourceItemId === itemDbId)) {
      score += 0.3;
    }

    return { opp, score };
  });

  const filtered = scored
    .filter((entry) => entry.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    candidates: filtered.map((entry) => entry.opp),
    topScore: filtered.length > 0 ? filtered[0].score : 0
  };
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
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

function enforceCreateQualityGate(params: {
  item: NormalizedSourceItem;
  decision: CreateEnrichDecision;
  curated: boolean;
}): CreateEnrichDecision {
  if (params.decision.action !== "create") {
    return params.decision;
  }

  const failureReasons: string[] = [];
  const summaryLength = params.item.summary.trim().length;
  const textLength = params.item.text.trim().length;

  if (params.curated) {
    // Curated tier: lower thresholds, still blocks junk
    if (params.decision.confidence < 0.4) {
      failureReasons.push("confidence below 0.4");
    }
    if (params.decision.title.trim().length < 6) {
      failureReasons.push("title too short");
    }
    if (params.decision.angle.trim().length < 10) {
      failureReasons.push("angle too short");
    }
    if (params.decision.whatItIsAbout.trim().length < 10) {
      failureReasons.push("what-it-is-about too short");
    }
    if (summaryLength < 30 && textLength < 60) {
      failureReasons.push("source evidence is too thin");
    }
  } else {
    // Strict tier: unchanged thresholds
    if (params.decision.confidence < 0.7) {
      failureReasons.push("confidence below 0.7");
    }
    if (params.decision.title.trim().length < 16) {
      failureReasons.push("title too short");
    }
    if (params.decision.angle.trim().length < 24) {
      failureReasons.push("angle too short");
    }
    if (params.decision.whyNow.trim().length < 24) {
      failureReasons.push("why-now too short");
    }
    if (params.decision.whatItIsAbout.trim().length < 24) {
      failureReasons.push("what-it-is-about too short");
    }
    if (summaryLength < 60 && textLength < 180) {
      failureReasons.push("source evidence is too thin");
    }
  }

  if (failureReasons.length === 0) {
    return params.decision;
  }

  return {
    ...params.decision,
    action: "skip",
    targetOpportunityId: undefined,
    rationale: `${params.decision.rationale} Skipped create because the quality gate failed: ${failureReasons.join("; ")}.`
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
  layer3Defaults: string[];
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
    "## LinkedIn Craft Defaults (Layer 3)",
    ...params.layer3Defaults.map((d) => `- ${d}`),
    "",
    params.creationMode === "enrich-only"
      ? "This source is evidence-shaped and may only enrich an existing opportunity or be skipped. Never create a new opportunity from it."
      : params.curated
        ? "This is a curated source with established provenance. Create a new opportunity if it contains at least one concrete insight, problem, or event — even if the framing is rough. You do not need polished prose or a fully developed angle. Focus on whether real substance exists, not on presentation quality."
        : "This source may create a new opportunity if it contains a reusable insight with enough substance.",
    params.creationMode === "enrich-only"
      ? "Decide: 'enrich' an existing opportunity (provide targetOpportunityId) or 'skip'."
      : params.candidates.length > 0
        ? "Decide: 'create' a new opportunity, 'enrich' an existing one (provide targetOpportunityId), or 'skip'."
        : "No existing opportunities match. Decide whether to 'create' a new opportunity or 'skip'.",
    "Return JSON matching the createEnrichDecision schema.",
    "IMPORTANT: All string fields (title, territory, angle, whyNow, whatItIsAbout, whatItIsNotAbout, suggestedFormat) must be non-empty even when action is 'skip'. For skip actions, populate them with your best assessment of what the opportunity would have been."
  ].join("\n");

  const prompt = [
    `## Source item`,
    `Title: ${params.item.title}`,
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
      title: params.item.title,
      ownerDisplayName: params.screening.ownerSuggestion,
      territory: "general",
      angle: params.item.summary.slice(0, 200),
      whyNow: `Fresh evidence from ${params.item.source} on ${params.item.occurredAt}`,
      whatItIsAbout: params.item.summary,
      whatItIsNotAbout: "Requires editorial review — generated from LLM fallback.",
      suggestedFormat: "Narrative lesson post",
      confidence: 0
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
    angle: params.decision.angle,
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

  const logEntry: EnrichmentLogEntry = {
    createdAt: new Date().toISOString(),
    rawSourceItemId: params.sourceItem.externalId,
    evidenceIds: addedEvidence.map((e) => e.id),
    contextComment: params.decision.rationale,
    suggestedAngleUpdate: params.decision.angle !== params.existing.angle ? params.decision.angle : undefined,
    suggestedWhyNowUpdate: params.decision.whyNow !== params.existing.whyNow ? params.decision.whyNow : undefined,
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
  recentOpportunities: ContentOpportunity[];
  /** DB-backed origin dedupe. When provided, called before every create decision. */
  checkOriginDedupe?: OriginDedupeCheck;
}

export interface IntelligencePipelineResult {
  screeningResults: Map<string, ScreeningResult>;
  created: ContentOpportunity[];
  enriched: Array<{ opportunity: ContentOpportunity; logEntry: EnrichmentLogEntry; addedEvidence: EvidenceReference[] }>;
  skipped: Array<{ sourceItemId: string; reason: string }>;
  usageEvents: Array<{ step: string; usage: LlmUsage }>;
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
    userDescriptions: params.userDescriptions,
    layer2Defaults: params.layer2Defaults
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
      result.processedSourceItemIds.push(item.externalId);
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
    if (isBlockedByPublishability(item)) {
      result.skipped.push({ sourceItemId: item.externalId, reason: `Blocked by publishability risk: ${item.metadata?.publishabilityRisk}` });
      result.processedSourceItemIds.push(item.externalId);
      continue;
    }

    try {
      const creationMode = getSourceCreationMode(item);
      const { candidates, topScore } = narrowCandidateOpportunities(
        item,
        sr,
        workingOpportunities,
        params.companyId,
        { enableOwnerBoost: creationMode === "create-capable" }
      );
      const curated = isCuratedSource(item);

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
        layer3Defaults: params.layer3Defaults
      });
      result.usageEvents.push({ step: "create-enrich", usage });
      const finalDecision = enforceCreateQualityGate({ item, decision, curated });

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
        } else if (existingFromSameOrigin) {
          const enrichResult = buildEnrichmentUpdate({
            existing: existingFromSameOrigin,
            decision: finalDecision,
            sourceItem: item,
            newEvidence: evidence,
            ownerUserId
          });
          result.enriched.push({
            opportunity: enrichResult.updatedOpportunity,
            logEntry: enrichResult.logEntry,
            addedEvidence: enrichResult.addedEvidence
          });
          const idx = workingOpportunities.findIndex(o => o.id === existingFromSameOrigin.id);
          if (idx >= 0) workingOpportunities[idx] = enrichResult.updatedOpportunity;
        } else {
          const opp = buildNewOpportunity({
            decision: finalDecision,
            sourceItem: item,
            evidence,
            companyId: params.companyId,
            ownerUserId,
            users: params.users
          });
          if (opp) {
            result.created.push(opp);
            workingOpportunities.push(opp);
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
          result.enriched.push({
            opportunity: enrichResult.updatedOpportunity,
            logEntry: enrichResult.logEntry,
            addedEvidence: enrichResult.addedEvidence
          });
          const idx = workingOpportunities.findIndex(o => o.id === existing.id);
          if (idx >= 0) workingOpportunities[idx] = enrichResult.updatedOpportunity;
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
