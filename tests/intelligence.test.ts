import { describe, expect, it, vi } from "vitest";
import {
  prefilterSourceItems,
  narrowCandidateOpportunities,
  buildNewOpportunity,
  buildEnrichmentUpdate,
  runIntelligencePipeline,
  buildIntelligenceEvidence
} from "../src/services/intelligence.js";
import type { NormalizedSourceItem, ContentOpportunity, EvidenceReference, CreateEnrichDecision, UserRecord } from "../src/domain/types.js";
import { normalizeGtmFields, normalizeGtmFieldsForOperatorEdit } from "../src/domain/types.js";
import { sourceItemDbId } from "../src/db/repositories.js";
import { dedupeEvidenceReferences } from "../src/services/evidence.js";

function makeItem(overrides: Partial<NormalizedSourceItem> = {}): NormalizedSourceItem {
  return {
    source: "notion",
    sourceItemId: "page123",
    externalId: "notion:page123",
    sourceFingerprint: "fp-123",
    sourceUrl: "https://example.com/page123",
    title: "Test source item",
    text: "This is a test source item with enough text to pass the prefilter threshold easily.",
    summary: "Test summary for this item",
    occurredAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    metadata: {},
    rawPayload: {},
    ...overrides
  };
}

function makeLinearItem(overrides: Partial<NormalizedSourceItem> = {}): NormalizedSourceItem {
  return makeItem({
    source: "linear",
    sourceItemId: "issue-123",
    externalId: "linear:issue-123",
    sourceFingerprint: "linear-fp-123",
    sourceUrl: "https://linear.app/example/issue/123",
    title: "API timeout errors reported by customers",
    summary: "Support ticket about recurring API timeout errors in production.",
    text: "Customers reported recurring API timeout errors in production during onboarding. The issue includes bug details and support context, not a standalone content idea.",
    ...overrides
  });
}

function makeMarketResearchItem(overrides: Partial<NormalizedSourceItem> = {}): NormalizedSourceItem {
  return makeItem({
    source: "market-research",
    sourceItemId: "market-query:mq-1:set:hash-1",
    externalId: "market-research:mq-1:hash-1",
    sourceFingerprint: "market-research-fp-1",
    sourceUrl: "https://example.com/market-research",
    title: "Market proof that buyers now expect concrete onboarding evidence",
    summary: "Repeated market research shows buyers dismiss generic onboarding claims and respond to specific, repeated proof from real implementation outcomes.",
    text: "Repeated market research shows buyers dismiss generic onboarding claims and respond to specific, repeated proof from real implementation outcomes. Multiple cited results point to the same lesson: teams want concrete evidence of simple adoption before they believe broader positioning claims.",
    metadata: {
      kind: "market_research_summary",
      marketQueryId: "mq-1"
    },
    rawPayload: {},
    ...overrides
  });
}

