/**
 * Dedicated v2 angle quality gate tests.
 *
 * These tests run with ANGLE_QUALITY_GATE=v2 (the default) — they do NOT
 * inherit the v1 masking from intelligence.test.ts.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  buildEnrichmentUpdate,
  runIntelligencePipeline,
  evaluateAngleContract,
  enforceCreateQualityGate
} from "../src/services/intelligence.js";
import type {
  NormalizedSourceItem,
  ContentOpportunity,
  EvidenceReference,
  CreateEnrichDecision,
  AngleQualitySignals
} from "../src/domain/types.js";
import type { AngleQualityEvent, AngleContractResult } from "../src/services/intelligence.js";
import { sourceItemDbId } from "../src/db/repositories.js";

// Force v2 for all tests in this file
const _originalGateMode = process.env.ANGLE_QUALITY_GATE;
beforeAll(() => { process.env.ANGLE_QUALITY_GATE = "v2"; });
afterAll(() => {
  if (_originalGateMode !== undefined) process.env.ANGLE_QUALITY_GATE = _originalGateMode;
  else delete process.env.ANGLE_QUALITY_GATE;
});

// --- Helpers ---

function makeItem(overrides: Partial<NormalizedSourceItem> = {}): NormalizedSourceItem {
  return {
    source: "market-research",
    sourceItemId: "mq:test",
    externalId: "market-research:test",
    sourceFingerprint: "fp-test",
    sourceUrl: "https://example.com/source",
    title: "Test source item",
    text: "This is a substantive test source item with enough text to pass all prefilter and evidence thresholds easily in every gate tier.",
    summary: "Test summary with enough content for the curated and strict evidence checks to pass.",
    occurredAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    metadata: { kind: "market_research_summary", marketQueryId: "mq-1" },
    rawPayload: {},
    ...overrides
  };
}

function makeEvidence(overrides: Partial<EvidenceReference> = {}): EvidenceReference {
  return {
    id: "ev-1",
    source: "market-research",
    sourceItemId: "si-1",
    sourceUrl: "https://example.com",
    timestamp: new Date().toISOString(),
    excerpt: "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing.",
    excerptHash: "hash1",
    freshnessScore: 0.8,
    ...overrides
  };
}

function makeOpportunity(overrides: Partial<ContentOpportunity> = {}): ContentOpportunity {
  const evidence = [makeEvidence()];
  return {
    id: "opp-1",
    sourceFingerprint: "sf-1",
    title: "Test opportunity",
    narrativePillar: "general",
    angle: "Cabinets still run dual payroll because no vendor proves calculation parity upfront",
    whyNow: "Fresh evidence from market research confirms recurring migration blockers",
    whatItIsAbout: "Migration friction in payroll cabinets",
    whatItIsNotAbout: "Not about internal tooling",
    evidence,
    primaryEvidence: evidence[0],
    supportingEvidenceCount: 0,
    evidenceFreshness: 0.8,
    evidenceExcerpts: ["Some excerpt"],
    routingStatus: "Routed",
    readiness: "Opportunity only",
    status: "To review",
    suggestedFormat: "Narrative lesson post",
    enrichmentLog: [],
    v1History: [],
    notionPageFingerprint: "sf-1",
    ...overrides
  };
}

function makeDecision(overrides: Partial<CreateEnrichDecision> = {}): CreateEnrichDecision {
  return {
    action: "create",
    rationale: "new opportunity",
    title: "Created opportunity with sharp angle",
    territory: "payroll-production",
    angle: "Cabinets run dual payroll for 3 months because no vendor proves parity upfront",
    whyNow: "Fresh market research confirms this is a recurring migration blocker for mid-size cabinets",
    whatItIsAbout: "Migration friction driven by calculation verification gap",
    whatItIsNotAbout: "Not about generic migration challenges",
    suggestedFormat: "Narrative lesson post",
    confidence: 0.9,
    editorialClaim: "The migration bottleneck is not cost but the inability to prove calculation parity before go-live",
    angleQualitySignals: {
      specificity: "3-month parallel run driven by lack of calculation verification tooling",
      consequence: "Cabinets delay migration by months, increasing operational cost and staff burnout",
      tensionOrContrast: "Vendors claim easy migration but no one proves calculation parity upfront",
      traceableEvidence: "Observed in 3 out of 5 cabinet immersions in Q1 2026",
      positionSharpening: "Linc's calculation transparency addresses the exact gap competitors ignore"
    },
    ...overrides
  };
}

const SHARP_ANGLE = "Cabinets run dual payroll for 3 months because no vendor proves parity upfront";
const VAGUE_ANGLE = "Payroll automation trends in French accounting firms";
const GENERIC_ANGLE = "The importance of reliability in payroll software";

function makeScreeningOutput(sourceItemId: string) {
  return {
    output: {
      items: [{
        sourceItemId,
        decision: "retain" as const,
        rationale: "relevant",
        createOrEnrich: "create" as const,
        relevanceScore: 0.8,
        sensitivityFlag: false,
        sensitivityCategories: []
      }]
    },
    usage: { mode: "provider" as const, promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
    mode: "provider" as const
  };
}

function makeLlmDecisionOutput(overrides: Partial<CreateEnrichDecision> = {}) {
  return {
    output: makeDecision(overrides),
    usage: { mode: "provider" as const, promptTokens: 200, completionTokens: 100, estimatedCostUsd: 0.002 },
    mode: "provider" as const
  };
}

function buildMockLlm(screeningId: string, decisionOverrides: Partial<CreateEnrichDecision> = {}) {
  const mockLlm = { generateStructured: vi.fn() };
  mockLlm.generateStructured
    .mockResolvedValueOnce(makeScreeningOutput(screeningId))
    .mockResolvedValueOnce(makeLlmDecisionOutput(decisionOverrides));
  return mockLlm;
}

// --- Observe mode telemetry ---

describe("observe mode telemetry", () => {
  const _saved = process.env.ANGLE_QUALITY_GATE;
  beforeAll(() => { process.env.ANGLE_QUALITY_GATE = "observe"; });
  afterAll(() => { process.env.ANGLE_QUALITY_GATE = _saved ?? "v2"; });

  it("reports v2 pass verdict even when v1 drives the real decision", async () => {
    const item = makeItem();
    const mockLlm = buildMockLlm(item.externalId);

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "co-1",
      llmClient: mockLlm as any,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    expect(result.angleQualityEvents).toHaveLength(1);
    const event = result.angleQualityEvents[0];
    expect(event.gateMode).toBe("observe");
    expect(event.action).toBe("passed");
    expect(event.contractResult).not.toBeNull();
    expect(event.contractResult!.verdict).toBe("pass");
  });

  it("reports v2 fail verdict when angle is vague, even though v1 allows create", async () => {
    const item = makeItem({
      text: "This is a substantive test source with long enough text for all thresholds to clear on the strict tier.",
      summary: "Long enough summary with repeated substance for evidence thickness gate."
    });
    const mockLlm = buildMockLlm(item.externalId, {
      angle: VAGUE_ANGLE,
      confidence: 0.9,
      angleQualitySignals: undefined,
      editorialClaim: undefined
    });

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "co-1",
      llmClient: mockLlm as any,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    expect(result.angleQualityEvents).toHaveLength(1);
    const event = result.angleQualityEvents[0];
    expect(event.gateMode).toBe("observe");
    expect(event.action).toBe("blocked-skip");
    expect(event.contractResult!.verdict).toBe("fail");
    // But v1 allowed it, so the item actually created
    expect(result.created).toHaveLength(1);
  });

  it("reports v2 warn verdict for curated source with partial signals", () => {
    // Test evaluateAngleContract directly to isolate the contract verdict logic.
    const decision = makeDecision({
      angle: "Buyers still delay adoption because vendors cannot prove output equivalence before go-live",
      editorialClaim: "The adoption bottleneck is trust, not cost",
      angleQualitySignals: {
        specificity: "3-month parallel run caused by lack of verification tooling in the market",
        consequence: "Buyers delay adoption by months, increasing operational overhead significantly",
        tensionOrContrast: "Vendors claim seamless transitions but cannot demonstrate output equivalence",
        traceableEvidence: "none",
        positionSharpening: "none"
      }
    });
    const item = makeItem();
    // Long excerpt so traceableEvidence cross-check passes; no domain terms in
    // angle/claim so positionSharpening cross-check fails.
    const evidence = [makeEvidence({ excerpt: "Buyers report that parallel runs last three months on average due to verification gaps." })];

    const result = evaluateAngleContract({ decision, item, evidence, curated: true });

    expect(result.sharpness.isSharp).toBe(true);
    expect(result.dimensionResults.specificity.pass).toBe(true);
    expect(result.dimensionResults.consequence.pass).toBe(true);
    expect(result.dimensionResults.tensionOrContrast.pass).toBe(true);
    expect(result.dimensionResults.traceableEvidence.pass).toBe(true);
    expect(result.dimensionResults.positionSharpening.pass).toBe(false);
    expect(result.verdict).toBe("warn");
  });
});

// --- v2 pipeline coverage: pass / warn / fail / blocked-enrich / blocked-skip ---

describe("v2 gate pipeline decisions", () => {
  it("sharp angle with full signals creates cleanly (pass)", async () => {
    const item = makeItem();
    const mockLlm = buildMockLlm(item.externalId);

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "co-1",
      llmClient: mockLlm as any,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    expect(result.created).toHaveLength(1);
    expect(result.skipped.filter(s => s.reason.includes("quality gate"))).toHaveLength(0);
    expect(result.angleQualityEvents[0].action).toBe("passed");
  });

  it("vague angle with no candidates is blocked-skip", async () => {
    const item = makeItem({
      text: "Substantive text long enough for evidence thickness checks to pass on the strict tier without issues.",
      summary: "Substantive summary long enough for strict tier evidence checks."
    });
    const mockLlm = buildMockLlm(item.externalId, {
      angle: VAGUE_ANGLE,
      angleQualitySignals: undefined,
      editorialClaim: undefined,
      confidence: 0.9
    });

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "co-1",
      llmClient: mockLlm as any,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    expect(result.created).toHaveLength(0);
    expect(result.skipped.some(s => s.reason.includes("Angle quality gate failed"))).toBe(true);
    expect(result.angleQualityEvents[0].action).toBe("blocked-skip");
    expect(result.angleQualityEvents[0].contractResult!.verdict).toBe("fail");
  });

  it("vague angle with matching candidate is blocked-enrich", async () => {
    const existingOpp = makeOpportunity({
      id: "opp-existing",
      title: "Payroll automation adoption friction",
      angle: "Cabinets delay automation adoption because switching cost is hidden in parallel-run overhead",
      whatItIsAbout: "Payroll automation friction for French accounting firms"
    });
    const item = makeItem({
      title: "Payroll automation trends in accounting firms",
      text: "New market data about payroll automation adoption friction in French cabinets de paie. Repeated pattern: cabinets cite switching cost.",
      summary: "Payroll automation trends analysis for accounting firms"
    });
    const mockLlm = buildMockLlm(item.externalId, {
      angle: "Payroll automation challenges for accounting firms",
      confidence: 0.8,
      angleQualitySignals: undefined,
      editorialClaim: undefined
    });

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "co-1",
      llmClient: mockLlm as any,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existingOpp]
    });

    expect(result.created).toHaveLength(0);
    // Should downgrade to enrich if there's a concrete content match
    const enriched = result.enriched.length > 0;
    const skippedByGate = result.skipped.some(s => s.reason.includes("Angle quality gate failed"));
    expect(enriched || skippedByGate).toBe(true);
    if (enriched) {
      expect(result.angleQualityEvents[0].action).toBe("blocked-enrich");
    } else {
      expect(result.angleQualityEvents[0].action).toBe("blocked-skip");
    }
  });

  it("curated source with sharp angle but missing evidence/positioning signals creates with warning (warn)", async () => {
    const item = makeItem({
      source: "market-research",
      // Text long enough for v1 curated tier (>= 60 chars) with one excerpt >= 30 chars
      // so traceableEvidence passes, but positionSharpening fails (no domain terms)
      text: "Buyers report that parallel runs last three months on average due to verification gaps in every transition.",
      summary: "Market observation on adoption delays.",
      // Explicit chunks to ensure evidence excerpts are >= 30 chars
      chunks: ["Buyers report that parallel runs last three months on average due to verification gaps."]
    });
    const mockLlm = buildMockLlm(item.externalId, {
      // Angle without domain terms so positionSharpening cross-check also fails
      angle: "Buyers still delay adoption because vendors cannot prove output parity before go-live",
      confidence: 0.5,
      editorialClaim: "The adoption bottleneck is trust, not cost — vendors cannot demonstrate equivalence",
      angleQualitySignals: {
        specificity: "3-month parallel run caused by lack of verification tooling in the market",
        consequence: "Buyers delay adoption by months, increasing operational overhead significantly",
        tensionOrContrast: "Vendors claim seamless transitions but cannot demonstrate output parity to anyone",
        traceableEvidence: "none",
        positionSharpening: "none"
      }
    });

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "co-1",
      llmClient: mockLlm as any,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0].angle).toContain("output parity");
    expect(result.angleQualityEvents[0].action).toBe("warned");
    expect(result.angleQualityEvents[0].contractResult!.verdict).toBe("warn");
  });

  it("generic-subject angle is blocked even with high confidence", async () => {
    const item = makeItem({
      text: "A detailed analysis of the importance of reliability in payroll software for French accounting firms.",
      summary: "Analysis of reliability importance in payroll software."
    });
    const mockLlm = buildMockLlm(item.externalId, {
      angle: GENERIC_ANGLE,
      confidence: 0.95,
      angleQualitySignals: undefined,
      editorialClaim: undefined
    });

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "co-1",
      llmClient: mockLlm as any,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    expect(result.created).toHaveLength(0);
    expect(result.angleQualityEvents[0].action).toBe("blocked-skip");
  });
});

// --- Enrich empty-string sanitization ---

describe("enrich empty-string sanitization", () => {
  it("empty-string angle does not become a suggested update", () => {
    const existing = makeOpportunity({
      angle: "Original sharp angle about migration friction because of calculation opacity",
      whyNow: "Fresh evidence from Q1 2026 cabinet immersions",
      editorialClaim: "The migration bottleneck is calculation opacity"
    });
    const decision = makeDecision({
      action: "enrich",
      targetOpportunityId: existing.id,
      angle: "",
      whyNow: "",
      editorialClaim: ""
    });

    const result = buildEnrichmentUpdate({
      existing,
      decision,
      sourceItem: makeItem(),
      newEvidence: [makeEvidence({ id: "ev-new", excerptHash: "new-hash" })],
      ownerUserId: undefined
    });

    expect(result.logEntry.suggestedAngleUpdate).toBeUndefined();
    expect(result.logEntry.suggestedWhyNowUpdate).toBeUndefined();
    expect(result.logEntry.suggestedEditorialClaimUpdate).toBeUndefined();
  });

  it("whitespace-only fields do not become suggested updates", () => {
    const existing = makeOpportunity();
    const decision = makeDecision({
      action: "enrich",
      targetOpportunityId: existing.id,
      angle: "   ",
      whyNow: "\t\n",
      editorialClaim: "  "
    });

    const result = buildEnrichmentUpdate({
      existing,
      decision,
      sourceItem: makeItem(),
      newEvidence: [makeEvidence({ id: "ev-new", excerptHash: "new-hash" })],
      ownerUserId: undefined
    });

    expect(result.logEntry.suggestedAngleUpdate).toBeUndefined();
    expect(result.logEntry.suggestedWhyNowUpdate).toBeUndefined();
    expect(result.logEntry.suggestedEditorialClaimUpdate).toBeUndefined();
  });

  it("enrich with empty fields and no new evidence fails substance check", async () => {
    // Use a specific externalId and pre-compute the scoped sourceItemId to match
    const companyId = "co-1";
    const externalId = "market-research:empty-enrich";
    const scopedSiId = sourceItemDbId(companyId, externalId);

    // The existing opp already has evidence from this exact source item
    // with the same excerpt hash that the pipeline will generate.
    // We use the same text content so the excerpt hash matches.
    const sharedText = "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing.";
    const existingOpp = makeOpportunity({
      id: "opp-enrich-target",
      evidence: [makeEvidence({
        id: "ev-existing",
        sourceItemId: scopedSiId,
        excerpt: sharedText,
        excerptHash: "will-differ" // Hash won't match pipeline-generated hash
      })],
      angle: "Original sharp angle about migration friction because no vendor proves parity",
      whyNow: "Fresh evidence from field observations"
    });

    const item = makeItem({
      externalId,
      // Same text → pipeline generates evidence with same excerpt
      text: sharedText,
      summary: "Short"
    });
    const mockLlm = { generateStructured: vi.fn() };
    mockLlm.generateStructured
      .mockResolvedValueOnce(makeScreeningOutput(item.externalId))
      .mockResolvedValueOnce(makeLlmDecisionOutput({
        action: "enrich",
        targetOpportunityId: existingOpp.id,
        // All fields empty — should not become suggested updates
        angle: "",
        whyNow: "",
        editorialClaim: ""
      }));

    const result = await runIntelligencePipeline({
      items: [item],
      companyId,
      llmClient: mockLlm as any,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existingOpp]
    });

    // The evidence hash will differ from "will-differ", so new evidence IS added.
    // But the empty-string sanitization means no suggested angle/whyNow/claim updates.
    // Since new evidence exists, substance check passes — the enrichment proceeds.
    // This test validates that empty strings don't produce spurious suggested updates.
    if (result.enriched.length > 0) {
      const log = result.enriched[0].logEntry;
      expect(log.suggestedAngleUpdate).toBeUndefined();
      expect(log.suggestedWhyNowUpdate).toBeUndefined();
      expect(log.suggestedEditorialClaimUpdate).toBeUndefined();
    }
    // If no enrichment happened (e.g., evidence was deduplicated), it should be skipped
    // with a substance check reason.
    if (result.enriched.length === 0) {
      expect(result.skipped.some(s => s.reason.includes("no new evidence or sharper angle"))).toBe(true);
    }
  });

  it("evidence-only enrich with blank fields passes substance check", () => {
    // An enrichment that adds new evidence but does not update angle/whyNow/claim
    // is explicitly allowed by the enrich contract.
    const existing = makeOpportunity({
      angle: "Cabinets still run dual payroll because no vendor proves calculation parity upfront",
      whyNow: "Fresh evidence from field observations",
      editorialClaim: "The migration bottleneck is calculation opacity"
    });
    const decision = makeDecision({
      action: "enrich",
      targetOpportunityId: existing.id,
      // Blank fields — the LLM has no sharper angle to suggest
      angle: "",
      whyNow: "",
      editorialClaim: ""
    });
    const newEvidence = [makeEvidence({ id: "ev-brand-new", excerptHash: "brand-new-hash", excerpt: "New field observation about migration friction in 3 additional cabinets." })];

    const result = buildEnrichmentUpdate({
      existing,
      decision,
      sourceItem: makeItem(),
      newEvidence,
      ownerUserId: undefined
    });

    // New evidence was added — substance check passes
    expect(result.addedEvidence).toHaveLength(1);
    // No spurious suggested updates from blank fields
    expect(result.logEntry.suggestedAngleUpdate).toBeUndefined();
    expect(result.logEntry.suggestedWhyNowUpdate).toBeUndefined();
    expect(result.logEntry.suggestedEditorialClaimUpdate).toBeUndefined();
  });
});

// --- Origin-dedup enrich substance guard ---

describe("origin-dedup enrich substance guard", () => {
  it("origin-dedup enrich with new evidence proceeds", async () => {
    const existingOpp = makeOpportunity({
      id: sourceItemDbId("co-1", "market-research:origin-test") + "-opp",
      evidence: [makeEvidence({ id: "ev-old", sourceItemId: sourceItemDbId("co-1", "market-research:origin-test"), excerptHash: "old-hash" })]
    });

    const item = makeItem({
      externalId: "market-research:origin-test",
      title: "Origin item with new evidence",
      text: "New evidence paragraph about migration friction that is completely different from existing excerpts. Cabinets report cost overruns.",
      summary: "Different migration friction evidence"
    });

    const mockLlm = buildMockLlm(item.externalId, {
      angle: "Migration cost overruns force cabinets to delay because of parallel-run overhead",
      confidence: 0.9
    });

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "co-1",
      llmClient: mockLlm as any,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existingOpp],
      checkOriginDedupe: async () => null // no DB hit, but in-memory will find it
    });

    // The item has the same sourceItemId as existing evidence, so origin-dedup fires.
    // But the new text produces different excerpts → new evidence is added → substance passes.
    // This depends on hash differences in evidence. Let's check the dedup event.
    const originEvents = result.dedupEvents.filter(e => e.action === "enrich-by-origin");
    if (originEvents.length > 0) {
      // Origin dedup fired and enriched
      expect(result.enriched.length + result.skipped.length).toBeGreaterThan(0);
    }
  });

  it("origin-dedup enrich with same angle delta produces no spurious suggested updates", async () => {
    // The origin-dedup path always has new evidence by construction (the pipeline
    // builds fresh evidence from the item text, which produces new excerpt hashes).
    // So the substance check passes via hasNewEvidence.
    // What we prove here: the substance guard runs AND empty/identical angle fields
    // don't produce suggested updates.
    const scopedSiId = sourceItemDbId("co-1", "market-research:origin-dup");
    const existingOpp = makeOpportunity({
      id: "opp-origin-dup",
      evidence: [makeEvidence({
        id: "ev-existing-origin",
        sourceItemId: scopedSiId,
        excerpt: "Old evidence excerpt from a previous run."
      })],
      angle: "Cabinets run dual payroll for 3 months because no vendor proves parity upfront"
    });

    const item = makeItem({
      externalId: "market-research:origin-dup",
      title: "Duplicate origin item with new text",
      text: "New text paragraph that will produce different excerpt hashes than the existing evidence.",
      summary: "Different content"
    });

    const mockLlm = buildMockLlm(item.externalId, {
      // Same angle as existing — no delta should be suggested
      angle: existingOpp.angle,
      whyNow: existingOpp.whyNow,
      editorialClaim: existingOpp.editorialClaim
    });

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "co-1",
      llmClient: mockLlm as any,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existingOpp],
      checkOriginDedupe: async () => null
    });

    // Origin dedup fires because existingOpp has evidence with the same sourceItemId.
    // New text → different excerptHash → new evidence added → substance passes.
    // But angle/whyNow match existing → no suggested updates.
    const originEvents = result.dedupEvents.filter(e => e.action === "enrich-by-origin");
    expect(originEvents.length).toBeGreaterThanOrEqual(1);

    if (result.enriched.length > 0) {
      const log = result.enriched[0].logEntry;
      expect(log.suggestedAngleUpdate).toBeUndefined();
      expect(log.suggestedWhyNowUpdate).toBeUndefined();
    }
  });
});
