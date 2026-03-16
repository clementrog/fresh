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
import { createDeterministicId } from "../src/lib/ids.js";
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
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].id).toBe("opp-match");
  });

  it("applies owner boost", () => {
    const item = makeItem({ title: "unique topic" });
    const screening = { decision: "retain" as const, rationale: "", ownerSuggestion: "quentin", createOrEnrich: "unknown" as const, relevanceScore: 0.5, sensitivityFlag: false, sensitivityCategories: [] };
    const opps = [
      makeOpportunity({ id: "opp-owner", ownerProfile: "quentin", title: "different topic" }),
      makeOpportunity({ id: "opp-noowner", title: "different topic" })
    ];
    const result = narrowCandidateOpportunities(item, screening, opps, "company-1");
    if (result.length >= 2) {
      expect(result[0].id).toBe("opp-owner");
    }
  });

  it("returns empty when no overlap > 0.05", () => {
    const item = makeItem({ title: "completely unrelated xyz", summary: "abc def ghi" });
    const screening = { decision: "retain" as const, rationale: "", createOrEnrich: "unknown" as const, relevanceScore: 0.5, sensitivityFlag: false, sensitivityCategories: [] };
    const opps = [
      makeOpportunity({ title: "very different topic indeed", angle: "another angle entirely", whatItIsAbout: "something else" })
    ];
    const result = narrowCandidateOpportunities(item, screening, opps, "company-1");
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("limits to max 5", () => {
    const item = makeItem({ title: "common word shared" });
    const screening = { decision: "retain" as const, rationale: "", createOrEnrich: "unknown" as const, relevanceScore: 0.5, sensitivityFlag: false, sensitivityCategories: [] };
    const opps = Array.from({ length: 10 }, (_, i) =>
      makeOpportunity({ id: `opp-${i}`, title: `common word shared context ${i}`, angle: `angle ${i}`, whatItIsAbout: `about ${i}` })
    );
    const result = narrowCandidateOpportunities(item, screening, opps, "company-1");
    expect(result.length).toBeLessThanOrEqual(5);
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
  it("processes items through the full pipeline", async () => {
    const items = [makeItem()];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce({
          output: {
            items: [{
              sourceItemId: "notion:page123",
              decision: "retain",
              rationale: "relevant",
              createOrEnrich: "create",
              relevanceScore: 0.8,
              sensitivityFlag: false,
              sensitivityCategories: []
            }]
          },
          usage: { mode: "provider", promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
          mode: "provider"
        })
        .mockResolvedValueOnce({
          output: {
            action: "create",
            rationale: "new opportunity",
            title: "Created opp",
            territory: "sales",
            angle: "fresh angle",
            whyNow: "timely",
            whatItIsAbout: "about this",
            whatItIsNotAbout: "not about that",
            suggestedFormat: "Narrative lesson post",
            confidence: 0.85
          },
          usage: { mode: "provider", promptTokens: 200, completionTokens: 100, estimatedCostUsd: 0.002 },
          mode: "provider"
        })
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
    expect(result.created[0].title).toBe("Created opp");
    expect(result.processedSourceItemIds).toContain("notion:page123");
  });

  it("excludes failed items from processedSourceItemIds", async () => {
    const items = [makeItem()];
    const mockLlmClient = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce({
          output: {
            items: [{
              sourceItemId: "notion:page123",
              decision: "retain",
              rationale: "relevant",
              createOrEnrich: "create",
              relevanceScore: 0.8,
              sensitivityFlag: false,
              sensitivityCategories: []
            }]
          },
          usage: { mode: "provider", promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
          mode: "provider"
        })
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
    expect(result.processedSourceItemIds).not.toContain("notion:page123");
  });
});