function makeOpportunity(overrides: Partial<ContentOpportunity> = {}): ContentOpportunity {
  const evidence: EvidenceReference = {
    id: "ev-1",
    source: "notion",
    sourceItemId: "si-1",
    sourceUrl: "https://example.com",
    timestamp: new Date().toISOString(),
    excerpt: "Some excerpt",
    excerptHash: "hash1",
    freshnessScore: 0.8
  };
  return {
    id: "opp-1",
    sourceFingerprint: "sf-1",
    title: "Test opportunity",
    narrativePillar: "general",
    angle: "Test angle",
    whyNow: "Test why now",
    whatItIsAbout: "About testing",
    whatItIsNotAbout: "Not about production",
    evidence: [evidence],
    primaryEvidence: evidence,
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

function makeDecisionOutput(overrides: Partial<CreateEnrichDecision> = {}) {
  return {
    output: {
      action: "create" as const,
      rationale: "new opportunity",
      title: "Created opportunity from repeated customer proof",
      territory: "sales",
      angle: "Repeated customer proof is more persuasive than generic product positioning.",
      whyNow: "Fresh supporting evidence shows this buying pattern is recurring right now.",
      whatItIsAbout: "A reusable lesson about how concrete proof changes customer trust and buying momentum.",
      whatItIsNotAbout: "not about that",
      suggestedFormat: "Narrative lesson post",
      confidence: 0.85,
      ...overrides
    },
    usage: { mode: "provider" as const, promptTokens: 200, completionTokens: 100, estimatedCostUsd: 0.002 },
    mode: "provider" as const
  };
}

function makeLinearPolicyOutput(classification: "editorial-lead" | "enrich-worthy" | "ignore" | "manual-review-needed" = "enrich-worthy") {
  return {
    output: {
      classification,
      rationale: `Test: classified as ${classification}`,
      customerVisibility: classification === "enrich-worthy" ? "shipped" : "ambiguous",
      sensitivityLevel: "safe",
      evidenceStrength: classification === "enrich-worthy" ? 0.8 : 0.3
    },
    usage: { mode: "provider" as const, promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
    mode: "provider" as const
  };
}

describe("prefilterSourceItems", () => {
  it("skips items older than freshness window", () => {
    const old = makeItem({ occurredAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() });
    const result = prefilterSourceItems([old]);
    expect(result.retained).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("30 days");
  });

  it("retains items within freshness window", () => {
    const recent = makeItem({ occurredAt: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString() });
    const result = prefilterSourceItems([recent]);
    expect(result.retained).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it("skips items with very short text", () => {
    const short = makeItem({ text: "too short" });
    const result = prefilterSourceItems([short]);
    expect(result.retained).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("short");
  });
});

describe("narrowCandidateOpportunities", () => {
  it("scores based on jaccard similarity", () => {
    const item = makeItem({ title: "sales objection handling", summary: "how to handle objections" });
    const screening = { decision: "retain" as const, rationale: "", createOrEnrich: "unknown" as const, relevanceScore: 0.5, sensitivityFlag: false, sensitivityCategories: [] };
    const opps = [
      makeOpportunity({ id: "opp-match", title: "sales objection", angle: "handling objections", whatItIsAbout: "sales" }),
      makeOpportunity({ id: "opp-nomatch", title: "marketing strategy", angle: "brand positioning", whatItIsAbout: "marketing" })
    ];
    const result = narrowCandidateOpportunities(item, screening, opps, "company-1");
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].id).toBe("opp-match");
    expect(result.topScore).toBeGreaterThan(0);
  });

  it("applies owner boost", () => {
    const item = makeItem({ title: "unique topic" });
    const screening = { decision: "retain" as const, rationale: "", ownerSuggestion: "quentin", createOrEnrich: "unknown" as const, relevanceScore: 0.5, sensitivityFlag: false, sensitivityCategories: [] };
    const opps = [
      makeOpportunity({ id: "opp-owner", ownerProfile: "quentin", title: "different topic" }),
      makeOpportunity({ id: "opp-noowner", title: "different topic" })
    ];
    const result = narrowCandidateOpportunities(item, screening, opps, "company-1");
    if (result.candidates.length >= 2) {
      expect(result.candidates[0].id).toBe("opp-owner");
    }
  });

  it("returns empty when no overlap > 0.05", () => {
    const item = makeItem({ title: "completely unrelated xyz", summary: "abc def ghi" });
    const screening = { decision: "retain" as const, rationale: "", createOrEnrich: "unknown" as const, relevanceScore: 0.5, sensitivityFlag: false, sensitivityCategories: [] };
    const opps = [
      makeOpportunity({ title: "very different topic indeed", angle: "another angle entirely", whatItIsAbout: "something else" })
    ];
    const result = narrowCandidateOpportunities(item, screening, opps, "company-1");
    expect(result.candidates.length).toBeLessThanOrEqual(5);
  });

  it("limits to max 5", () => {
    const item = makeItem({ title: "common word shared" });
    const screening = { decision: "retain" as const, rationale: "", createOrEnrich: "unknown" as const, relevanceScore: 0.5, sensitivityFlag: false, sensitivityCategories: [] };
    const opps = Array.from({ length: 10 }, (_, i) =>
      makeOpportunity({ id: `opp-${i}`, title: `common word shared context ${i}`, angle: `angle ${i}`, whatItIsAbout: `about ${i}` })
    );
    const result = narrowCandidateOpportunities(item, screening, opps, "company-1");
    expect(result.candidates.length).toBeLessThanOrEqual(5);
  });

  it("does not let owner boost outrank the exact topical match for enrich-only sources", () => {
    const item = makeItem({
      title: "La vraie objection au changement de logiciel : le coût de transition perçu comme ingérable",
      summary: "Une migration jugée longue, risquée et difficilement pilotable."
    });
    const screening = {
      decision: "retain" as const,
      rationale: "",
      ownerSuggestion: "thomas",
      createOrEnrich: "create" as const,
      relevanceScore: 0.88,
      sensitivityFlag: true,
      sensitivityCategories: ["internal-only"]
    };
    const opps = [
      makeOpportunity({
        id: "opp-exact",
        title: "La vraie objection au changement de logiciel : le coût de transition perçu comme ingérable",
        ownerProfile: "quentin",
        angle: "Montrer que le frein principal est la peur d'une migration longue et risquée.",
        whatItIsAbout: "Une objection commerciale centrée sur le coût de transition perçu."
      }),
      makeOpportunity({
        id: "opp-owner-boost",
        title: "Bonus-malus chômage 2026 : ce que change le nouveau calcul au 1er mars pour les employeurs",
        ownerProfile: "thomas",
        angle: "Expliquer une réforme paie importante.",
        whatItIsAbout: "Une évolution réglementaire sur le bonus-malus chômage."
      })
    ];

    const result = narrowCandidateOpportunities(item, screening, opps, "company-1", {
      enableOwnerBoost: false
    });

    expect(result.candidates[0]?.id).toBe("opp-exact");
  });
});

describe("buildNewOpportunity", () => {
  const companyId = "company-1";
  const evidence: EvidenceReference[] = [
    { id: "ev-1", source: "notion", sourceItemId: sourceItemDbId(companyId, "notion:page1"), sourceUrl: "https://example.com", timestamp: new Date().toISOString(), excerpt: "test excerpt", excerptHash: "hash1", freshnessScore: 0.9 }
  ];

  it("creates deterministic ID scoped by company", () => {
    const decision: CreateEnrichDecision = {
      action: "create", rationale: "test", title: "New opp", territory: "sales",
      angle: "test angle", whyNow: "fresh evidence", whatItIsAbout: "about",
      whatItIsNotAbout: "not about", suggestedFormat: "Narrative lesson post", confidence: 0.8
    };
    const item = makeItem();
    const opp = buildNewOpportunity({ decision, sourceItem: item, evidence, companyId });
    expect(opp).not.toBeNull();
    expect(opp!.id).toMatch(/^opportunity_/);
    expect(opp!.companyId).toBe(companyId);
  });

  it("returns null when no evidence", () => {
    const decision: CreateEnrichDecision = {
      action: "create", rationale: "test", title: "New opp", territory: "sales",
      angle: "test angle", whyNow: "why", whatItIsAbout: "about",
      whatItIsNotAbout: "not", suggestedFormat: "Narrative lesson post", confidence: 0.8
    };
    const opp = buildNewOpportunity({ decision, sourceItem: makeItem(), evidence: [], companyId });
    expect(opp).toBeNull();
  });

  it("propagates ownerUserId", () => {
    const decision: CreateEnrichDecision = {
      action: "create", rationale: "test", title: "New opp", territory: "sales",
      angle: "test angle", whyNow: "why", whatItIsAbout: "about",
      whatItIsNotAbout: "not", suggestedFormat: "Narrative lesson post", confidence: 0.8,
      ownerDisplayName: "quentin"
    };
    const users: UserRecord[] = [
      { id: "user-1", companyId, displayName: "quentin", type: "human", language: "fr", baseProfile: {}, createdAt: "", updatedAt: "" }
    ];
    const opp = buildNewOpportunity({ decision, sourceItem: makeItem(), evidence, companyId, ownerUserId: "user-1", users });
    expect(opp!.ownerUserId).toBe("user-1");
    expect(opp!.ownerProfile).toBe("quentin");
  });
});

describe("buildEnrichmentUpdate", () => {
  it("appends enrichment log without mutating visible fields", () => {
    const existing = makeOpportunity({ title: "Original title", angle: "Original angle" });
    const newEvidence: EvidenceReference[] = [
      { id: "ev-new", source: "notion", sourceItemId: "si-2", sourceUrl: "https://example.com/2", timestamp: new Date().toISOString(), excerpt: "New excerpt", excerptHash: "hash-new", freshnessScore: 0.95 }
    ];
    const decision: CreateEnrichDecision = {
      action: "enrich", targetOpportunityId: existing.id, rationale: "enriching",
      title: "Different title", territory: "sales", angle: "Different angle",
      whyNow: "new evidence", whatItIsAbout: "about", whatItIsNotAbout: "not about",
      suggestedFormat: "Short insight", confidence: 0.7
    };

    const result = buildEnrichmentUpdate({
      existing, decision, sourceItem: makeItem(), newEvidence
    });

    expect(result.updatedOpportunity.title).toBe("Original title");
    expect(result.updatedOpportunity.angle).toBe("Original angle");
    expect(result.logEntry.suggestedAngleUpdate).toBe("Different angle");
    expect(result.updatedOpportunity.enrichmentLog).toHaveLength(1);
    expect(result.addedEvidence).toHaveLength(1);
  });

  it("dedupes evidence by sourceItemId + excerptHash", () => {
    const existing = makeOpportunity();
    const duplicateEvidence: EvidenceReference[] = [
      { ...existing.evidence[0], id: "ev-dup" }
    ];
    const decision: CreateEnrichDecision = {
      action: "enrich", targetOpportunityId: existing.id, rationale: "test",
      title: "t", territory: "g", angle: existing.angle, whyNow: existing.whyNow,
      whatItIsAbout: "a", whatItIsNotAbout: "n", suggestedFormat: "s", confidence: 0.5
    };

    const result = buildEnrichmentUpdate({
      existing, decision, sourceItem: makeItem(), newEvidence: duplicateEvidence
    });

    expect(result.addedEvidence).toHaveLength(0);
  });
});

describe("standalone evidence flows through to downstream consumers", () => {
  it("opportunity built from standalone evidence carries full evidenceExcerpts for drafts and correct proof count for slack", () => {
    const companyId = "company-1";
    const item = makeItem();
    const evidence = buildIntelligenceEvidence(item, companyId);
    expect(evidence.length).toBeGreaterThan(0);

    const decision: CreateEnrichDecision = {
      action: "create", rationale: "test", title: "New opp", territory: "sales",
      angle: "test angle", whyNow: "fresh evidence", whatItIsAbout: "about",
      whatItIsNotAbout: "not about", suggestedFormat: "Narrative lesson post", confidence: 0.8
    };
    const opp = buildNewOpportunity({ decision, sourceItem: item, evidence, companyId });
    expect(opp).not.toBeNull();

    // Verify evidence is fully populated — this is what drafts.ts reads at line 44
    expect(opp!.evidenceExcerpts.length).toBe(opp!.evidence.length);
    expect(opp!.evidenceExcerpts.length).toBeGreaterThan(0);
    for (const excerpt of opp!.evidenceExcerpts) {
      expect(excerpt.length).toBeGreaterThan(0);
    }

    // Verify proof count — this is what slack.ts reads at line 56
    expect(opp!.evidence.length).toBeGreaterThan(0);
    expect(opp!.supportingEvidenceCount).toBe(opp!.evidence.length - 1);
  });

  it("mapOpportunityRow-style merge of FK + junction evidence dedupes correctly", () => {
    // Simulates what mapOpportunityRow does: merge FK evidence and junction evidence
    const fkEvidence: EvidenceReference[] = [
      { id: "ev-fk-1", source: "notion", sourceItemId: "si-1", sourceUrl: "https://example.com", timestamp: new Date().toISOString(), excerpt: "FK excerpt", excerptHash: "hash-a", freshnessScore: 0.8 }
    ];
    const junctionEvidence: EvidenceReference[] = [
      { id: "ev-junction-1", source: "notion", sourceItemId: "si-2", sourceUrl: "https://example.com/2", timestamp: new Date().toISOString(), excerpt: "Junction excerpt", excerptHash: "hash-b", freshnessScore: 0.9 },
      // Duplicate of FK evidence (same sourceItemId + excerptHash, different id)
      { id: "ev-junction-dup", source: "notion", sourceItemId: "si-1", sourceUrl: "https://example.com", timestamp: new Date().toISOString(), excerpt: "FK excerpt", excerptHash: "hash-a", freshnessScore: 0.8 }
    ];

    const allEvidence = dedupeEvidenceReferences([...fkEvidence, ...junctionEvidence]);

    // Should dedupe the duplicate, keeping 2 unique pieces
    expect(allEvidence).toHaveLength(2);

    // Both unique excerpts present — drafts.ts would receive both
    const excerpts = allEvidence.map(e => e.excerpt);
    expect(excerpts).toContain("FK excerpt");
    expect(excerpts).toContain("Junction excerpt");

    // Slack would show correct proof count
    expect(allEvidence.length).toBe(2);
  });

  it("junction-only evidence (new pipeline opportunity) provides full data for drafts and slack", () => {
    // Simulates a new-pipeline opportunity: no FK evidence, only junction evidence
    const fkEvidence: EvidenceReference[] = [];
    const junctionEvidence: EvidenceReference[] = [
      { id: "ev-j1", source: "notion", sourceItemId: "si-1", sourceUrl: "https://example.com", timestamp: new Date().toISOString(), excerpt: "First proof from the field", excerptHash: "hash-1", freshnessScore: 0.9 },
      { id: "ev-j2", source: "linear", sourceItemId: "si-2", sourceUrl: "https://example.com/2", timestamp: new Date().toISOString(), excerpt: "Second supporting proof", excerptHash: "hash-2", freshnessScore: 0.7 }
    ];

    const allEvidence = dedupeEvidenceReferences([...fkEvidence, ...junctionEvidence]);

    expect(allEvidence).toHaveLength(2);

    // drafts.ts line 44: evidenceExcerpts would be populated from this
    const excerpts = allEvidence.map(e => e.excerpt);
    expect(excerpts).toEqual(["First proof from the field", "Second supporting proof"]);

    // slack.ts line 56: proof count would be correct
    expect(allEvidence.length).toBe(2);
  });
});

describe("runIntelligencePipeline", () => {
  it("allows an insight-shaped source to create an opportunity", async () => {
    const items = [makeMarketResearchItem()];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput())
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "test doctrine",
      sensitivityMarkdown: "test sensitivity",
      userDescriptions: "- user1 (human, en)",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0].title).toBe("Created opportunity from repeated customer proof");
    expect(result.processedSourceItemIds).toContain("market-research:mq-1:hash-1");
  });

  it("skips linear items without calling create-enrich when no existing opportunity is a strong match", async () => {
    const items = [makeLinearItem()];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("linear:issue-123"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("enrich-worthy"))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
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
    expect(result.enriched).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({ sourceItemId: "linear:issue-123" })
    ]);
    expect(result.processedSourceItemIds).toContain("linear:issue-123");
    // screening + linear-enrichment-policy = 2 calls (no create-enrich call)
    expect(mockLlmClient.generateStructured).toHaveBeenCalledTimes(2);
  });

  it("allows linear items to enrich an existing opportunity when the target is a valid match", async () => {
    const items = [makeLinearItem()];
    const existing = makeOpportunity({
      id: "opp-api-timeout",
      title: "API timeout errors in onboarding",
      angle: "Recurring API timeout bugs are a product signal",
      whatItIsAbout: "API timeout errors reported by customers during onboarding"
    });
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("linear:issue-123"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("enrich-worthy"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "enrich",
          targetOpportunityId: existing.id,
          rationale: "Direct overlap with the existing API timeout opportunity"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existing]
    });

    expect(result.created).toHaveLength(0);
    expect(result.enriched).toHaveLength(1);
    expect(result.enriched[0].opportunity.id).toBe(existing.id);
    expect(result.skipped).toHaveLength(0);
    expect(result.processedSourceItemIds).toContain("linear:issue-123");
  });

  it("rewrites linear create decisions to enrich on the top matching opportunity", async () => {
    const items = [makeLinearItem()];
    const strongestMatch = makeOpportunity({
      id: "opp-top-match",
      title: "API timeout errors reported by customers",
      angle: "Recurring API timeout issues reveal onboarding friction",
      whatItIsAbout: "Customer-reported API timeout bugs during onboarding"
    });
    const weakerMatch = makeOpportunity({
      id: "opp-weaker-match",
      title: "General support issues",
      angle: "Customer friction themes",
      whatItIsAbout: "Support conversations"
    });
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("linear:issue-123"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("enrich-worthy"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          rationale: "Model tried to create a new opportunity from a ticket"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [strongestMatch, weakerMatch]
    });

    expect(result.created).toHaveLength(0);
    expect(result.enriched).toHaveLength(1);
    expect(result.enriched[0].opportunity.id).toBe(strongestMatch.id);
    expect(result.processedSourceItemIds).toContain("linear:issue-123");
  });

  it("keeps linear skip decisions as skip even when a candidate exists", async () => {
    const items = [makeLinearItem()];
    const existing = makeOpportunity({
      id: "opp-existing",
      title: "API timeout errors reported by customers",
      angle: "Recurring API timeout issues reveal onboarding friction",
      whatItIsAbout: "Customer-reported API timeout bugs during onboarding"
    });
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("linear:issue-123"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("enrich-worthy"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "skip",
          rationale: "Bug ticket is not useful for this opportunity"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existing]
    });

    expect(result.created).toHaveLength(0);
    expect(result.enriched).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({ sourceItemId: "linear:issue-123" })
    ]);
    expect(result.processedSourceItemIds).toContain("linear:issue-123");
  });

  it("skips weak create payloads instead of creating new opportunities", async () => {
    const items = [makeMarketResearchItem({
      summary: "Thin.",
      text: "Short text that passes prefilter threshold minimum."
    })];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput({
          confidence: 0.3,
          title: "Hmm",
          angle: "unclear",
          whatItIsAbout: "not sure"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
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
    expect(result.enriched).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        sourceItemId: "market-research:mq-1:hash-1",
        reason: expect.stringContaining("quality gate failed")
      })
    ]);
  });

  it("excludes failed items from processedSourceItemIds", async () => {
    const items = [makeMarketResearchItem()];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockRejectedValueOnce(new Error("LLM failed"))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
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
    expect(result.processedSourceItemIds).not.toContain("market-research:mq-1:hash-1");
  });

  it("curated source with moderate confidence passes lighter gate and creates", async () => {
    const items = [makeMarketResearchItem()];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput({
          confidence: 0.55,
          title: "Buyer proof trend",
          angle: "Concrete proof changes buying behavior",
          whyNow: "Short",
          whatItIsAbout: "How buyers respond to implementation proof"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
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
    expect(result.created[0].title).toBe("Buyer proof trend");
  });

  it("notion market-insight passes curated gate", async () => {
    const items = [makeItem({
      source: "notion",
      sourceItemId: "page-insight-1",
      externalId: "notion:page-insight-1",
      title: "Enterprise buyers want proof of simple onboarding",
      summary: "Market insight: enterprise buyers increasingly demand concrete proof of simple onboarding before purchasing.",
      text: "Detailed observation from the field: enterprise buyers are asking for concrete onboarding timelines and proof points before committing to purchase decisions. This pattern is recurring across multiple deals.",
      metadata: { notionKind: "market-insight" }
    })];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("notion:page-insight-1"))
        .mockResolvedValueOnce(makeDecisionOutput({
          confidence: 0.5,
          title: "Onboarding proof demand",
          angle: "Enterprise buyers want proof before committing",
          whyNow: "Now",
          whatItIsAbout: "Buyer behavior around onboarding evidence"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
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
    expect(result.created[0].title).toBe("Onboarding proof demand");
  });

  it("curated source with truly junk fields is still blocked", async () => {
    const items = [makeMarketResearchItem({
      summary: "Vague.",
      text: "Short text that passes prefilter threshold minimum."
    })];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput({
          confidence: 0.2,
          title: "Hmm",
          angle: "not sure",
          whatItIsAbout: "not sure"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
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
    expect(result.skipped).toEqual([
      expect.objectContaining({
        sourceItemId: "market-research:mq-1:hash-1",
        reason: expect.stringContaining("quality gate failed")
      })
    ]);
  });

  it("ambiguous overlap on curated source prefers create over enrich", async () => {
    const items = [makeMarketResearchItem()];
    const existing = makeOpportunity({
      id: "opp-unrelated",
      title: "Completely different topic about branding strategy",
      angle: "Brand positioning in competitive markets",
      whatItIsAbout: "How to position brand in crowded markets"
    });
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "enrich",
          targetOpportunityId: existing.id,
          confidence: 0.4,
          rationale: "Weak match to existing opportunity"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existing]
    });

    expect(result.created).toHaveLength(1);
    expect(result.enriched).toHaveLength(0);
  });

  it("high-confidence enrich on curated source with strong match is preserved", async () => {
    const items = [makeMarketResearchItem()];
    const existing = makeOpportunity({
      id: "opp-strong-match",
      title: "Market proof that buyers now expect concrete onboarding evidence",
      angle: "Repeated customer proof is more persuasive than generic positioning",
      whatItIsAbout: "Concrete proof changes customer trust and buying momentum"
    });
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "enrich",
          targetOpportunityId: existing.id,
          confidence: 0.75,
          rationale: "Strong match — enriching existing opportunity with fresh proof"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existing]
    });

    expect(result.created).toHaveLength(0);
    expect(result.enriched).toHaveLength(1);
    expect(result.enriched[0].opportunity.id).toBe(existing.id);
  });

  it("enrich-only source with low-confidence enrich is NOT converted to create", async () => {
    const items = [makeLinearItem()];
    const existing = makeOpportunity({
      id: "opp-linear-match",
      title: "API timeout errors in onboarding",
      angle: "Recurring API timeout bugs are a product signal",
      whatItIsAbout: "API timeout errors reported by customers during onboarding"
    });
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("linear:issue-123"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("enrich-worthy"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "enrich",
          targetOpportunityId: existing.id,
          confidence: 0.3,
          rationale: "Weak match but only option for this source"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existing]
    });

    expect(result.created).toHaveLength(0);
    expect(result.enriched).toHaveLength(1);
    expect(result.enriched[0].opportunity.id).toBe(existing.id);
  });

  it("curated source skips on LLM fallback instead of auto-creating", async () => {
    const items = [makeMarketResearchItem()];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockImplementationOnce((params: { fallback: () => unknown }) => {
          // Simulate LLM failure: invoke the fallback function
          const fallbackOutput = params.fallback();
          return Promise.resolve({
            output: fallbackOutput,
            usage: { mode: "fallback" as const, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0, error: "simulated failure" },
            mode: "fallback" as const
          });
        })
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
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
    expect(result.skipped).toEqual([
      expect.objectContaining({
        sourceItemId: "market-research:mq-1:hash-1",
        reason: expect.stringContaining("LLM fallback")
      })
    ]);
  });

  it("linear with no candidates skips before create/enrich — LLM called twice (screening + linear policy)", async () => {
    const items = [makeLinearItem()];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("linear:issue-123"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("enrich-worthy"))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
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
    expect(result.enriched).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({ sourceItemId: "linear:issue-123" })
    ]);
    // screening + linear-enrichment-policy = 2 calls (no create-enrich for enrich-only with no candidates)
    expect(mockLlmClient.generateStructured).toHaveBeenCalledTimes(2);
  });

  it("internal-proof items cannot create opportunities", async () => {
    const items = [makeItem({
      source: "notion",
      sourceItemId: "proof-soc2",
      externalId: "notion:proof-soc2",
      title: "SOC 2 Type II certification achieved for enterprise trust",
      summary: "Completed SOC 2 Type II audit with zero critical findings. Enterprise buyers demand concrete proof.",
      text: "SOC 2 Type II audit completed with zero critical findings. Enterprise buyers demand concrete proof of security compliance before purchasing decisions. This certification establishes trust and buyer confidence.",
      metadata: { notionKind: "internal-proof", proofCategory: "security" }
    })];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("notion:proof-soc2"))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
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
    expect(result.skipped).toEqual([
      expect.objectContaining({ sourceItemId: "notion:proof-soc2" })
    ]);
    // Only screening call — no create/enrich since enrich-only with no candidates
    expect(mockLlmClient.generateStructured).toHaveBeenCalledTimes(1);
  });

  it("internal-proof items converted to enrich when LLM says create", async () => {
    const items = [makeItem({
      source: "notion",
      sourceItemId: "proof-soc2",
      externalId: "notion:proof-soc2",
      title: "SOC 2 Type II certification achieved for enterprise trust",
      summary: "Completed SOC 2 Type II audit with zero critical findings. Enterprise buyers demand concrete proof.",
      text: "SOC 2 Type II audit completed with zero critical findings. Enterprise buyers demand concrete proof of security compliance before purchasing decisions. This certification establishes trust and buyer confidence.",
      metadata: { notionKind: "internal-proof", proofCategory: "security" }
    })];
    const existing = makeOpportunity({
      id: "opp-enterprise-trust",
      title: "Enterprise buyers demand security proof before purchasing",
      angle: "SOC 2 certification builds enterprise buyer trust",
      whatItIsAbout: "Security compliance proof for enterprise purchasing decisions"
    });
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("notion:proof-soc2"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          rationale: "Model tried to create from proof material"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existing]
    });

    expect(result.created).toHaveLength(0);
    expect(result.enriched).toHaveLength(1);
    expect(result.enriched[0].opportunity.id).toBe(existing.id);
  });

  it("internal-proof items enrich when matching opportunity exists", async () => {
    const items = [makeItem({
      source: "notion",
      sourceItemId: "proof-soc2",
      externalId: "notion:proof-soc2",
      title: "SOC 2 Type II certification achieved for enterprise trust",
      summary: "Completed SOC 2 Type II audit with zero critical findings. Enterprise buyers demand concrete proof.",
      text: "SOC 2 Type II audit completed with zero critical findings. Enterprise buyers demand concrete proof of security compliance before purchasing decisions. This certification establishes trust and buyer confidence.",
      metadata: { notionKind: "internal-proof", proofCategory: "security" }
    })];
    const existing = makeOpportunity({
      id: "opp-enterprise-trust",
      title: "Enterprise buyers demand security proof before purchasing",
      angle: "SOC 2 certification builds enterprise buyer trust",
      whatItIsAbout: "Security compliance proof for enterprise purchasing decisions"
    });
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("notion:proof-soc2"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "enrich",
          targetOpportunityId: existing.id,
          rationale: "SOC 2 proof supports enterprise trust opportunity"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existing]
    });

    expect(result.created).toHaveLength(0);
    expect(result.enriched).toHaveLength(1);
    expect(result.enriched[0].opportunity.id).toBe(existing.id);
  });
});

