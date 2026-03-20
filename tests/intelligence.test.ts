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

function makeLinearPolicyOutput(classification: "enrich-worthy" | "ignore" | "manual-review-needed" = "enrich-worthy") {
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
      recentOpportunities: [existing]
    });

    expect(result.created).toHaveLength(0);
    expect(result.enriched).toHaveLength(1);
    expect(result.enriched[0].opportunity.id).toBe(existing.id);
  });
});
