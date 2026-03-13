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
import { screeningBatchSchema, createEnrichDecisionSchema } from "../config/schema.js";
import type { LlmClient, LlmUsage } from "./llm.js";
import { sourceItemDbId } from "../db/repositories.js";

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

// --- Narrow Candidates ---

export function narrowCandidateOpportunities(
  item: NormalizedSourceItem,
  screening: ScreeningResult,
  opportunities: ContentOpportunity[],
  companyId: string
): ContentOpportunity[] {
  const itemWords = tokenize(`${item.title} ${item.summary}`);
  const itemDbId = sourceItemDbId(companyId, item.externalId);

  const scored = opportunities.map((opp) => {
    const oppWords = tokenize(`${opp.title} ${opp.angle} ${opp.whatItIsAbout}`);
    let score = jaccardSimilarity(itemWords, oppWords);

    if (screening.ownerSuggestion && opp.ownerProfile === screening.ownerSuggestion) {
      score += 0.2;
    }

    if (opp.evidence.some((e) => e.sourceItemId === itemDbId)) {
      score += 0.3;
    }

    return { opp, score };
  });

  return scored
    .filter((entry) => entry.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => entry.opp);
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

export async function decideCreateOrEnrich(params: {
  item: NormalizedSourceItem;
  evidence: EvidenceReference[];
  screening: ScreeningResult;
  candidates: ContentOpportunity[];
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
    : "No existing opportunities match — create a new content opportunity.";

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
    params.candidates.length > 0
      ? "Decide: 'create' a new opportunity, 'enrich' an existing one (provide targetOpportunityId), or 'skip'."
      : "No existing opportunities match. Create a new content opportunity.",
    "Return JSON matching the createEnrichDecision schema."
  ].join("\n");

  const prompt = [
    `## Source item`,
    `Title: ${params.item.title}`,
    `Summary: ${params.item.summary}`,
    `Text (first 1000 chars): ${params.item.text.slice(0, 1000)}`,
    `Source: ${params.item.source}`,
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

  const fallback = (): CreateEnrichDecision => ({
    action: "create",
    rationale: "LLM fallback — created with minimal fields",
    title: params.item.title,
    ownerDisplayName: params.screening.ownerSuggestion,
    territory: "general",
    angle: params.item.summary.slice(0, 200),
    whyNow: `Fresh evidence from ${params.item.source} on ${params.item.occurredAt}`,
    whatItIsAbout: params.item.summary,
    whatItIsNotAbout: "Requires editorial review — generated from LLM fallback.",
    suggestedFormat: "Narrative lesson post",
    confidence: 0.4
  });

  const response = await params.llmClient.generateStructured({
    step: "create-enrich",
    system,
    prompt,
    schema: createEnrichDecisionSchema,
    allowFallback: true,
    fallback
  });

  let decision = response.output;

  // Runtime validations
  if (decision.action === "enrich" && decision.targetOpportunityId) {
    const validTarget = params.candidates.some((c) => c.id === decision.targetOpportunityId);
    if (!validTarget) {
      decision = { ...decision, action: "create", targetOpportunityId: undefined };
    }
  }

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
    relatedSignalIds: [],
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
}

export interface IntelligencePipelineResult {
  screeningResults: Map<string, ScreeningResult>;
  created: ContentOpportunity[];
  enriched: Array<{ opportunity: ContentOpportunity; logEntry: EnrichmentLogEntry; addedEvidence: EvidenceReference[] }>;
  skipped: Array<{ sourceItemId: string; reason: string }>;
  usageEvents: Array<{ step: string; usage: LlmUsage }>;
  processedSourceItemIds: string[];
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
    processedSourceItemIds: []
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

  // 4. Create/enrich per retained item
  for (const { item, screening: sr } of retainedAfterScreening) {
    try {
      const candidates = narrowCandidateOpportunities(
        item,
        sr,
        params.recentOpportunities,
        params.companyId
      );

      const evidence = evidenceMap.get(item.externalId) ?? [];

      const { decision, usage } = await decideCreateOrEnrich({
        item,
        evidence,
        screening: sr,
        candidates,
        llmClient: params.llmClient,
        doctrineMarkdown: params.doctrineMarkdown,
        userDescriptions: params.userDescriptions,
        layer3Defaults: params.layer3Defaults
      });
      result.usageEvents.push({ step: "create-enrich", usage });

      // Map ownerDisplayName -> User.id
      let ownerUserId: string | undefined;
      if (decision.ownerDisplayName) {
        const matchedUser = params.users.find((u) => u.displayName === decision.ownerDisplayName);
        if (matchedUser) {
          ownerUserId = matchedUser.id;
        }
      }

      if (decision.action === "create") {
        const opp = buildNewOpportunity({
          decision,
          sourceItem: item,
          evidence,
          companyId: params.companyId,
          ownerUserId,
          users: params.users
        });
        if (opp) {
          result.created.push(opp);
        }
      } else if (decision.action === "enrich" && decision.targetOpportunityId) {
        const existing = params.recentOpportunities.find((o) => o.id === decision.targetOpportunityId);
        if (existing) {
          const enrichResult = buildEnrichmentUpdate({
            existing,
            decision,
            sourceItem: item,
            newEvidence: evidence,
            ownerUserId
          });
          result.enriched.push({
            opportunity: enrichResult.updatedOpportunity,
            logEntry: enrichResult.logEntry,
            addedEvidence: enrichResult.addedEvidence
          });
        }
      } else {
        result.skipped.push({ sourceItemId: item.externalId, reason: decision.rationale });
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