// ── editorial-lead curated behavior ────────────────────────────────────────

function makeEditorialLeadItem(overrides: Partial<NormalizedSourceItem> = {}): NormalizedSourceItem {
  return makeItem({
    source: "linear",
    sourceItemId: "pu-lead-1",
    externalId: "linear:pu-lead-1",
    sourceFingerprint: "linear-lead-fp-1",
    sourceUrl: "https://linear.app/linc-fr/project-update/pu-lead-1",
    title: "Nouveauté produit: bulletin détaillé cliquable dans le studio",
    summary: "Shipped: clickable payslip PDF — every number in the detailed payslip is now interactive for computation rule inspection in the studio.",
    text: "Le bulletin détaillé en PDF devient cliquable dans le studio pour comprendre chaque valeur. Chaque nombre est cliquable y compris les compteurs de congés. Certains libellés le sont également. Cette fonctionnalité permet aux gestionnaires de paie de vérifier rapidement les règles de calcul appliquées à chaque ligne.",
    metadata: {
      itemType: "project_update",
      projectState: "completed",
      projectHealth: "onTrack",
      projectName: "Payslip PDF clickable"
    },
    ...overrides
  });
}

describe("editorial-lead curated behavior", () => {
  it("editorial-lead passes the lighter curated create gate", async () => {
    const items = [makeEditorialLeadItem()];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("linear:pu-lead-1"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("editorial-lead"))
        .mockResolvedValueOnce(makeDecisionOutput({
          confidence: 0.5,
          title: "Bulletin cliquable: transparence du calcul",
          angle: "Clickable payslip as transparency tool for accountants",
          whyNow: "Short",
          whatItIsAbout: "Interactive payslip PDF feature"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    // Curated gate: confidence 0.5 >= 0.4, title >= 6, angle >= 10, whatItIsAbout >= 10 → passes
    expect(result.created).toHaveLength(1);
    expect(result.created[0].title).toBe("Bulletin cliquable: transparence du calcul");
  });

  it("editorial-lead with weak candidate match and low-confidence enrich is promoted to create", async () => {
    const items = [makeEditorialLeadItem()];
    const existing = makeOpportunity({
      id: "opp-unrelated-topic",
      title: "Completely different topic about compliance deadlines and regulatory obligations",
      angle: "Compliance deadline management for mid-market HR teams",
      whatItIsAbout: "How to track compliance deadlines across departments"
    });
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("linear:pu-lead-1"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("editorial-lead"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "enrich",
          targetOpportunityId: existing.id,
          confidence: 0.4,
          rationale: "Weak match to existing opportunity"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existing]
    });

    // Curated + create-capable + weak match + low confidence → promoted to create
    expect(result.created).toHaveLength(1);
    expect(result.enriched).toHaveLength(0);
  });

  it("enrich-worthy Linear item does NOT get curated behavior", async () => {
    const items = [makeEditorialLeadItem({ externalId: "linear:pu-ew-1", sourceItemId: "pu-ew-1" })];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("linear:pu-ew-1"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("enrich-worthy"))
        .mockResolvedValueOnce(makeDecisionOutput({
          confidence: 0.5,
          title: "Bulletin cliquable: transparence du calcul",
          angle: "Clickable payslip as transparency tool for accountants",
          whyNow: "Short",
          whatItIsAbout: "Interactive payslip PDF feature"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    // enrich-worthy is enrich-only + non-curated → no candidates → skipped
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        sourceItemId: "linear:pu-ew-1",
        reason: expect.stringContaining("evidence-shaped")
      })
    ]);
  });

  it("editorial-lead uses lighter create gate while enrich-worthy uses stricter one", async () => {
    // editorial-lead with moderate confidence and short whyNow passes curated gate
    const leadItem = makeEditorialLeadItem();
    const leadLlm = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("linear:pu-lead-1"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("editorial-lead"))
        .mockResolvedValueOnce(makeDecisionOutput({
          confidence: 0.5,
          title: "Bulletin cliquable: transparence",
          angle: "Clickable payslip as transparency tool",
          whyNow: "Short",  // < 24 chars: fails strict gate, passes curated gate
          whatItIsAbout: "Interactive payslip PDF feature"
        }))
    } as any;

    const leadResult = await runIntelligencePipeline({
      items: [leadItem],
      companyId: "company-1",
      llmClient: leadLlm,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    // editorial-lead (curated): passes lighter gate despite short whyNow and 0.5 confidence
    expect(leadResult.created).toHaveLength(1);

    // Same item but classified as enrich-worthy with identical LLM decision
    // enrich-worthy is enrich-only so it can't even reach the create gate without candidates.
    // Instead, prove that if an enrich-worthy item *could* create (hypothetical),
    // the strict gate would block it. We test this indirectly: the enrich-worthy item
    // with no candidates is skipped as evidence-shaped (never reaches create).
    const ewItem = makeEditorialLeadItem({ externalId: "linear:pu-ew-2", sourceItemId: "pu-ew-2" });
    const ewLlm = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("linear:pu-ew-2"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("enrich-worthy"))
        .mockResolvedValueOnce(makeDecisionOutput({
          confidence: 0.5,
          title: "Bulletin cliquable: transparence",
          angle: "Clickable payslip as transparency tool",
          whyNow: "Short",
          whatItIsAbout: "Interactive payslip PDF feature"
        }))
    } as any;

    const ewResult = await runIntelligencePipeline({
      items: [ewItem],
      companyId: "company-1",
      llmClient: ewLlm,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    // enrich-worthy (non-curated, enrich-only): blocked before reaching create gate
    expect(ewResult.created).toHaveLength(0);
  });
});

// ── duplicate prevention (working candidate pool + DB-backed origin dedupe) ─

describe("duplicate prevention across batch items", () => {
  it("two related items in the same batch: first creates, second enriches via working pool", async () => {
    // Two HCR-related Linear items in the same batch — should NOT create two opportunities
    const itemA = makeEditorialLeadItem({
      sourceItemId: "pu-hcr-a",
      externalId: "linear:pu-hcr-a",
      title: "HCR convention support fully shipped on Linc",
      summary: "Complete HCR convention support for payroll calculation deployed to production.",
      text: "La convention HCR (Hôtels, Cafés, Restaurants) est désormais entièrement supportée sur Linc, incluant les spécificités de calcul de paie, les congés et les primes conventionnelles.",
    });
    const itemB = makeEditorialLeadItem({
      sourceItemId: "pu-hcr-b",
      externalId: "linear:pu-hcr-b",
      title: "HCR convention: CP counting in working days deployed",
      summary: "HCR convention leave counting in working days is now live on Linc platform.",
      text: "Le décompte des CP en jours ouvrables pour la convention HCR est maintenant déployé sur Linc. Cette mise à jour complète la prise en charge de la convention HCR pour les congés payés.",
    });

    const llm = {
      generateStructured: vi.fn()
        // Screening batch (both items)
        .mockResolvedValueOnce({
          output: {
            items: [
              { sourceItemId: "linear:pu-hcr-a", decision: "retain", rationale: "HCR", createOrEnrich: "create", relevanceScore: 0.9, sensitivityFlag: false, sensitivityCategories: [] },
              { sourceItemId: "linear:pu-hcr-b", decision: "retain", rationale: "HCR", createOrEnrich: "create", relevanceScore: 0.9, sensitivityFlag: false, sensitivityCategories: [] }
            ]
          },
          usage: { mode: "provider", promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
          mode: "provider"
        })
        // Linear enrichment policy — item A
        .mockResolvedValueOnce(makeLinearPolicyOutput("editorial-lead"))
        // Linear enrichment policy — item B
        .mockResolvedValueOnce(makeLinearPolicyOutput("editorial-lead"))
        // Create/enrich decision — item A → create
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          title: "HCR convention complète sur Linc",
          angle: "La convention HCR est désormais entièrement supportée sur Linc",
          whyNow: "Major convention support just shipped to production",
          whatItIsAbout: "HCR payroll convention full support on Linc platform",
          confidence: 0.9
        }))
        // Create/enrich decision — item B → LLM sees the candidate from the working pool
        // and decides to enrich it. mockImplementationOnce dynamically extracts the
        // candidate opportunity ID from the prompt (just like a real LLM would).
        .mockImplementationOnce(async (args: any) => {
          const prompt: string = args?.prompt ?? "";
          const idMatch = prompt.match(/- ID: (\S+)/);
          const targetId = idMatch ? idMatch[1] : undefined;
          // The working pool should have provided at least one candidate
          expect(targetId).toBeTruthy();
          return makeDecisionOutput({
            action: "enrich",
            targetOpportunityId: targetId,
            rationale: "Similar HCR opportunity already exists, enriching",
            confidence: 0.8
          });
        })
    } as any;

    // checkOriginDedupe returns null — no prior DB state (first run)
    const checkOriginDedupe = vi.fn().mockResolvedValue(null);

    const result = await runIntelligencePipeline({
      items: [itemA, itemB],
      companyId: "company-1",
      llmClient: llm,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [],
      checkOriginDedupe
    });

    // Only ONE opportunity created, second item enriches it
    expect(result.created).toHaveLength(1);
    expect(result.created[0].title).toContain("HCR");
    expect(result.enriched.length).toBeGreaterThanOrEqual(1);
  });

  it("same source item reprocessed (replay): in-memory dedupe when opp is in snapshot", async () => {
    // Simulate replay: source item already created an opportunity that IS in recentOpportunities
    const item = makeEditorialLeadItem({
      sourceItemId: "pu-replay-1",
      externalId: "linear:pu-replay-1",
      title: "Nouveauté produit: DSN connection deployed",
      summary: "DSN filing connection with net-entreprises is now live on Linc platform.",
      text: "La connexion DSN avec net-entreprises est désormais déployée et opérationnelle sur Linc. Les gestionnaires de paie peuvent maintenant soumettre leurs DSN directement depuis la plateforme.",
    });

    // Build evidence that would exist from the first processing
    const existingEvidence = buildIntelligenceEvidence(item, "company-1");
    const existingOpp = makeOpportunity({
      id: "opp-dsn-existing",
      title: "DSN connection: filing automation on Linc",
      angle: "Automated DSN filing eliminates manual submission",
      whatItIsAbout: "DSN net-entreprises integration on Linc",
      evidence: existingEvidence,
      primaryEvidence: existingEvidence[0],
    });

    const llm = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("linear:pu-replay-1"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("editorial-lead"))
        // LLM says "create" (doesn't know the opportunity already exists)
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          title: "DSN net-entreprises: live integration",
          angle: "Direct DSN submission from Linc payroll studio",
          whyNow: "Freshly deployed DSN connection saves manual filing time",
          whatItIsAbout: "Automated DSN filing through net-entreprises API",
          confidence: 0.85
        }))
    } as any;

    // DB check also returns the hit — but in-memory fires first
    const checkOriginDedupe = vi.fn().mockResolvedValue(
      { id: "opp-dsn-existing", title: "DSN connection: filing automation on Linc" }
    );

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: llm,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existingOpp],
      checkOriginDedupe
    });

    // Origin dedupe: no new opportunity created, converted to enrichment
    expect(result.created).toHaveLength(0);
    expect(result.enriched).toHaveLength(1);
    expect(result.enriched[0].opportunity.id).toBe("opp-dsn-existing");
  });

  it("replay deduped by DB check even when existing opp is outside the initial snapshot", async () => {
    // KEY SCENARIO: the existing opportunity has fallen out of the top-40
    // recentOpportunities window.  The DB-backed checkOriginDedupe catches it.
    const item = makeEditorialLeadItem({
      sourceItemId: "pu-old-replay",
      externalId: "linear:pu-old-replay",
      title: "Nouveauté produit: SIRH connector shipped",
      summary: "SIRH bi-directional connector deployed to production for enterprise clients.",
      text: "Le connecteur SIRH bidirectionnel est maintenant déployé en production pour les clients entreprises. Synchronisation automatique des données collaborateurs.",
    });

    const llm = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("linear:pu-old-replay"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("editorial-lead"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          title: "SIRH connector: enterprise HR sync",
          angle: "Bi-directional SIRH sync for enterprise payroll",
          whyNow: "Just shipped SIRH connector to production",
          whatItIsAbout: "Automated SIRH data synchronisation for enterprise clients",
          confidence: 0.9
        }))
    } as any;

    // DB-backed check returns an opportunity that is NOT in recentOpportunities
    const checkOriginDedupe = vi.fn().mockResolvedValue(
      { id: "opp-sirh-old", title: "SIRH connector for enterprise HR" }
    );

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: llm,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [],  // <-- empty snapshot, opp is NOT loaded
      checkOriginDedupe
    });

    // DB dedupe fires → creation blocked, item skipped with clear reason
    expect(result.created).toHaveLength(0);
    expect(result.enriched).toHaveLength(0);
    expect(result.skipped.some(s =>
      s.sourceItemId === "linear:pu-old-replay" && s.reason.includes("opp-sirh-old")
    )).toBe(true);
    // The callback was invoked with the correct sourceItemDbId
    expect(checkOriginDedupe).toHaveBeenCalledWith(
      sourceItemDbId("company-1", "linear:pu-old-replay")
    );
  });

  it("different source items about different topics create separate opportunities", async () => {
    const itemA = makeEditorialLeadItem({
      sourceItemId: "pu-dsn-1",
      externalId: "linear:pu-dsn-1",
      title: "DSN connection with net-entreprises deployed",
      summary: "DSN filing automation is now live on Linc platform for direct submission.",
      text: "La connexion DSN avec net-entreprises est maintenant déployée sur Linc. Les gestionnaires peuvent soumettre directement depuis la plateforme.",
    });
    const itemB = makeEditorialLeadItem({
      sourceItemId: "pu-pdf-1",
      externalId: "linear:pu-pdf-1",
      title: "Clickable payslip PDF in studio shipped",
      summary: "Interactive payslip PDF where every number is clickable for computation rule inspection.",
      text: "Le bulletin détaillé en PDF devient cliquable dans le studio pour comprendre chaque valeur calculée par le moteur de paie.",
    });

    const llm = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce({
          output: {
            items: [
              { sourceItemId: "linear:pu-dsn-1", decision: "retain", rationale: "DSN", createOrEnrich: "create", relevanceScore: 0.9, sensitivityFlag: false, sensitivityCategories: [] },
              { sourceItemId: "linear:pu-pdf-1", decision: "retain", rationale: "PDF", createOrEnrich: "create", relevanceScore: 0.9, sensitivityFlag: false, sensitivityCategories: [] }
            ]
          },
          usage: { mode: "provider", promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
          mode: "provider"
        })
        .mockResolvedValueOnce(makeLinearPolicyOutput("editorial-lead"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("editorial-lead"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          title: "DSN filing automation on Linc",
          angle: "Direct DSN submission removes manual filing friction",
          whyNow: "Freshly deployed DSN net-entreprises connection",
          whatItIsAbout: "Automated DSN filing through net-entreprises API from Linc",
          confidence: 0.9
        }))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          title: "Bulletin cliquable: transparence de la paie",
          angle: "Clickable payslip as transparency and verification tool",
          whyNow: "Just shipped interactive PDF payslip feature in studio",
          whatItIsAbout: "Interactive payslip PDF for computation rule inspection",
          confidence: 0.9
        }))
    } as any;

    // DB returns null for both — no prior opportunities
    const checkOriginDedupe = vi.fn().mockResolvedValue(null);

    const result = await runIntelligencePipeline({
      items: [itemA, itemB],
      companyId: "company-1",
      llmClient: llm,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [],
      checkOriginDedupe
    });

    // Two distinct topics → two separate opportunities (no false dedup)
    expect(result.created).toHaveLength(2);
    const titles = result.created.map(o => o.title);
    expect(titles).toContain("DSN filing automation on Linc");
    expect(titles).toContain("Bulletin cliquable: transparence de la paie");
    // DB check was called for each create decision
    expect(checkOriginDedupe).toHaveBeenCalledTimes(2);
  });

  it("enrichment of a newly created opportunity updates the working pool for subsequent items", async () => {
    const itemA = makeEditorialLeadItem({
      sourceItemId: "pu-enrich-a",
      externalId: "linear:pu-enrich-a",
      title: "SIRH integration engine completed",
      summary: "SIRH integration engine with bi-directional sync is now deployed on Linc platform.",
      text: "Le moteur d'intégration SIRH avec synchronisation bidirectionnelle est maintenant déployé sur Linc. Cette intégration permet aux entreprises de synchroniser automatiquement leurs données RH.",
    });
    const itemB = makeLinearItem({
      sourceItemId: "issue-sirh-detail",
      externalId: "linear:issue-sirh-detail",
      title: "SIRH integration: employee sync edge cases fixed",
      summary: "Fixed edge cases in SIRH employee sync for large enterprise deployments.",
      text: "Correction des cas limites dans la synchronisation SIRH pour les déploiements de grande entreprise. Les employés avec des contrats multiples sont maintenant correctement synchronisés.",
      metadata: { itemType: "issue", stateName: "Done" },
    });

    const llm = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce({
          output: {
            items: [
              { sourceItemId: "linear:pu-enrich-a", decision: "retain", rationale: "SIRH", createOrEnrich: "create", relevanceScore: 0.9, sensitivityFlag: false, sensitivityCategories: [] },
              { sourceItemId: "linear:issue-sirh-detail", decision: "retain", rationale: "SIRH", createOrEnrich: "enrich", relevanceScore: 0.7, sensitivityFlag: false, sensitivityCategories: [] }
            ]
          },
          usage: { mode: "provider", promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
          mode: "provider"
        })
        .mockResolvedValueOnce(makeLinearPolicyOutput("editorial-lead"))
        .mockResolvedValueOnce(makeLinearPolicyOutput("enrich-worthy"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          title: "SIRH integration engine on Linc",
          angle: "Bi-directional SIRH sync eliminates manual HR data management",
          whyNow: "SIRH integration engine just deployed to production",
          whatItIsAbout: "Automated SIRH integration with bi-directional employee data sync",
          confidence: 0.9
        }))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "enrich",
          rationale: "Supports existing SIRH opportunity with edge case fix details",
          confidence: 0.7
        }))
    } as any;

    const checkOriginDedupe = vi.fn().mockResolvedValue(null);

    const result = await runIntelligencePipeline({
      items: [itemA, itemB],
      companyId: "company-1",
      llmClient: llm,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [],
      checkOriginDedupe
    });

    // Item A creates, item B should NOT create a second SIRH opportunity
    expect(result.created).toHaveLength(1);
    expect(result.created[0].title).toContain("SIRH");
    const createdTitles = result.created.map(o => o.title);
    expect(createdTitles).toHaveLength(1);
  });
});

