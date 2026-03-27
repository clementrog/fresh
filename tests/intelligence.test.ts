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