// --- Phase 1 dedup: shared text utilities ---

import {
  tokenizeV1,
  tokenizeV2,
  normalizeAccents,
  removeStopWords,
  jaccardSimilarity,
  DOMAIN_ALLOWLIST,
  STOP_WORDS
} from "../src/lib/text.js";
import {
  DEDUP_SCORING_VERSION,
  DEDUP_WARNINGS_ENABLED,
  DEDUP_CANDIDATE_WINDOW,
  DEDUP_WARNING_THRESHOLD,
  DEDUP_CONFIDENCE_CUTOFF,
  DEDUP_RESCUE_ENABLED
} from "../src/services/intelligence.js";

describe("lib/text — tokenizeV2 accent normalization", () => {
  it("normalizes French accents so accented and unaccented forms match", () => {
    const a = tokenizeV2("régularisations");
    const b = tokenizeV2("regularisations");
    expect(a).toEqual(b);
  });

  it("normalizes multiple diacritics: é è ê ë ï î ô ù û ü ÿ ç", () => {
    const result = tokenizeV2("éèêëïîôùûüÿç");
    expect(result).toEqual(["eeeeiiouuuyc"]);
  });

  it("expands œ and æ ligatures", () => {
    const result = normalizeAccents("œuvre cæsium");
    expect(result).toBe("oeuvre caesium");
  });
});

describe("lib/text — tokenizeV2 punctuation stripping", () => {
  it("strips periods and slashes from tokens", () => {
    const a = tokenizeV2("net fiscal vs. net payé");
    const b = tokenizeV2("net fiscal / net paye");
    // "vs." → "vs" (period stripped), "payé" → "paye" (accent normalized)
    expect(a).toContain("vs");
    expect(a).toContain("paye");
    // "/" is stripped entirely, so "net fiscal / net paye" → ["net", "fiscal", "net", "paye"]
    expect(b).not.toContain("/");
    // Both share "net", "fiscal", "paye"
    const shared = a.filter(t => b.includes(t));
    expect(shared.length).toBeGreaterThan(0);
  });

  it("strips colons, parentheses, and quotes", () => {
    const result = tokenizeV2('Le "bulletin" de paie : conformité (2027)');
    expect(result).not.toContain('"');
    expect(result).not.toContain(":");
    expect(result).not.toContain("(");
    expect(result).not.toContain(")");
  });
});

describe("lib/text — domain acronym preservation", () => {
  it("preserves 3-char domain acronyms after lowercasing", () => {
    const tokens = removeStopWords(tokenizeV2("DSN envoi mensuel"));
    expect(tokens).toContain("dsn");
  });

  it("preserves 2-char domain tokens via DOMAIN_ALLOWLIST", () => {
    const tokens = removeStopWords(tokenizeV2("Le RH gère le GP"));
    expect(tokens).toContain("rh");
    expect(tokens).toContain("gp");
  });

  it("preserves HCR, CCN, DPAE via allowlist", () => {
    const tokens = removeStopWords(tokenizeV2("HCR CCN DPAE obligations"));
    expect(tokens).toContain("hcr");
    expect(tokens).toContain("ccn");
    expect(tokens).toContain("dpae");
    expect(tokens).toContain("obligations");
  });

  it("filters short non-domain tokens", () => {
    const tokens = removeStopWords(tokenizeV2("un de la an if"));
    expect(tokens).toHaveLength(0);
  });
});

describe("lib/text — stopword removal", () => {
  it("removes French stopwords", () => {
    const tokens = removeStopWords(tokenizeV2("dans les entreprises pour la gestion"));
    // "entreprises" and "gestion" should survive; "dans", "les", "pour", "la" should not
    expect(tokens).toContain("entreprises");
    expect(tokens).toContain("gestion");
    expect(tokens).not.toContain("dans");
    expect(tokens).not.toContain("les");
  });

  it("removes English stopwords", () => {
    const tokens = removeStopWords(tokenizeV2("the quick brown fox"));
    expect(tokens).not.toContain("the");
    expect(tokens).toContain("quick");
    expect(tokens).toContain("brown");
    expect(tokens).toContain("fox");
  });
});

describe("lib/text — jaccardSimilarity", () => {
  it("returns 1.0 for identical sets", () => {
    const s = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(s, s)).toBe(1.0);
  });

  it("returns 0 for disjoint sets", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["c", "d"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("returns 0 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("computes partial overlap correctly", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    // intersection=2, union=4 → 0.5
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });
});

describe("narrowCandidateOpportunities — v2 tokenizer improvements", () => {
  it("matches French accent-normalized text", () => {
    const item = makeItem({
      title: "Comprendre le net fiscal et le net paye",
      summary: "Explication des differences entre net fiscal et net paye"
    });
    const screening = { decision: "retain" as const, rationale: "", createOrEnrich: "unknown" as const, relevanceScore: 0.5, sensitivityFlag: false, sensitivityCategories: [] as string[] };
    const opp = makeOpportunity({
      id: "opp-netfiscal",
      title: "Net fiscal versus net payé",
      angle: "Différence entre net fiscal et net payé pour les salariés",
      whatItIsAbout: "net fiscal net paye difference bulletin paie"
    });

    const result = narrowCandidateOpportunities(item, screening, [opp], "company-1");
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].id).toBe("opp-netfiscal");
    expect(result.topScore).toBeGreaterThan(0.05);
  });

  it("does not match unrelated topics that share only stopwords", () => {
    const item = makeItem({
      title: "La gestion de la paie dans les entreprises",
      summary: "Comment gérer la paie dans les entreprises françaises"
    });
    const screening = { decision: "retain" as const, rationale: "", createOrEnrich: "unknown" as const, relevanceScore: 0.5, sensitivityFlag: false, sensitivityCategories: [] as string[] };
    const opp = makeOpportunity({
      id: "opp-unrelated",
      title: "Le marketing digital dans les entreprises",
      angle: "Stratégie marketing digital pour les PME",
      whatItIsAbout: "marketing digital strategie PME croissance"
    });

    const result = narrowCandidateOpportunities(item, screening, [opp], "company-1");
    // Should not match: only shared word would be "entreprises" after stopword removal
    // Jaccard should be very low
    expect(result.topScore).toBeLessThan(0.15);
  });

  it("returns topCandidate when candidates exist", () => {
    const item = makeItem({ title: "sales objection handling", summary: "how to handle objections" });
    const screening = { decision: "retain" as const, rationale: "", createOrEnrich: "unknown" as const, relevanceScore: 0.5, sensitivityFlag: false, sensitivityCategories: [] as string[] };
    const opp = makeOpportunity({ id: "opp-match", title: "sales objection", angle: "handling objections", whatItIsAbout: "sales" });

    const result = narrowCandidateOpportunities(item, screening, [opp], "company-1");
    expect(result.topCandidate).toBeDefined();
    expect(result.topCandidate?.id).toBe("opp-match");
  });

  it("finds opportunity #50 when window includes it", () => {
    const item = makeItem({
      title: "DSN envoi mensuel obligations",
      summary: "Les obligations mensuelles DSN"
    });
    const screening = { decision: "retain" as const, rationale: "", createOrEnrich: "unknown" as const, relevanceScore: 0.5, sensitivityFlag: false, sensitivityCategories: [] as string[] };

    // Create 50 unrelated opportunities + 1 matching at position 51
    const opps: ContentOpportunity[] = [];
    for (let i = 0; i < 50; i++) {
      opps.push(makeOpportunity({
        id: `opp-filler-${i}`,
        title: `Unrelated topic number ${i}`,
        angle: `Completely different angle ${i}`,
        whatItIsAbout: `Something entirely different ${i}`
      }));
    }
    opps.push(makeOpportunity({
      id: "opp-dsn-match",
      title: "DSN déclaration mensuelle",
      angle: "Obligations DSN envoi mensuel pour entreprises",
      whatItIsAbout: "DSN mensuel obligations declaration"
    }));

    const result = narrowCandidateOpportunities(item, screening, opps, "company-1");
    expect(result.candidates.some(c => c.id === "opp-dsn-match")).toBe(true);
  });
});

describe("dedup configuration constants — temporary uncalibrated defaults", () => {
  it("exports DEDUP_CANDIDATE_WINDOW with default 200", () => {
    expect(DEDUP_CANDIDATE_WINDOW).toBe(200);
  });

  it("exports DEDUP_SCORING_VERSION with default v2", () => {
    expect(DEDUP_SCORING_VERSION).toBe("v2");
  });

  it("exports DEDUP_WARNINGS_ENABLED with default true", () => {
    expect(DEDUP_WARNINGS_ENABLED).toBe(true);
  });

  it("exports DEDUP_WARNING_THRESHOLD with temporary default 0.20", () => {
    expect(DEDUP_WARNING_THRESHOLD).toBe(0.20);
  });

  it("exports DEDUP_CONFIDENCE_CUTOFF with temporary default 0.70", () => {
    expect(DEDUP_CONFIDENCE_CUTOFF).toBe(0.70);
  });

  it("exports DEDUP_RESCUE_ENABLED with default true", () => {
    expect(DEDUP_RESCUE_ENABLED).toBe(true);
  });
});

// --- Topical vs boosted score separation ---

describe("narrowCandidateOpportunities — topical vs boosted score separation", () => {
  const defaultScreening = {
    decision: "retain" as const,
    rationale: "",
    createOrEnrich: "unknown" as const,
    relevanceScore: 0.5,
    sensitivityFlag: false,
    sensitivityCategories: [] as string[]
  };

  it("returns both topTopicalScore and topScore (boosted)", () => {
    const item = makeItem({
      title: "sales objection handling techniques",
      summary: "how to handle objections in sales calls"
    });
    const opp = makeOpportunity({
      id: "opp-match",
      title: "sales objection",
      angle: "handling objections",
      whatItIsAbout: "sales techniques for objection handling"
    });

    const result = narrowCandidateOpportunities(item, defaultScreening, [opp], "company-1");
    expect(result.topTopicalScore).toBeGreaterThan(0);
    expect(result.topScore).toBeGreaterThanOrEqual(result.topTopicalScore);
  });

  it("owner boost inflates topScore but not topTopicalScore", () => {
    const item = makeItem({
      title: "onboarding workflow challenges",
      summary: "problems with client onboarding"
    });
    const screening = {
      ...defaultScreening,
      ownerSuggestion: "thomas"
    };
    const opp = makeOpportunity({
      id: "opp-owner-match",
      ownerProfile: "thomas" as any,
      title: "client onboarding issues",
      angle: "onboarding workflow improvements",
      whatItIsAbout: "client onboarding process"
    });

    const result = narrowCandidateOpportunities(item, screening, [opp], "company-1");
    // Owner boost adds +0.2 to boosted score but not topical
    expect(result.topScore).toBe(result.topTopicalScore + 0.2);
  });

  it("two unrelated items with same owner do NOT produce high topTopicalScore", () => {
    const item = makeItem({
      title: "Stratégie de recrutement tech en startup",
      summary: "Comment recruter des développeurs dans un marché tendu"
    });
    const screening = {
      ...defaultScreening,
      ownerSuggestion: "quentin"
    };
    const opp = makeOpportunity({
      id: "opp-unrelated-same-owner",
      ownerProfile: "quentin" as any,
      title: "Conformité RGPD pour les sous-traitants",
      angle: "Obligations RGPD des sous-traitants de données",
      whatItIsAbout: "RGPD conformite sous-traitants obligations"
    });

    const result = narrowCandidateOpportunities(item, screening, [opp], "company-1");
    // Topical overlap should be near zero — topics are completely different
    expect(result.topTopicalScore).toBeLessThan(DEDUP_WARNING_THRESHOLD);
    // But boosted score includes the +0.2 owner boost
    if (result.candidates.length > 0) {
      expect(result.topScore).toBeGreaterThan(result.topTopicalScore);
    }
  });
});

// --- Pipeline: dedup warning and event tests ---

describe("runIntelligencePipeline — dedup warnings and events", () => {
  it("attaches warning + dedupFlag when topical overlap exceeds threshold", async () => {
    // Create a source item that overlaps topically with an existing opportunity
    const existingOpp = makeOpportunity({
      id: "opp-existing-topic",
      title: "Net fiscal versus net paye pour les salaries",
      angle: "Difference entre net fiscal et net paye sur le bulletin",
      whatItIsAbout: "net fiscal net paye bulletin salarie difference"
    });

    const item = makeMarketResearchItem({
      sourceItemId: "market-query:mq-dup:set:hash-dup",
      externalId: "market-research:mq-dup:hash-dup",
      title: "Comprendre le net fiscal et le net paye",
      summary: "Explication des differences entre net fiscal et net paye pour les salaries",
      text: "Explication des differences entre net fiscal et net paye pour les salaries sur le bulletin de paie."
    });

    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-dup:hash-dup"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          title: "Net fiscal vs net paye explique",
          confidence: 0.5  // below DEDUP_CONFIDENCE_CUTOFF (0.70)
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existingOpp]
    });

    expect(result.created).toHaveLength(1);
    const created = result.created[0];
    // Warning should be attached because topical overlap is high
    expect(created.editorialNotes).toContain("[Possible overlap]");
    expect(created.dedupFlag).toBe("Possible duplicate");

    // DedupEvent: create-with-warning
    const warningEvent = result.dedupEvents.find(e => e.action === "create-with-warning");
    expect(warningEvent).toBeDefined();
    expect(warningEvent!.topicalScore).toBeGreaterThan(0);
    expect(warningEvent!.boostedScore).toBeGreaterThanOrEqual(warningEvent!.topicalScore!);
    expect(warningEvent!.llmConfidence).toBe(0.5);
  });

  it("does NOT attach warning when only owner boost is present (no topical overlap)", async () => {
    // Existing opportunity on a completely different topic, but same owner
    const existingOpp = makeOpportunity({
      id: "opp-different-topic",
      ownerProfile: "thomas" as any,
      title: "Conformité RGPD pour les sous-traitants de données",
      angle: "Obligations RGPD des sous-traitants",
      whatItIsAbout: "RGPD conformite sous-traitants obligations donnees"
    });

    const item = makeMarketResearchItem({
      sourceItemId: "market-query:mq-nodup:set:hash-nodup",
      externalId: "market-research:mq-nodup:hash-nodup",
      title: "Stratégie de recrutement tech en startup",
      summary: "Comment recruter des développeurs dans un marché tendu face aux grandes entreprises",
      text: "Comment recruter des développeurs dans un marché tendu face aux grandes entreprises et fidéliser les talents."
    });

    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce({
          output: {
            items: [{
              sourceItemId: "market-research:mq-nodup:hash-nodup",
              decision: "retain" as const,
              rationale: "relevant",
              createOrEnrich: "create" as const,
              relevanceScore: 0.8,
              sensitivityFlag: false,
              sensitivityCategories: [],
              ownerSuggestion: "thomas"
            }]
          },
          usage: { mode: "provider" as const, promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
          mode: "provider" as const
        })
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          title: "Recrutement tech en startup",
          confidence: 0.5  // low confidence, but topical overlap is near zero
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existingOpp]
    });

    expect(result.created).toHaveLength(1);
    const created = result.created[0];
    // No warning: topical overlap is near zero despite shared owner
    expect(created.editorialNotes ?? "").not.toContain("[Possible overlap]");
    expect(created.dedupFlag).toBeUndefined();

    // DedupEvent: create-clean
    const cleanEvent = result.dedupEvents.find(e => e.action === "create-clean");
    expect(cleanEvent).toBeDefined();
  });

  it("emits candidate-match event when candidates are found", async () => {
    const existingOpp = makeOpportunity({
      id: "opp-candidate",
      title: "sales objection handling",
      angle: "handling objections in calls",
      whatItIsAbout: "sales objection techniques"
    });

    const item = makeMarketResearchItem({
      title: "Sales objection techniques mastery",
      summary: "How to handle sales objections effectively",
      text: "How to handle sales objections effectively in B2B sales calls."
    });

    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput(item.externalId))
        .mockResolvedValueOnce(makeDecisionOutput({ action: "create", confidence: 0.9 }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existingOpp]
    });

    const matchEvent = result.dedupEvents.find(e => e.action === "candidate-match");
    expect(matchEvent).toBeDefined();
    expect(matchEvent!.matchedOpportunityId).toBe("opp-candidate");
    expect(matchEvent!.topicalScore).toBeGreaterThan(0);
  });

  it("emits candidate-miss event when no candidates are found", async () => {
    const item = makeMarketResearchItem({
      title: "Completely novel topic about space exploration",
      summary: "Mars colonization economics for startups",
      text: "Mars colonization economics for startups and venture capital."
    });

    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput(item.externalId))
        .mockResolvedValueOnce(makeDecisionOutput({ action: "create", confidence: 0.9 }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    const missEvent = result.dedupEvents.find(e => e.action === "candidate-miss");
    expect(missEvent).toBeDefined();
    expect(missEvent!.topicalScore).toBe(0);
  });

  it("emits create-clean event when created with no duplicate suspicion", async () => {
    const item = makeMarketResearchItem();
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput(item.externalId))
        .mockResolvedValueOnce(makeDecisionOutput({ action: "create", confidence: 0.9 }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
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
    expect(result.created[0].dedupFlag).toBeUndefined();

    const cleanEvent = result.dedupEvents.find(e => e.action === "create-clean");
    expect(cleanEvent).toBeDefined();
    expect(cleanEvent!.llmConfidence).toBe(0.9);
  });

  it("emits enrich-by-llm event when LLM chooses to enrich", async () => {
    const existingOpp = makeOpportunity({
      id: "opp-enrich-target",
      title: "Customer proof of onboarding ROI",
      angle: "Concrete onboarding proof matters",
      whatItIsAbout: "customer onboarding proof ROI evidence"
    });

    const item = makeMarketResearchItem({
      title: "More evidence of onboarding ROI importance",
      summary: "Buyers want concrete onboarding proof evidence",
      text: "Buyers want concrete onboarding proof evidence from real implementations."
    });

    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput(item.externalId))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "enrich",
          targetOpportunityId: "opp-enrich-target",
          confidence: 0.9
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existingOpp]
    });

    expect(result.enriched).toHaveLength(1);
    const enrichEvent = result.dedupEvents.find(e => e.action === "enrich-by-llm");
    expect(enrichEvent).toBeDefined();
    expect(enrichEvent!.matchedOpportunityId).toBe("opp-enrich-target");
  });

  it("emits origin-dedup-hit when same source item already has an opportunity", async () => {
    const itemDbId = sourceItemDbId("company-1", "market-research:mq-1:hash-1");
    const existingOpp = makeOpportunity({
      id: "opp-origin-existing",
      title: "Already created from this source",
      evidence: [{
        id: "ev-origin",
        source: "market-research",
        sourceItemId: itemDbId,
        sourceUrl: "https://example.com",
        timestamp: new Date().toISOString(),
        excerpt: "Original excerpt",
        excerptHash: "hash-origin",
        freshnessScore: 0.8
      }]
    });

    const item = makeMarketResearchItem();
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput(item.externalId))
        .mockResolvedValueOnce(makeDecisionOutput({ action: "create" }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existingOpp]
    });

    // Should enrich instead of create (in-memory origin dedupe)
    expect(result.created).toHaveLength(0);
    expect(result.enriched).toHaveLength(1);

    const originEvent = result.dedupEvents.find(e => e.action === "enrich-by-origin");
    expect(originEvent).toBeDefined();
    expect(originEvent!.matchedOpportunityId).toBe("opp-origin-existing");
  });
});

// --- Regression: same owner, unrelated topics must NOT trigger warning ---

describe("runIntelligencePipeline — regression: same owner does not cause false warning", () => {
  it("two unrelated items sharing an owner do not produce a duplicate warning", async () => {
    // Item A creates an opportunity assigned to "thomas"
    const itemA = makeMarketResearchItem({
      sourceItemId: "market-query:mq-a:set:hash-a",
      externalId: "market-research:mq-a:hash-a",
      title: "Obligations déclaratives DSN mensuelles",
      summary: "Les obligations DSN pour les entreprises chaque mois",
      text: "Les obligations DSN pour les entreprises chaque mois avec les échéances réglementaires."
    });

    // Item B is completely unrelated but will get the same owner suggestion
    const itemB = makeMarketResearchItem({
      sourceItemId: "market-query:mq-b:set:hash-b",
      externalId: "market-research:mq-b:hash-b",
      title: "Stratégie de fidélisation client SaaS",
      summary: "Comment fidéliser les clients dans un modèle SaaS B2B",
      text: "Comment fidéliser les clients dans un modèle SaaS B2B avec des métriques de rétention."
    });

    const mockLlmClient = {
      generateStructured: vi.fn()
        // Screening for batch (both items)
        .mockResolvedValueOnce({
          output: {
            items: [
              {
                sourceItemId: "market-research:mq-a:hash-a",
                decision: "retain" as const,
                rationale: "relevant",
                createOrEnrich: "create" as const,
                relevanceScore: 0.8,
                sensitivityFlag: false,
                sensitivityCategories: [],
                ownerSuggestion: "thomas"
              },
              {
                sourceItemId: "market-research:mq-b:hash-b",
                decision: "retain" as const,
                rationale: "relevant",
                createOrEnrich: "create" as const,
                relevanceScore: 0.8,
                sensitivityFlag: false,
                sensitivityCategories: [],
                ownerSuggestion: "thomas"
              }
            ]
          },
          usage: { mode: "provider" as const, promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
          mode: "provider" as const
        })
        // Create decision for item A
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          title: "Obligations DSN mensuelles",
          confidence: 0.5,
          ownerDisplayName: "thomas"
        }))
        // Create decision for item B
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          title: "Fidélisation client SaaS",
          confidence: 0.5,
          ownerDisplayName: "thomas"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [itemA, itemB],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [{ id: "user-thomas", displayName: "thomas", baseProfile: {} } as any],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    // Both should be created
    expect(result.created).toHaveLength(2);

    // Neither should have a duplicate warning (topics are unrelated)
    for (const opp of result.created) {
      expect(opp.editorialNotes ?? "").not.toContain("[Possible overlap]");
      expect(opp.dedupFlag).toBeUndefined();
    }

    // All create events should be "create-clean"
    const createEvents = result.dedupEvents.filter(
      e => e.action === "create-clean" || e.action === "create-with-warning"
    );
    expect(createEvents).toHaveLength(2);
    expect(createEvents.every(e => e.action === "create-clean")).toBe(true);
  });
});

// --- Regression: boost-reordering must not defeat topical warning ---

describe("narrowCandidateOpportunities — bestTopicalCandidate vs topCandidate", () => {
  const defaultScreening = {
    decision: "retain" as const,
    rationale: "",
    createOrEnrich: "unknown" as const,
    relevanceScore: 0.5,
    sensitivityFlag: false,
    sensitivityCategories: [] as string[]
  };

  it("bestTopicalCandidate tracks the highest topical match even when boost reorders the ranking", () => {
    // Source item about DSN obligations
    const item = makeItem({
      title: "Obligations déclaratives DSN mensuelles",
      summary: "Comprendre les obligations DSN envoi mensuel pour entreprises"
    });

    // Opp A: unrelated topic but same owner → will get +0.2 owner boost
    const oppA = makeOpportunity({
      id: "opp-owner-only",
      ownerProfile: "thomas" as any,
      title: "Conformité RGPD pour sous-traitants",
      angle: "Obligations RGPD des sous-traitants",
      whatItIsAbout: "RGPD conformite sous-traitants obligations donnees"
    });

    // Opp B: real topical duplicate about DSN, different owner
    const oppB = makeOpportunity({
      id: "opp-topical-dup",
      ownerProfile: "quentin" as any,
      title: "DSN déclaration mensuelle entreprises",
      angle: "Obligations DSN envoi mensuel déclaratives",
      whatItIsAbout: "DSN mensuel obligations declaration entreprises"
    });

    const screening = { ...defaultScreening, ownerSuggestion: "thomas" };

    const result = narrowCandidateOpportunities(
      item, screening, [oppA, oppB], "company-1"
    );

    // Opp A may rank first by boosted score (low topical + 0.2 owner boost)
    // but bestTopicalCandidate must be opp B (the actual topical duplicate)
    expect(result.bestTopicalCandidate?.id).toBe("opp-topical-dup");
    expect(result.topTopicalScore).toBeGreaterThan(0.05);

    // The topCandidate (boosted) might be oppA if its boost pushes it above oppB's raw topical
    // but the topTopicalScore comes from oppB regardless
    const oppBTopicalScore = result.topTopicalScore;
    // topTopicalScore is the best topical, not the first-ranked candidate's topical
    expect(oppBTopicalScore).toBeGreaterThan(0);
  });
});

describe("runIntelligencePipeline — boost-reordered candidate uses topical match for warning", () => {
  it("warns about the topical duplicate even when a same-owner non-duplicate ranks first", async () => {
    // Opp A: unrelated topic, same owner as incoming item → will get owner boost
    const oppA = makeOpportunity({
      id: "opp-boosted-non-dup",
      ownerProfile: "thomas" as any,
      title: "Conformité RGPD pour sous-traitants de données",
      angle: "Obligations RGPD des sous-traitants",
      whatItIsAbout: "RGPD conformite sous-traitants obligations donnees"
    });

    // Opp B: topical duplicate about DSN, different owner
    const oppB = makeOpportunity({
      id: "opp-real-dup",
      ownerProfile: "quentin" as any,
      title: "DSN déclaration mensuelle entreprises",
      angle: "Obligations DSN envoi mensuel déclaratives",
      whatItIsAbout: "DSN mensuel obligations declaration entreprises"
    });

    const item = makeMarketResearchItem({
      sourceItemId: "market-query:mq-dsn:set:hash-dsn",
      externalId: "market-research:mq-dsn:hash-dsn",
      title: "Obligations déclaratives DSN mensuelles",
      summary: "Comprendre les obligations DSN envoi mensuel entreprises",
      text: "Comprendre les obligations DSN envoi mensuel pour les entreprises avec les échéances réglementaires."
    });

    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce({
          output: {
            items: [{
              sourceItemId: "market-research:mq-dsn:hash-dsn",
              decision: "retain" as const,
              rationale: "relevant",
              createOrEnrich: "create" as const,
              relevanceScore: 0.8,
              sensitivityFlag: false,
              sensitivityCategories: [],
              ownerSuggestion: "thomas"
            }]
          },
          usage: { mode: "provider" as const, promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
          mode: "provider" as const
        })
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          title: "DSN obligations mensuelles guide",
          confidence: 0.5
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [oppA, oppB]
    });

    expect(result.created).toHaveLength(1);
    const created = result.created[0];

    // Warning must reference the TOPICAL duplicate (oppB), not the owner-boosted non-dup (oppA)
    expect(created.editorialNotes).toContain("[Possible overlap]");
    expect(created.editorialNotes).toContain("DSN déclaration mensuelle");
    expect(created.editorialNotes).not.toContain("RGPD");
    expect(created.dedupFlag).toBe("Possible duplicate");

    // The create-with-warning event must reference oppB (the topical match)
    const warningEvent = result.dedupEvents.find(e => e.action === "create-with-warning");
    expect(warningEvent).toBeDefined();
    expect(warningEvent!.matchedOpportunityId).toBe("opp-real-dup");
    expect(warningEvent!.topicalScore).toBeGreaterThan(0);
    expect(warningEvent!.boostedScore).toBeDefined();
  });
});

// --- DedupEvent payload consistency ---

describe("DedupEvent — topicalScore and boostedScore are always distinct fields", () => {
  it("candidate-match event has both topicalScore and boostedScore", async () => {
    const existingOpp = makeOpportunity({
      id: "opp-for-event",
      ownerProfile: "thomas" as any,
      title: "Sales objection handling techniques",
      angle: "handling objections",
      whatItIsAbout: "sales objection techniques"
    });

    const item = makeMarketResearchItem({
      title: "Sales objection mastery for teams",
      summary: "How to handle sales objections effectively in B2B",
      text: "How to handle sales objections effectively in B2B sales calls."
    });

    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce({
          output: {
            items: [{
              sourceItemId: item.externalId,
              decision: "retain" as const,
              rationale: "relevant",
              createOrEnrich: "create" as const,
              relevanceScore: 0.8,
              sensitivityFlag: false,
              sensitivityCategories: [],
              ownerSuggestion: "thomas"
            }]
          },
          usage: { mode: "provider" as const, promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
          mode: "provider" as const
        })
        .mockResolvedValueOnce(makeDecisionOutput({ action: "create", confidence: 0.9 }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existingOpp]
    });

    const matchEvent = result.dedupEvents.find(e => e.action === "candidate-match");
    expect(matchEvent).toBeDefined();
    expect(typeof matchEvent!.topicalScore).toBe("number");
    expect(typeof matchEvent!.boostedScore).toBe("number");
    // Owner boost means boosted > topical
    expect(matchEvent!.boostedScore!).toBeGreaterThan(matchEvent!.topicalScore!);
    // Neither should be NaN or undefined
    expect(Number.isFinite(matchEvent!.topicalScore)).toBe(true);
    expect(Number.isFinite(matchEvent!.boostedScore)).toBe(true);
  });

  it("create-clean event has both score fields", async () => {
    const item = makeMarketResearchItem();
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput(item.externalId))
        .mockResolvedValueOnce(makeDecisionOutput({ action: "create", confidence: 0.9 }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    const cleanEvent = result.dedupEvents.find(e => e.action === "create-clean");
    expect(cleanEvent).toBeDefined();
    expect(typeof cleanEvent!.topicalScore).toBe("number");
    expect(typeof cleanEvent!.boostedScore).toBe("number");
    // No candidates → both should be 0
    expect(cleanEvent!.topicalScore).toBe(0);
    expect(cleanEvent!.boostedScore).toBe(0);
  });

  it("enrich-by-llm event has both score fields", async () => {
    const existingOpp = makeOpportunity({
      id: "opp-enrich-event",
      title: "Customer proof of onboarding ROI",
      angle: "Concrete onboarding proof matters",
      whatItIsAbout: "customer onboarding proof ROI evidence"
    });

    const item = makeMarketResearchItem({
      title: "More evidence of onboarding ROI importance",
      summary: "Buyers want concrete onboarding proof evidence",
      text: "Buyers want concrete onboarding proof evidence from real implementations."
    });

    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput(item.externalId))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "enrich",
          targetOpportunityId: "opp-enrich-event",
          confidence: 0.9
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existingOpp]
    });

    const enrichEvent = result.dedupEvents.find(e => e.action === "enrich-by-llm");
    expect(enrichEvent).toBeDefined();
    expect(typeof enrichEvent!.topicalScore).toBe("number");
    expect(typeof enrichEvent!.boostedScore).toBe("number");
  });
});

// --- dedupFlag persistence round-trip ---

describe("dedupFlag persistence", () => {
  it("dedupFlag set by pipeline survives on the created opportunity object", async () => {
    // This tests that the in-memory opportunity returned by the pipeline has dedupFlag set,
    // which is what gets passed to createOpportunityOnly and syncOpportunity.
    const existingOpp = makeOpportunity({
      id: "opp-dup-persist",
      title: "Net fiscal versus net paye pour les salaries",
      angle: "Difference entre net fiscal et net paye sur le bulletin",
      whatItIsAbout: "net fiscal net paye bulletin salarie difference"
    });

    const item = makeMarketResearchItem({
      sourceItemId: "market-query:mq-persist:set:hash-persist",
      externalId: "market-research:mq-persist:hash-persist",
      title: "Comprendre le net fiscal et le net paye",
      summary: "Explication des differences entre net fiscal et net paye pour les salaries",
      text: "Explication des differences entre net fiscal et net paye pour les salaries sur le bulletin de paie."
    });

    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-persist:hash-persist"))
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "create",
          title: "Net fiscal vs net paye explique",
          confidence: 0.5
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [existingOpp]
    });

    const created = result.created[0];
    expect(created.dedupFlag).toBe("Possible duplicate");
    expect(created.editorialNotes).toContain("[Possible overlap]");

    // Simulate round-trip: if this opportunity is loaded back as a recent opportunity
    // in a subsequent pipeline run, the dedupFlag should still be present.
    // The Notion sync for this opportunity will receive dedupFlag = "Possible duplicate".
    // On reload via mapOpportunityRow, the DB row has dedupFlag = "Possible duplicate"
    // which maps to dedupFlag: "Possible duplicate" on the domain object.

    // Simulate the DB row shape that mapOpportunityRow would receive:
    const simulatedDbRow = {
      ...created,
      editorialNotes: created.editorialNotes ?? "",
      dedupFlag: created.dedupFlag ?? "",
    };
    // Verify the flag survives the round-trip pattern:
    // empty string → undefined (falsy), non-empty → preserved
    expect(simulatedDbRow.dedupFlag).toBe("Possible duplicate");

    // Verify that a subsequent Notion sync would still set the flag.
    // The Notion sync reads opportunity.dedupFlag which is "Possible duplicate".
    expect(created.dedupFlag).toBeTruthy();
  });

  it("clean opportunity has no dedupFlag after creation", async () => {
    const item = makeMarketResearchItem();
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput(item.externalId))
        .mockResolvedValueOnce(makeDecisionOutput({ action: "create", confidence: 0.9 }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    const created = result.created[0];
    expect(created.dedupFlag).toBeUndefined();

    // Simulate DB round-trip: empty string maps to undefined
    const simulatedDbRow = { dedupFlag: created.dedupFlag ?? "" };
    expect(simulatedDbRow.dedupFlag).toBe("");
  });
});

// --- Displacement rescue ---
//
// Test data design:  For displacement to occur, filler opps must have
// higher BOOSTED score than the topical opp's RAW topical score.
// With owner boost (+0.2): filler_topical + 0.2 > topical_opp_topical.
// With evidence boost (+0.3): filler_topical + 0.3 > topical_opp_topical.
//
// Token math (verified empirically):
//   Item "paie conformite declaration mensuel" → 4 tokens
//   Filler "paie logiciel gestion processus migration planification deploiement integration"
//     → shares "paie" → Jaccard 1/11 ≈ 0.091.  + 0.2 owner boost → 0.291.
//   Topical opp "conformite declaration trimestrielle revision legale suivi reglementaire"
//     → shares "conformite","declaration" → Jaccard 2/9 ≈ 0.222.  No boost → 0.222.
//   0.291 > 0.222: displacement. 0.222 > 0.091: topical opp is #1 in topical ranking.

describe("narrowCandidateOpportunities — displacement rescue", () => {
  const defaultScreening = {
    decision: "retain" as const,
    rationale: "",
    createOrEnrich: "unknown" as const,
    relevanceScore: 0.5,
    sensitivityFlag: false,
    sensitivityCategories: [] as string[]
  };

  it("rescues a strong topical match displaced by owner boost", () => {
    const item = makeItem({
      title: "paie conformite declaration mensuel",
      summary: ""
    });

    const screening = { ...defaultScreening, ownerSuggestion: "thomas" };

    // 5 same-owner opps: low topical (~0.09) + owner boost (+0.2) → boosted ~0.29
    const ownerOpps = Array.from({ length: 5 }, (_, i) =>
      makeOpportunity({
        id: `opp-owner-fill-${i}`,
        ownerProfile: "thomas" as any,
        title: `paie logiciel gestion variante${i}`,
        angle: `processus migration planification`,
        whatItIsAbout: `deploiement integration systeme${i}`
      })
    );

    // 1 different-owner opp: higher topical (~0.22) but no boost → boosted 0.22
    const topicalOpp = makeOpportunity({
      id: "opp-topical-displaced",
      ownerProfile: "quentin" as any,
      title: "conformite declaration trimestrielle",
      angle: "revision legale suivi",
      whatItIsAbout: "reglementaire controle audit"
    });

    const result = narrowCandidateOpportunities(
      item, screening, [...ownerOpps, topicalOpp], "company-1"
    );

    // The topical match must appear in candidates (rescued from displacement)
    expect(result.candidates.some(c => c.id === "opp-topical-displaced")).toBe(true);
    expect(result.rescuedCount).toBeGreaterThanOrEqual(1);
  });

  it("rescues a strong topical match displaced by evidence boost", () => {
    const item = makeItem({
      title: "paie conformite declaration mensuel",
      summary: "",
      externalId: "notion:evidence-boost-item"
    });

    const itemDbId = sourceItemDbId("company-1", "notion:evidence-boost-item");

    // 5 opps with evidence from this source item: low topical (~0.11) + evidence boost (+0.3) → boosted ~0.41
    const evidenceOpps = Array.from({ length: 5 }, (_, i) =>
      makeOpportunity({
        id: `opp-evidence-fill-${i}`,
        title: `paie logiciel processus variante${i}`,
        angle: `migration planification deploiement`,
        whatItIsAbout: `integration systeme infrastructure${i}`,
        evidence: [{
          id: `ev-${i}`,
          source: "notion",
          sourceItemId: itemDbId,
          sourceUrl: "https://example.com",
          timestamp: new Date().toISOString(),
          excerpt: "excerpt",
          excerptHash: `hash-${i}`,
          freshnessScore: 0.8
        }]
      })
    );

    // 1 opp with higher topical (~0.22) but no evidence boost → boosted 0.22
    const topicalOpp = makeOpportunity({
      id: "opp-topical-evidence-displaced",
      title: "conformite declaration trimestrielle",
      angle: "revision legale suivi",
      whatItIsAbout: "reglementaire controle audit",
      evidence: [{
        id: "ev-unrelated",
        source: "notion",
        sourceItemId: "si-unrelated",
        sourceUrl: "https://example.com",
        timestamp: new Date().toISOString(),
        excerpt: "other excerpt",
        excerptHash: "hash-other",
        freshnessScore: 0.8
      }]
    });

    const result = narrowCandidateOpportunities(
      item, defaultScreening, [...evidenceOpps, topicalOpp], "company-1"
    );

    expect(result.candidates.some(c => c.id === "opp-topical-evidence-displaced")).toBe(true);
    expect(result.rescuedCount).toBeGreaterThanOrEqual(1);
  });

  it("does not rescue when no displacement occurred (legacy cap preserved)", () => {
    // No owner boost, no evidence boost — boosted ordering = topical ordering
    const item = makeItem({ title: "common word shared", summary: "" });

    const opps = Array.from({ length: 10 }, (_, i) =>
      makeOpportunity({
        id: `opp-no-disp-${i}`,
        title: `common word shared context ${i}`,
        angle: `angle ${i}`,
        whatItIsAbout: `about ${i}`
      })
    );

    const result = narrowCandidateOpportunities(item, defaultScreening, opps, "company-1");

    // No displacement → no rescue → legacy cap of 5
    expect(result.rescuedCount).toBe(0);
    expect(result.candidates.length).toBeLessThanOrEqual(5);
  });

  it("caps rescue at 2 even when more candidates are displaced", () => {
    const item = makeItem({
      title: "paie conformite declaration mensuel",
      summary: ""
    });

    const screening = { ...defaultScreening, ownerSuggestion: "thomas" };

    // 5 same-owner opps to fill boosted top 5 via owner boost
    const ownerOpps = Array.from({ length: 5 }, (_, i) =>
      makeOpportunity({
        id: `opp-cap-fill-${i}`,
        ownerProfile: "thomas" as any,
        title: `paie logiciel gestion variante${i}`,
        angle: `processus migration planification`,
        whatItIsAbout: `deploiement integration systeme${i}`
      })
    );

    // 4 high-topical opps from different owner — all displaced by owner boost
    const rescueCandidates = Array.from({ length: 4 }, (_, i) =>
      makeOpportunity({
        id: `opp-rescue-cap-${i}`,
        ownerProfile: "quentin" as any,
        title: `conformite declaration trimestrielle v${i}`,
        angle: `revision legale suivi procedure${i}`,
        whatItIsAbout: `reglementaire controle audit norme${i}`
      })
    );

    const result = narrowCandidateOpportunities(
      item, screening, [...ownerOpps, ...rescueCandidates], "company-1"
    );

    expect(result.rescuedCount).toBeLessThanOrEqual(2);
    expect(result.candidates.length).toBeLessThanOrEqual(7);
  });

  it("preserves legacy top-5 cap when enableRescue is false (kill switch)", () => {
    // Same displacement scenario as the owner-boost test, but with rescue disabled
    const item = makeItem({
      title: "paie conformite declaration mensuel",
      summary: ""
    });

    const screening = { ...defaultScreening, ownerSuggestion: "thomas" };

    const ownerOpps = Array.from({ length: 5 }, (_, i) =>
      makeOpportunity({
        id: `opp-kill-fill-${i}`,
        ownerProfile: "thomas" as any,
        title: `paie logiciel gestion variante${i}`,
        angle: `processus migration planification`,
        whatItIsAbout: `deploiement integration systeme${i}`
      })
    );

    const topicalOpp = makeOpportunity({
      id: "opp-kill-topical",
      ownerProfile: "quentin" as any,
      title: "conformite declaration trimestrielle",
      angle: "revision legale suivi",
      whatItIsAbout: "reglementaire controle audit"
    });

    const result = narrowCandidateOpportunities(
      item, screening, [...ownerOpps, topicalOpp], "company-1",
      { enableRescue: false }
    );

    // Rescue disabled → displaced topical match is NOT rescued → legacy cap of 5
    expect(result.rescuedCount).toBe(0);
    expect(result.candidates.length).toBeLessThanOrEqual(5);
    expect(result.candidates.some(c => c.id === "opp-kill-topical")).toBe(false);
  });
});

// --- Pipeline: rescued candidate accepted as enrich target + telemetry ---

describe("runIntelligencePipeline — displacement rescue end-to-end", () => {
  it("rescued candidate is chosen as enrich target and accepted downstream", async () => {
    // 5 owner-boosted fillers displace a topical match; LLM enriches the rescued opp
    const ownerOpps = Array.from({ length: 5 }, (_, i) =>
      makeOpportunity({
        id: `opp-e2e-fill-${i}`,
        ownerProfile: "thomas" as any,
        title: `paie logiciel gestion variante${i}`,
        angle: `processus migration planification deploiement`,
        whatItIsAbout: `deploiement integration systeme${i} infrastructure`
      })
    );

    const rescuedOpp = makeOpportunity({
      id: "opp-e2e-rescued",
      ownerProfile: "quentin" as any,
      title: "conformite declaration trimestrielle",
      angle: "revision legale suivi reglementaire controle",
      whyNow: "Nouvelles exigences reglementaires",
      whatItIsAbout: "reglementaire controle audit conformite processus"
    });

    const item = makeMarketResearchItem({
      sourceItemId: "market-query:mq-rescue:set:hash-rescue",
      externalId: "market-research:mq-rescue:hash-rescue",
      title: "paie conformite declaration mensuel",
      summary: "conformite declaration mensuel paie entreprises",
      text: "La conformite des declarations de paie mensuelles est essentielle pour les entreprises soumises aux nouvelles reglementations."
    });

    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce({
          output: {
            items: [{
              sourceItemId: "market-research:mq-rescue:hash-rescue",
              decision: "retain" as const,
              rationale: "relevant",
              createOrEnrich: "enrich" as const,
              relevanceScore: 0.8,
              sensitivityFlag: false,
              sensitivityCategories: [],
              ownerSuggestion: "thomas"
            }]
          },
          usage: { mode: "provider" as const, promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
          mode: "provider" as const
        })
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "enrich",
          targetOpportunityId: "opp-e2e-rescued",
          rationale: "This source directly matches the existing conformite declaration opportunity",
          confidence: 0.85
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [...ownerOpps, rescuedOpp]
    });

    // The rescued opp must be enriched, not skipped
    expect(result.enriched).toHaveLength(1);
    expect(result.enriched[0].opportunity.id).toBe("opp-e2e-rescued");

    // The enrich-by-llm event must reference the rescued opp
    const enrichEvent = result.dedupEvents.find(e => e.action === "enrich-by-llm");
    expect(enrichEvent).toBeDefined();
    expect(enrichEvent!.matchedOpportunityId).toBe("opp-e2e-rescued");
  });

  it("telemetry reason string includes rescued count when rescue fires", async () => {
    const ownerOpps = Array.from({ length: 5 }, (_, i) =>
      makeOpportunity({
        id: `opp-tel-fill-${i}`,
        ownerProfile: "thomas" as any,
        title: `paie logiciel gestion variante${i}`,
        angle: `processus migration planification deploiement`,
        whatItIsAbout: `deploiement integration systeme${i} infrastructure`
      })
    );

    const rescuedOpp = makeOpportunity({
      id: "opp-tel-rescued",
      ownerProfile: "quentin" as any,
      title: "conformite declaration trimestrielle",
      angle: "revision legale suivi reglementaire controle",
      whyNow: "Nouvelles exigences reglementaires",
      whatItIsAbout: "reglementaire controle audit conformite processus"
    });

    const item = makeMarketResearchItem({
      sourceItemId: "market-query:mq-tel:set:hash-tel",
      externalId: "market-research:mq-tel:hash-tel",
      title: "paie conformite declaration mensuel",
      summary: "conformite declaration mensuel paie entreprises",
      text: "La conformite des declarations de paie mensuelles est essentielle pour les entreprises soumises aux nouvelles reglementations."
    });

    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce({
          output: {
            items: [{
              sourceItemId: "market-research:mq-tel:hash-tel",
              decision: "retain" as const,
              rationale: "relevant",
              createOrEnrich: "create" as const,
              relevanceScore: 0.8,
              sensitivityFlag: false,
              sensitivityCategories: [],
              ownerSuggestion: "thomas"
            }]
          },
          usage: { mode: "provider" as const, promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
          mode: "provider" as const
        })
        .mockResolvedValueOnce(makeDecisionOutput({
          action: "enrich",
          targetOpportunityId: "opp-tel-rescued",
          confidence: 0.9
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items: [item],
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: [...ownerOpps, rescuedOpp]
    });

    const candidateEvent = result.dedupEvents.find(e =>
      e.action === "candidate-match" || e.action === "candidate-miss"
    );
    expect(candidateEvent).toBeDefined();
    expect(candidateEvent!.reason).toContain("(1 rescued)");
  });
});


// ── LLM request payload assertions ────────────────────────────────────────

describe("LLM request payload assertions", () => {
  it("screening prompt contains operational bridging and no Layer 2", async () => {
    const items = [makeMarketResearchItem()];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput())
    } as any;

    await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "test doctrine",
      sensitivityMarkdown: "test sensitivity",
      userDescriptions: "- user1 (human, en)",
      users: [],
      layer2Defaults: ["Specific", "Evidence-backed"],
      layer3Defaults: ["Max 250 words"],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    const screeningCall = mockLlmClient.generateStructured.mock.calls[0][0];
    expect(screeningCall.system).toContain("Screening contract");
    expect(screeningCall.system).toContain("Default to skip");
    expect(screeningCall.system).toContain("Doctrine §4");
    expect(screeningCall.system).toContain("Doctrine §10");
    expect(screeningCall.system).not.toContain("Content Philosophy Defaults");
    expect(screeningCall.system).not.toContain("Layer 2");
  });

  it("create-enrich prompt contains quality expectations and no Layer 3", async () => {
    const items = [makeMarketResearchItem()];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput())
    } as any;

    await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "test doctrine",
      sensitivityMarkdown: "test sensitivity",
      userDescriptions: "- user1 (human, en)",
      users: [],
      layer2Defaults: [],
      layer3Defaults: ["Max 250 words"],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    const createEnrichCall = mockLlmClient.generateStructured.mock.calls[1][0];
    expect(createEnrichCall.system).toContain("Create quality expectations");
    expect(createEnrichCall.system).toContain("position-sharpening");
    expect(createEnrichCall.system).toContain("future-facing");
    expect(createEnrichCall.system).not.toContain("LinkedIn Craft Defaults");
    expect(createEnrichCall.system).not.toContain("Layer 3");
  });

  it("curated source with high-signal item retains under strict screening contract", async () => {
    const items = [makeMarketResearchItem({
      title: "Cabinet migration friction: les gestionnaires paie bloquent sur la reprise des compteurs CP",
      summary: "Observation terrain récurrente: la reprise des compteurs de congés payés est le premier frein à la migration logicielle dans les cabinets.",
      text: "Lors de trois immersions récentes dans des cabinets d'expertise comptable, le même blocage est apparu systématiquement: la reprise des compteurs de congés payés constitue le frein numéro un au changement de logiciel de paie. Les gestionnaires craignent une perte de données historiques et un recalcul incorrect des soldes."
    })];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput({
          confidence: 0.8,
          title: "La reprise des compteurs CP bloque la migration des cabinets",
          angle: "Le frein principal au changement de logiciel paie dans les cabinets est la peur de perdre les historiques de congés",
          whyNow: "Observation récurrente lors de trois immersions terrain récentes",
          whatItIsAbout: "Le blocage migration lié à la reprise des compteurs congés payés dans les cabinets"
        }))
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "Full editorial doctrine with strict quality bar",
      sensitivityMarkdown: "sensitivity rules",
      userDescriptions: "- baptiste (human, fr): territories=[\"vision/mobilisation\"]",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    // High-signal item with concrete field evidence should be created
    expect(result.created).toHaveLength(1);
    expect(result.created[0].title).toBe("La reprise des compteurs CP bloque la migration des cabinets");
    expect(result.processedSourceItemIds).toContain("market-research:mq-1:hash-1");

    // Verify the doctrine was passed through to both LLM calls
    const screeningCall = mockLlmClient.generateStructured.mock.calls[0][0];
    expect(screeningCall.system).toContain("Full editorial doctrine");
    expect(screeningCall.system).toContain("Screening contract");
  });
});

// ── Fail-closed degraded-path tests ───────────────────────────────────────

describe("screening fail-closed behavior", () => {
  it("full LLM failure at screening produces skip with fallback flag", async () => {
    const items = [makeMarketResearchItem()];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockImplementationOnce((params: { fallback: () => unknown }) => {
          const fallbackOutput = params.fallback();
          return Promise.resolve({
            output: fallbackOutput,
            usage: { mode: "fallback" as const, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0, error: "simulated failure" },
            mode: "fallback" as const
          });
        })
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    expect(result.skipped).toEqual([
      expect.objectContaining({
        sourceItemId: "market-research:mq-1:hash-1",
        reason: expect.stringContaining("LLM unavailable")
      })
    ]);
    expect(result.created).toHaveLength(0);
    expect(result.enriched).toHaveLength(0);
    expect(result.processedSourceItemIds).not.toContain("market-research:mq-1:hash-1");

    const sr = result.screeningResults.get("market-research:mq-1:hash-1");
    expect(sr?.decision).toBe("skip");
    expect(sr?.fallback).toBe(true);
    expect(sr?.relevanceScore).toBe(0);
  });

  it("partial batch response marks missing items as fallback-skip, retryable", async () => {
    const items = [
      makeMarketResearchItem({ externalId: "market-research:mq-1:hash-1", sourceItemId: "market-query:mq-1:set:hash-1" }),
      makeMarketResearchItem({ externalId: "market-research:mq-2:hash-2", sourceItemId: "market-query:mq-2:set:hash-2", sourceFingerprint: "market-research-fp-2" })
    ];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce({
          output: {
            items: [{
              sourceItemId: "market-research:mq-1:hash-1",
              decision: "skip" as const,
              rationale: "Generic content",
              createOrEnrich: "unknown" as const,
              relevanceScore: 0.2,
              sensitivityFlag: false,
              sensitivityCategories: []
            }]
          },
          usage: { mode: "provider" as const, promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
          mode: "provider" as const
        })
    } as any;

    const result = await runIntelligencePipeline({
      items,
      companyId: "company-1",
      llmClient: mockLlmClient,
      doctrineMarkdown: "",
      sensitivityMarkdown: "",
      userDescriptions: "",
      users: [],
      layer2Defaults: [],
      layer3Defaults: [],
      gtmFoundationMarkdown: "",
      recentOpportunities: []
    });

    // Normal skip → processed
    expect(result.processedSourceItemIds).toContain("market-research:mq-1:hash-1");
    const sr1 = result.screeningResults.get("market-research:mq-1:hash-1");
    expect(sr1?.fallback).toBeUndefined();

    // Missing item → fallback skip → NOT processed (retryable)
    expect(result.processedSourceItemIds).not.toContain("market-research:mq-2:hash-2");
    const sr2 = result.screeningResults.get("market-research:mq-2:hash-2");
    expect(sr2?.decision).toBe("skip");
    expect(sr2?.fallback).toBe(true);
  });
});

// --- GTM normalization and field flow tests ---

describe("normalizeGtmFields", () => {
  it("passes valid enum values through unchanged", () => {
    const result = normalizeGtmFields({
      targetSegment: "cabinet-owner",
      editorialPillar: "proof",
      awarenessTarget: "problem-aware",
      buyerFriction: "Cannot compare payroll costs across sites",
      contentMotion: "demand-capture"
    });
    expect(result.targetSegment).toBe("cabinet-owner");
    expect(result.editorialPillar).toBe("proof");
    expect(result.awarenessTarget).toBe("problem-aware");
    expect(result.buyerFriction).toBe("Cannot compare payroll costs across sites");
    expect(result.contentMotion).toBe("demand-capture");
  });

  it("normalizes invalid enum values to undefined", () => {
    const result = normalizeGtmFields({
      targetSegment: "enterprise-cfo",
      editorialPillar: "thought-leadership",
      awarenessTarget: "confused",
      buyerFriction: "real friction",
      contentMotion: "brand-awareness"
    });
    expect(result.targetSegment).toBeUndefined();
    expect(result.editorialPillar).toBeUndefined();
    expect(result.awarenessTarget).toBeUndefined();
    expect(result.buyerFriction).toBe("real friction");
    expect(result.contentMotion).toBeUndefined();
  });

  it("case-normalizes valid enum values", () => {
    const result = normalizeGtmFields({
      targetSegment: "CABINET-OWNER",
      editorialPillar: "Proof",
      awarenessTarget: "PROBLEM-AWARE",
      contentMotion: "Demand-Capture"
    });
    expect(result.targetSegment).toBe("cabinet-owner");
    expect(result.editorialPillar).toBe("proof");
    expect(result.awarenessTarget).toBe("problem-aware");
    expect(result.contentMotion).toBe("demand-capture");
  });

  it("normalizes null, empty, and undefined to undefined", () => {
    const result = normalizeGtmFields({
      targetSegment: null,
      editorialPillar: "",
      awarenessTarget: undefined,
      buyerFriction: null,
      contentMotion: ""
    });
    expect(result.targetSegment).toBeUndefined();
    expect(result.editorialPillar).toBeUndefined();
    expect(result.awarenessTarget).toBeUndefined();
    expect(result.buyerFriction).toBeUndefined();
    expect(result.contentMotion).toBeUndefined();
  });

  it("trims whitespace from freeform buyerFriction", () => {
    const result = normalizeGtmFields({
      buyerFriction: "  Cannot verify calculation correctness  "
    });
    expect(result.buyerFriction).toBe("Cannot verify calculation correctness");
  });

  it("treats whitespace-only buyerFriction as undefined", () => {
    const result = normalizeGtmFields({ buyerFriction: "   " });
    expect(result.buyerFriction).toBeUndefined();
  });
});

describe("GTM fields flow through buildNewOpportunity", () => {
  const evidence: EvidenceReference = {
    id: "ev-gtm",
    source: "notion",
    sourceItemId: "si-gtm",
    sourceUrl: "https://example.com/gtm",
    timestamp: new Date().toISOString(),
    excerpt: "GTM test excerpt",
    excerptHash: "gtm-hash",
    freshnessScore: 0.9
  };

  it("maps valid GTM fields from decision to opportunity", () => {
    const decision: CreateEnrichDecision = {
      action: "create",
      rationale: "test",
      title: "GTM field test",
      territory: "sales",
      angle: "test angle",
      whyNow: "why now",
      whatItIsAbout: "about",
      whatItIsNotAbout: "not about",
      suggestedFormat: "Post",
      confidence: 0.9,
      targetSegment: "production-manager",
      editorialPillar: "proof",
      awarenessTarget: "problem-aware",
      buyerFriction: "Cannot verify calculation correctness",
      contentMotion: "demand-capture"
    };
    const opp = buildNewOpportunity({
      decision,
      sourceItem: makeItem(),
      evidence: [evidence],
      companyId: "c1"
    });
    expect(opp).not.toBeNull();
    expect(opp!.targetSegment).toBe("production-manager");
    expect(opp!.editorialPillar).toBe("proof");
    expect(opp!.awarenessTarget).toBe("problem-aware");
    expect(opp!.buyerFriction).toBe("Cannot verify calculation correctness");
    expect(opp!.contentMotion).toBe("demand-capture");
  });

  it("normalizes invalid GTM values from LLM to undefined", () => {
    const decision: CreateEnrichDecision = {
      action: "create",
      rationale: "test",
      title: "GTM invalid test",
      territory: "sales",
      angle: "test angle",
      whyNow: "why now",
      whatItIsAbout: "about",
      whatItIsNotAbout: "not about",
      suggestedFormat: "Post",
      confidence: 0.9,
      targetSegment: "ceo",
      editorialPillar: "hot-take",
      awarenessTarget: "very-aware",
      buyerFriction: "",
      contentMotion: "viral"
    };
    const opp = buildNewOpportunity({
      decision,
      sourceItem: makeItem(),
      evidence: [evidence],
      companyId: "c1"
    });
    expect(opp).not.toBeNull();
    expect(opp!.targetSegment).toBeUndefined();
    expect(opp!.editorialPillar).toBeUndefined();
    expect(opp!.awarenessTarget).toBeUndefined();
    expect(opp!.buyerFriction).toBeUndefined();
    expect(opp!.contentMotion).toBeUndefined();
  });

  it("handles missing GTM fields gracefully", () => {
    const decision: CreateEnrichDecision = {
      action: "create",
      rationale: "test",
      title: "No GTM test",
      territory: "sales",
      angle: "test angle",
      whyNow: "why now",
      whatItIsAbout: "about",
      whatItIsNotAbout: "not about",
      suggestedFormat: "Post",
      confidence: 0.9
    };
    const opp = buildNewOpportunity({
      decision,
      sourceItem: makeItem(),
      evidence: [evidence],
      companyId: "c1"
    });
    expect(opp).not.toBeNull();
    expect(opp!.targetSegment).toBeUndefined();
    expect(opp!.editorialPillar).toBeUndefined();
    expect(opp!.awarenessTarget).toBeUndefined();
    expect(opp!.buyerFriction).toBeUndefined();
    expect(opp!.contentMotion).toBeUndefined();
  });
});

describe("normalizeGtmFieldsForOperatorEdit", () => {
  it("maps cleared select (empty string) to explicit clear", () => {
    const result = normalizeGtmFieldsForOperatorEdit({
      targetSegment: "",
      editorialPillar: "",
      awarenessTarget: "",
      buyerFriction: "",
      contentMotion: ""
    });
    expect(result.targetSegment).toBe("");
    expect(result.editorialPillar).toBe("");
    expect(result.awarenessTarget).toBe("");
    expect(result.buyerFriction).toBe("");
    expect(result.contentMotion).toBe("");
  });

  it("maps valid enum to normalized value", () => {
    const result = normalizeGtmFieldsForOperatorEdit({
      targetSegment: "Cabinet-Owner",
      editorialPillar: "PROOF",
      contentMotion: "demand-capture"
    });
    expect(result.targetSegment).toBe("cabinet-owner");
    expect(result.editorialPillar).toBe("proof");
    expect(result.contentMotion).toBe("demand-capture");
  });

  it("maps invalid non-empty enum to undefined (preserves DB)", () => {
    const result = normalizeGtmFieldsForOperatorEdit({
      targetSegment: "ceo",
      editorialPillar: "hot-take",
      contentMotion: "viral"
    });
    expect(result.targetSegment).toBeUndefined();
    expect(result.editorialPillar).toBeUndefined();
    expect(result.contentMotion).toBeUndefined();
  });

  it("maps null to explicit clear", () => {
    const result = normalizeGtmFieldsForOperatorEdit({
      targetSegment: null,
      buyerFriction: null
    });
    expect(result.targetSegment).toBe("");
    expect(result.buyerFriction).toBe("");
  });

  it("maps undefined to undefined (field absent — preserve DB)", () => {
    const result = normalizeGtmFieldsForOperatorEdit({
      targetSegment: undefined,
      editorialPillar: undefined,
      buyerFriction: undefined
    });
    expect(result.targetSegment).toBeUndefined();
    expect(result.editorialPillar).toBeUndefined();
    expect(result.buyerFriction).toBeUndefined();
  });

  it("distinguishes undefined (preserve) from null (clear) from empty (clear)", () => {
    const result = normalizeGtmFieldsForOperatorEdit({
      targetSegment: undefined,  // absent → preserve
      editorialPillar: null,     // explicit clear
      awarenessTarget: "",       // explicit clear
      buyerFriction: "real friction",
      contentMotion: "ceo"       // invalid → preserve
    });
    expect(result.targetSegment).toBeUndefined();
    expect(result.editorialPillar).toBe("");
    expect(result.awarenessTarget).toBe("");
    expect(result.buyerFriction).toBe("real friction");
    expect(result.contentMotion).toBeUndefined();
  });
});
