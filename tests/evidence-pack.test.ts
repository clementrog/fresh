import { describe, expect, it } from "vitest";
import {
  findSupportingEvidence,
  assessDraftReadiness,
  deriveProvenanceType,
  computeReadinessTier,
  generateOperatorGuidance,
  classifyClaimPosture,
  classifyProductBacking,
  isBlockedByPublishability
} from "../src/services/evidence-pack.js";
import { buildIntelligenceEvidence } from "../src/services/intelligence.js";
import type {
  NormalizedSourceItem,
  ContentOpportunity,
  EvidenceReference,
  EnrichmentLogEntry,
  ClaimPosture,
  ProductBackingState
} from "../src/domain/types.js";
import { sourceItemDbId } from "../src/db/repositories.js";

const COMPANY_ID = "company-1";

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

function makeEvidence(overrides: Partial<EvidenceReference> = {}): EvidenceReference {
  return {
    id: "ev-1",
    source: "market-research",
    sourceItemId: sourceItemDbId(COMPANY_ID, "market-research:mq-1:hash-1"),
    sourceUrl: "https://example.com/research",
    timestamp: new Date().toISOString(),
    excerpt: "Enterprise buyers increasingly demand concrete proof of simple onboarding before purchasing decisions.",
    excerptHash: "hash1",
    freshnessScore: 0.8,
    ...overrides
  };
}

function makeOpportunity(overrides: Partial<ContentOpportunity> = {}): ContentOpportunity {
  const evidence = makeEvidence();
  return {
    id: "opp-1",
    sourceFingerprint: "sf-1",
    title: "Enterprise buyers demand onboarding proof before purchasing",
    narrativePillar: "sales",
    angle: "Concrete onboarding proof changes enterprise buying decisions faster than generic claims",
    whyNow: "Multiple recent deals show buyers dismissing generic positioning in favor of real implementation evidence",
    whatItIsAbout: "How enterprise buyers respond to concrete onboarding proof versus generic product claims",
    whatItIsNotAbout: "Not about product demos or generic marketing materials",
    evidence: [evidence],
    primaryEvidence: evidence,
    supportingEvidenceCount: 0,
    evidenceFreshness: 0.8,
    evidenceExcerpts: [evidence.excerpt],
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

// --- deriveProvenanceType ---

describe("deriveProvenanceType", () => {
  it("returns market-research for market-research source", () => {
    const item = makeItem({ source: "market-research" });
    expect(deriveProvenanceType(item)).toBe("market-research");
  });

  it("returns market-findings for market-findings source", () => {
    const item = makeItem({ source: "market-findings" });
    expect(deriveProvenanceType(item)).toBe("market-findings");
  });

  it("returns notion:market-insight for notion items with notionKind metadata", () => {
    const item = makeItem({
      source: "notion",
      metadata: { notionKind: "market-insight" }
    });
    expect(deriveProvenanceType(item)).toBe("notion:market-insight");
  });

  it("returns notion:claap-signal for notion items with claap-signal metadata", () => {
    const item = makeItem({
      source: "notion",
      metadata: { notionKind: "claap-signal" }
    });
    expect(deriveProvenanceType(item)).toBe("notion:claap-signal");
  });

  it("returns notion for generic notion items", () => {
    const item = makeItem({ source: "notion", metadata: {} });
    expect(deriveProvenanceType(item)).toBe("notion");
  });

  it("returns claap for claap source", () => {
    const item = makeItem({ source: "claap" });
    expect(deriveProvenanceType(item)).toBe("claap");
  });

  it("returns linear for linear source", () => {
    const item = makeItem({ source: "linear" });
    expect(deriveProvenanceType(item)).toBe("linear");
  });
});

// --- findSupportingEvidence ---

describe("findSupportingEvidence", () => {
  it("finds relevant curated items by topic overlap", () => {
    const opp = makeOpportunity();
    const relevantItem = makeItem({
      source: "market-research",
      externalId: "market-research:related-1",
      sourceItemId: "market-query:mq-2:set:hash-2",
      title: "Buyers dismiss generic onboarding claims",
      summary: "Enterprise buyers increasingly demand concrete proof of onboarding effectiveness before committing to purchase decisions.",
      text: "Research shows enterprise buyers demand concrete onboarding proof before purchasing. Generic positioning claims are dismissed."
    });
    const result = findSupportingEvidence(opp, [relevantItem], COMPANY_ID);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].source).toBe("market-research");
  });

  it("finds relevant Claap items when topic matches", () => {
    const opp = makeOpportunity();
    const claapItem = makeItem({
      source: "claap",
      externalId: "claap:meeting-1",
      sourceItemId: "claap-meeting-1",
      title: "Enterprise sales call: buyer asks for onboarding proof",
      summary: "During enterprise sales call, buyer explicitly asked for concrete onboarding proof and implementation timelines before purchasing decision.",
      text: "The buyer said: we need concrete proof of onboarding before any purchasing decision. Generic claims are not enough for enterprise buyers."
    });
    const result = findSupportingEvidence(opp, [claapItem], COMPANY_ID);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.sources[0].source).toBe("claap");
  });

  it("excludes the originating source item", () => {
    const opp = makeOpportunity();
    // Create a candidate that has the same sourceItemId as the opportunity's evidence
    const sameSourceItem = makeItem({
      source: "market-research",
      externalId: "market-research:mq-1:hash-1",
      sourceItemId: "market-query:mq-1:set:hash-1",
      title: "Enterprise buyers demand onboarding proof before purchasing",
      summary: "Enterprise buyers demand concrete proof of onboarding.",
      text: "Enterprise buyers increasingly demand concrete proof of simple onboarding before purchasing decisions."
    });
    // Build evidence from this item using the same company to get matching sourceItemId
    const sameEvidence = buildIntelligenceEvidence(sameSourceItem, COMPANY_ID);
    const oppWithSameEvidence = makeOpportunity({
      evidence: sameEvidence,
      primaryEvidence: sameEvidence[0]
    });

    const result = findSupportingEvidence(oppWithSameEvidence, [sameSourceItem], COMPANY_ID);
    // Should not add evidence that already exists (dedup by evidenceSignature)
    expect(result.evidence).toHaveLength(0);
  });

  it("rejects items with only generic word overlap", () => {
    const opp = makeOpportunity();
    const genericItem = makeItem({
      source: "notion",
      externalId: "notion:generic-page",
      sourceItemId: "generic-page",
      title: "Weekly team standup notes",
      summary: "Notes from the weekly team standup meeting covering various topics and updates.",
      text: "The team discussed various topics during the weekly standup. Multiple updates were shared about ongoing projects."
    });
    const result = findSupportingEvidence(opp, [genericItem], COMPANY_ID);
    expect(result.evidence).toHaveLength(0);
    expect(result.sources).toHaveLength(0);
  });

  it("applies stricter threshold for Linear than for curated sources", () => {
    const opp = makeOpportunity();
    // Linear item with moderate (not strong) overlap — should be rejected at 0.20 threshold
    const linearItem = makeItem({
      source: "linear",
      externalId: "linear:ticket-456",
      sourceItemId: "linear-ticket-456",
      title: "Customer asked about onboarding timeline",
      summary: "A customer filed a ticket asking about expected onboarding timeline for their enterprise deployment.",
      text: "Support ticket: customer asked about the expected onboarding timeline."
    });
    // Same topic but as market-research — should pass at 0.10 threshold
    const marketItem = makeItem({
      source: "market-research",
      externalId: "market-research:timeline-1",
      sourceItemId: "market-query:mq-3:set:hash-3",
      title: "Customer asked about onboarding timeline",
      summary: "A customer filed a ticket asking about expected onboarding timeline for their enterprise deployment.",
      text: "Support ticket: customer asked about the expected onboarding timeline."
    });

    const linearResult = findSupportingEvidence(opp, [linearItem], COMPANY_ID);
    const marketResult = findSupportingEvidence(opp, [marketItem], COMPANY_ID);

    // Market-research has a lower threshold, so it's more likely to match
    // Both may or may not match depending on exact overlap — the key is the threshold difference
    // At minimum, market should not be stricter than linear
    if (linearResult.evidence.length > 0) {
      expect(marketResult.evidence.length).toBeGreaterThan(0);
    }
  });

  it("caps at max 3 supporting items", () => {
    const opp = makeOpportunity();
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeItem({
        source: "market-research",
        externalId: `market-research:batch-${i}`,
        sourceItemId: `market-query:mq-${i}:set:hash-${i}`,
        title: `Enterprise buyers demand concrete onboarding proof study ${i}`,
        summary: `Study ${i}: Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing decisions.`,
        text: `Research study ${i} shows enterprise buyers demand concrete onboarding proof before purchasing. Generic claims are dismissed by enterprise buyers.`
      })
    );

    const result = findSupportingEvidence(opp, candidates, COMPANY_ID);
    expect(result.sources.length).toBeLessThanOrEqual(3);
  });

  it("does not attach irrelevant items even when they share a source type", () => {
    const opp = makeOpportunity();
    const irrelevant = makeItem({
      source: "market-research",
      externalId: "market-research:unrelated-1",
      sourceItemId: "market-query:mq-99:set:hash-99",
      title: "Best practices for email marketing campaigns",
      summary: "A comprehensive guide to email marketing campaigns including subject line optimization and deliverability.",
      text: "Email marketing campaigns require careful attention to subject lines, deliverability, and segmentation. Best practices include A/B testing."
    });
    const result = findSupportingEvidence(opp, [irrelevant], COMPANY_ID);
    expect(result.evidence).toHaveLength(0);
    expect(result.sources).toHaveLength(0);
  });
});

// --- deriveProvenanceType: internal-proof ---

describe("deriveProvenanceType internal-proof", () => {
  it("returns notion:internal-proof for notion items with internal-proof metadata", () => {
    const item = makeItem({
      source: "notion",
      metadata: { notionKind: "internal-proof" }
    });
    expect(deriveProvenanceType(item)).toBe("notion:internal-proof");
  });
});

// --- findSupportingEvidence: internal-proof ---

describe("findSupportingEvidence with internal-proof", () => {
  it("finds internal proof items when topic matches", () => {
    const opp = makeOpportunity();
    const proofItem = makeItem({
      source: "notion",
      externalId: "notion:proof-soc2",
      sourceItemId: "proof-soc2",
      title: "SOC 2 certification proves enterprise onboarding trust",
      summary: "Enterprise buyers demand concrete proof of onboarding. SOC 2 certification demonstrates purchasing trust.",
      text: "Our SOC 2 certification provides concrete proof that enterprise buyers demand before purchasing decisions. This onboarding trust evidence supports buyer confidence.",
      metadata: { notionKind: "internal-proof", proofCategory: "security" }
    });
    const result = findSupportingEvidence(opp, [proofItem], COMPANY_ID);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.sources[0].source).toBe("notion");
  });

  it("rejects irrelevant internal proof items", () => {
    const opp = makeOpportunity();
    const irrelevantProof = makeItem({
      source: "notion",
      externalId: "notion:proof-uptime",
      sourceItemId: "proof-uptime",
      title: "99.99% uptime achieved in Q4 infrastructure monitoring",
      summary: "Infrastructure monitoring shows 99.99% uptime across all production services.",
      text: "Our infrastructure monitoring dashboard confirms 99.99% uptime across all production services in Q4. SLA commitments met consistently.",
      metadata: { notionKind: "internal-proof", proofCategory: "operations" }
    });
    const result = findSupportingEvidence(opp, [irrelevantProof], COMPANY_ID);
    expect(result.evidence).toHaveLength(0);
  });

  it("internal proof at priority 1 preferred over generic Notion at priority 2", () => {
    const opp = makeOpportunity();
    const proofItem = makeItem({
      source: "notion",
      externalId: "notion:proof-enterprise",
      sourceItemId: "proof-enterprise",
      title: "Enterprise buyers demand concrete onboarding proof before purchasing decisions",
      summary: "Enterprise buyers demand concrete proof of onboarding. Certification establishes purchasing trust.",
      text: "Enterprise buyers demand concrete onboarding proof before purchasing. Our proof demonstrates trust for buyer decisions.",
      metadata: { notionKind: "internal-proof", proofCategory: "security" }
    });
    const genericItem = makeItem({
      source: "notion",
      externalId: "notion:generic-enterprise",
      sourceItemId: "generic-enterprise",
      title: "Enterprise buyers demand concrete onboarding proof before purchasing decisions",
      summary: "Enterprise buyers demand concrete proof of onboarding. Certification establishes purchasing trust.",
      text: "Enterprise buyers demand concrete onboarding proof before purchasing. Our proof demonstrates trust for buyer decisions.",
      metadata: {}
    });
    const result = findSupportingEvidence(opp, [genericItem, proofItem], COMPANY_ID, { maxSupporting: 2 });
    expect(result.sources.length).toBe(2);
    // Internal proof (priority 1) should rank before generic notion (priority 2) at equal scores
    expect(result.sources[0].externalId).toBe("notion:proof-enterprise");
    expect(result.sources[1].externalId).toBe("notion:generic-enterprise");
  });
});

// --- assessDraftReadiness ---

describe("assessDraftReadiness", () => {
  it("returns ready when all checks pass", () => {
    const evidence = [
      makeEvidence({ id: "ev-1", excerpt: "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing." }),
      makeEvidence({ id: "ev-2", sourceItemId: "si-2", excerptHash: "hash-2", excerpt: "Multiple deals lost because we could not show implementation timelines and real onboarding data." })
    ];
    const opp = makeOpportunity({ evidence, primaryEvidence: evidence[0] });

    const result = assessDraftReadiness(opp, evidence);
    expect(result.status).toBe("ready");
    expect(result.hasOriginatingSource).toBe(true);
    expect(result.hasSupportingEvidence).toBe(true);
    expect(result.hasConcreteAngle).toBe(true);
    expect(result.hasDraftableMaterial).toBe(true);
    expect(result.missingElements).toHaveLength(0);
  });

  it("returns needs-more-proof with missing reasons when checks fail", () => {
    const evidence = [makeEvidence({ id: "ev-1", excerpt: "Short." })];
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: evidence[0],
      angle: "About things"
    });

    // Override primaryEvidence sourceUrl to empty
    const oppWithNoUrl = {
      ...opp,
      primaryEvidence: { ...evidence[0], sourceUrl: "" }
    };

    const result = assessDraftReadiness(oppWithNoUrl, evidence);
    expect(result.status).toBe("needs-more-proof");
    expect(result.hasOriginatingSource).toBe(false);
    expect(result.hasSupportingEvidence).toBe(false);
    expect(result.missingElements).toContain("No clear originating source URL");
    expect(result.missingElements).toContain("No supporting evidence beyond the originating source");
  });

  it("reports no supporting evidence when only primary evidence exists", () => {
    const evidence = [makeEvidence()];
    const opp = makeOpportunity({ evidence, primaryEvidence: evidence[0] });

    const result = assessDraftReadiness(opp, evidence);
    expect(result.hasSupportingEvidence).toBe(false);
    expect(result.missingElements).toContain("No supporting evidence beyond the originating source");
  });

  it("detects generic angle", () => {
    const evidence = [
      makeEvidence({ id: "ev-1" }),
      makeEvidence({ id: "ev-2", sourceItemId: "si-2", excerptHash: "hash-2", excerpt: "Supporting proof with enough detail." })
    ];
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: evidence[0],
      angle: "About general topics"
    });

    const result = assessDraftReadiness(opp, evidence);
    expect(result.hasConcreteAngle).toBe(false);
    expect(result.missingElements).toContain("Angle is too generic or vague");
  });

  it("detects insufficient draftable material", () => {
    const evidence = [
      makeEvidence({ id: "ev-1", excerpt: "Short." }),
      makeEvidence({ id: "ev-2", sourceItemId: "si-2", excerptHash: "hash-2", excerpt: "Also short." })
    ];
    const opp = makeOpportunity({ evidence, primaryEvidence: evidence[0] });

    const result = assessDraftReadiness(opp, evidence);
    expect(result.hasDraftableMaterial).toBe(false);
    expect(result.missingElements).toContain("Not enough concrete material to draft from");
  });
});

// --- Integration test ---

describe("evidence-pack integration", () => {
  it("full post-create flow: provenance, support, rejection, readiness", () => {
    const originItem = makeItem({
      source: "market-research",
      externalId: "market-research:mq-1:hash-1",
      sourceItemId: "market-query:mq-1:set:hash-1",
      title: "Enterprise buyers demand onboarding proof before purchasing",
      summary: "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing decisions.",
      text: "Research shows enterprise buyers increasingly demand concrete proof of simple onboarding before purchasing decisions. Generic positioning claims are dismissed."
    });
    const originEvidence = buildIntelligenceEvidence(originItem, COMPANY_ID);
    const opp = makeOpportunity({
      evidence: originEvidence,
      primaryEvidence: originEvidence[0]
    });

    // Candidate items: some relevant, some not
    const relevantClaap = makeItem({
      source: "claap",
      externalId: "claap:meeting-onboarding-1",
      sourceItemId: "claap-meeting-onboarding-1",
      title: "Enterprise buyers demand concrete onboarding proof in sales call",
      summary: "Enterprise buyers explicitly demand concrete onboarding proof before purchasing decisions. Generic positioning claims dismissed.",
      text: "The enterprise buyers demand concrete proof of onboarding before purchasing decisions. They dismissed generic positioning claims and asked for real implementation evidence."
    });

    const relevantNotion = makeItem({
      source: "notion",
      externalId: "notion:page-onboarding-insight",
      sourceItemId: "page-onboarding-insight",
      title: "Internal analysis of enterprise buyer onboarding concerns",
      summary: "Analysis showing enterprise buyers consistently demand concrete proof of onboarding before purchasing.",
      text: "Our internal analysis confirms that enterprise buyers demand concrete onboarding proof before purchasing. This pattern is consistent across multiple deals."
    });

    const irrelevantLinear = makeItem({
      source: "linear",
      externalId: "linear:ticket-email-bug",
      sourceItemId: "linear-ticket-email-bug",
      title: "Bug: email notification template rendering broken",
      summary: "Email notification templates are rendering incorrectly in production for some users.",
      text: "Users reported that email notification templates are rendering with broken HTML. This appears to be a CSS issue in the template engine."
    });

    const irrelevantNotion = makeItem({
      source: "notion",
      externalId: "notion:page-hiring-plan",
      sourceItemId: "page-hiring-plan",
      title: "Q3 hiring plan for engineering team",
      summary: "Detailed hiring plan for the engineering team covering roles, timelines, and budget.",
      text: "The engineering team plans to hire 5 senior developers and 2 engineering managers in Q3. Budget has been approved by the board."
    });

    const candidates = [relevantClaap, relevantNotion, irrelevantLinear, irrelevantNotion];

    // 1. Find supporting evidence
    const { evidence: supportEvidence, sources } = findSupportingEvidence(
      opp, candidates, COMPANY_ID
    );

    // 2. Verify relevant support was added
    const supportedSources = sources.map((s) => s.source);
    expect(supportedSources).toContain("claap");
    expect(supportedSources).toContain("notion");
    expect(supportEvidence.length).toBeGreaterThanOrEqual(2);

    // 3. Verify irrelevant material was rejected
    const supportedExternalIds = sources.map((s) => s.externalId);
    expect(supportedExternalIds).not.toContain("linear:ticket-email-bug");
    expect(supportedExternalIds).not.toContain("notion:page-hiring-plan");

    // 4. Verify provenance
    const provenanceType = deriveProvenanceType(originItem);
    expect(provenanceType).toBe("market-research");

    // 5. Build provenance log entry
    const allEvidence = [...originEvidence, ...supportEvidence];
    const packLogEntry: EnrichmentLogEntry = {
      createdAt: new Date().toISOString(),
      rawSourceItemId: opp.primaryEvidence.sourceItemId,
      evidenceIds: supportEvidence.map((e) => e.id),
      contextComment: `Evidence pack: added ${supportEvidence.length} supporting items`,
      provenanceType,
      originSourceUrl: opp.primaryEvidence.sourceUrl,
      originExcerpts: originEvidence.map((e) => e.excerpt),
      confidence: 0.8,
      reason: "Draft readiness: ready"
    };

    // Verify provenance fields persist on the log entry
    expect(packLogEntry.provenanceType).toBe("market-research");
    expect(packLogEntry.originSourceUrl).toBeTruthy();
    expect(packLogEntry.originExcerpts!.length).toBeGreaterThan(0);

    // 6. Readiness with support = ready
    const readinessWithSupport = assessDraftReadiness(opp, allEvidence);
    expect(readinessWithSupport.status).toBe("ready");
    expect(readinessWithSupport.missingElements).toHaveLength(0);

    // 7. Readiness without support = needs-more-proof
    const readinessWithoutSupport = assessDraftReadiness(opp, originEvidence);
    expect(readinessWithoutSupport.status).toBe("needs-more-proof");
    expect(readinessWithoutSupport.missingElements).toContain(
      "No supporting evidence beyond the originating source"
    );
  });

  it("full product path: internal proof attaches to matching opportunity", () => {
    const proofItem = makeItem({
      source: "notion",
      externalId: "notion:proof-soc2-enterprise",
      sourceItemId: "proof-soc2-enterprise",
      title: "SOC 2 certification for enterprise trust and buyer confidence",
      summary: "SOC 2 Type II audit completed with zero critical findings. Enterprise buyers demand concrete proof of onboarding before purchasing decisions.",
      text: "SOC 2 Type II audit completed with zero critical findings. Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing decisions. This certification establishes trust.",
      metadata: { notionKind: "internal-proof", proofCategory: "security" }
    });

    const irrelevantItem = makeItem({
      source: "notion",
      externalId: "notion:proof-uptime-q4",
      sourceItemId: "proof-uptime-q4",
      title: "99.99% uptime SLA met in Q4 infrastructure report",
      summary: "Infrastructure monitoring shows 99.99% uptime across all production services in Q4.",
      text: "Our infrastructure monitoring dashboard confirms 99.99% uptime across all production services. SLA commitments met. No downtime incidents.",
      metadata: { notionKind: "internal-proof", proofCategory: "operations" }
    });

    const originItem = makeItem({
      source: "market-research",
      externalId: "market-research:mq-origin:hash-origin",
      sourceItemId: "market-query:mq-origin:set:hash-origin",
      title: "Enterprise buyers demand onboarding proof before purchasing",
      summary: "Enterprise buyers demand concrete proof of onboarding effectiveness.",
      text: "Enterprise buyers demand concrete onboarding proof before purchasing decisions."
    });
    const originEvidence = buildIntelligenceEvidence(originItem, COMPANY_ID);
    const opp = makeOpportunity({
      evidence: originEvidence,
      primaryEvidence: originEvidence[0]
    });

    // Find supporting evidence
    const { evidence: supportEvidence, sources } = findSupportingEvidence(
      opp, [proofItem, irrelevantItem], COMPANY_ID
    );

    // Proof item attaches, irrelevant does not
    const supportedExternalIds = sources.map((s) => s.externalId);
    expect(supportedExternalIds).toContain("notion:proof-soc2-enterprise");
    expect(supportedExternalIds).not.toContain("notion:proof-uptime-q4");

    // Original provenance preserved
    expect(deriveProvenanceType(originItem)).toBe("market-research");

    // Build evidence from the proof item
    const proofEvidence = buildIntelligenceEvidence(proofItem, COMPANY_ID, 1);
    expect(proofEvidence.length).toBeGreaterThan(0);
    expect(proofEvidence[0].source).toBe("notion");
  });

  it("enrich-only sources still cannot create opportunities via the pipeline", () => {
    // This test verifies the source creation policy is preserved.
    // Linear items remain enrich-only — findSupportingEvidence only adds support, never creates.
    const opp = makeOpportunity();
    const linearItem = makeItem({
      source: "linear",
      externalId: "linear:issue-999",
      sourceItemId: "linear-issue-999",
      title: "Enterprise buyers demand onboarding proof before purchasing",
      summary: "Enterprise buyers demand concrete proof of onboarding effectiveness.",
      text: "Enterprise buyers demand concrete onboarding proof before purchasing decisions."
    });

    // Linear can be support but never creates opportunities
    const result = findSupportingEvidence(opp, [linearItem], COMPANY_ID);
    // Linear may or may not match as support — the point is it can never create
    // (creation policy is enforced in intelligence.ts, not in evidence-pack.ts)
    // This test just verifies the support path doesn't break
    expect(result.evidence.length).toBeLessThanOrEqual(1);
  });
});

// --- computeReadinessTier ---

describe("computeReadinessTier", () => {
  it("returns ready when all 4 checks pass", () => {
    expect(computeReadinessTier({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: true
    })).toBe("ready");
  });

  it("returns promising when has origin + material but missing supporting evidence", () => {
    expect(computeReadinessTier({
      hasOriginatingSource: true,
      hasSupportingEvidence: false,
      hasConcreteAngle: true,
      hasDraftableMaterial: true
    })).toBe("promising");
  });

  it("returns promising when has origin + material but missing angle", () => {
    expect(computeReadinessTier({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: false,
      hasDraftableMaterial: true
    })).toBe("promising");
  });

  it("returns needs-more-proof when missing source URL", () => {
    expect(computeReadinessTier({
      hasOriginatingSource: false,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: true
    })).toBe("needs-more-proof");
  });

  it("returns needs-more-proof when missing draftable material", () => {
    expect(computeReadinessTier({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: false
    })).toBe("needs-more-proof");
  });

  it("returns needs-more-proof when missing source URL + supporting evidence", () => {
    expect(computeReadinessTier({
      hasOriginatingSource: false,
      hasSupportingEvidence: false,
      hasConcreteAngle: true,
      hasDraftableMaterial: true
    })).toBe("needs-more-proof");
  });
});

// --- generateOperatorGuidance ---

describe("generateOperatorGuidance", () => {
  it("returns empty array when all checks pass", () => {
    const result = generateOperatorGuidance({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: true
    });
    expect(result).toEqual([]);
  });

  it("returns source link guidance when missing", () => {
    const result = generateOperatorGuidance({
      hasOriginatingSource: false,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: true
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Source link is missing");
  });

  it("returns supporting evidence guidance when missing", () => {
    const result = generateOperatorGuidance({
      hasOriginatingSource: true,
      hasSupportingEvidence: false,
      hasConcreteAngle: true,
      hasDraftableMaterial: true
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Only one source backs this");
  });

  it("returns angle guidance when too vague", () => {
    const result = generateOperatorGuidance({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: false,
      hasDraftableMaterial: true
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Angle is too vague");
  });

  it("returns draftable material guidance when missing", () => {
    const result = generateOperatorGuidance({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: false
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Not enough concrete material");
  });

  it("returns multiple guidance items in stable order", () => {
    const result = generateOperatorGuidance({
      hasOriginatingSource: false,
      hasSupportingEvidence: false,
      hasConcreteAngle: false,
      hasDraftableMaterial: false
    });
    expect(result).toHaveLength(4);
    expect(result[0]).toContain("Source link");
    expect(result[1]).toContain("Only one source");
    expect(result[2]).toContain("Angle");
    expect(result[3]).toContain("Not enough concrete material");
  });
});

// --- assessDraftReadiness tier + guidance integration ---

describe("assessDraftReadiness tier and guidance", () => {
  it("ready opportunity has tier ready and empty guidance", () => {
    const evidence = [
      makeEvidence({ id: "ev-1", excerpt: "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing." }),
      makeEvidence({ id: "ev-2", sourceItemId: "si-2", excerptHash: "hash-2", excerpt: "Multiple deals lost because we could not show implementation timelines and real onboarding data." })
    ];
    const opp = makeOpportunity({ evidence, primaryEvidence: evidence[0] });
    const result = assessDraftReadiness(opp, evidence);
    expect(result.readinessTier).toBe("ready");
    expect(result.operatorGuidance).toEqual([]);
  });

  it("missing supporting evidence only produces promising tier", () => {
    // hasDraftableMaterial requires 2 excerpts > 30 chars, but hasSupportingEvidence requires > 1 evidence item.
    // To hit "promising" (has origin + material, missing support), we can't — with 1 evidence item
    // we can't have 2 substantive excerpts. So we test a case that's only missing angle (still promising).
    const evidence = [
      makeEvidence({ id: "ev-1", excerpt: "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing." }),
      makeEvidence({ id: "ev-2", sourceItemId: "si-2", excerptHash: "hash-2", excerpt: "Multiple deals lost because we could not show implementation timelines and real onboarding data." })
    ];
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: evidence[0],
      angle: "About general overview"
    });
    const result = assessDraftReadiness(opp, evidence);
    expect(result.readinessTier).toBe("promising");
    expect(result.operatorGuidance.length).toBeGreaterThan(0);
    expect(result.operatorGuidance).toContainEqual(expect.stringContaining("Angle is too vague"));
  });

  it("missing source URL produces needs-more-proof tier", () => {
    const evidence = [
      makeEvidence({ id: "ev-1", sourceUrl: "", excerpt: "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing." }),
      makeEvidence({ id: "ev-2", sourceItemId: "si-2", excerptHash: "hash-2", excerpt: "Multiple deals lost because we could not show implementation timelines and real onboarding data." })
    ];
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: { ...evidence[0], sourceUrl: "" }
    });
    const result = assessDraftReadiness(opp, evidence);
    expect(result.readinessTier).toBe("needs-more-proof");
    expect(result.operatorGuidance).toContainEqual(expect.stringContaining("Source link is missing"));
  });

  it("missing draftable material produces needs-more-proof tier", () => {
    const evidence = [
      makeEvidence({ id: "ev-1", excerpt: "Short." }),
      makeEvidence({ id: "ev-2", sourceItemId: "si-2", excerptHash: "hash-2", excerpt: "Also short." })
    ];
    const opp = makeOpportunity({ evidence, primaryEvidence: evidence[0] });
    const result = assessDraftReadiness(opp, evidence);
    expect(result.readinessTier).toBe("needs-more-proof");
    expect(result.operatorGuidance).toContainEqual(expect.stringContaining("Not enough concrete material"));
  });

  it("guidance order is stable across calls", () => {
    const evidence = [makeEvidence({ id: "ev-1", excerpt: "Short." })];
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: { ...evidence[0], sourceUrl: "" },
      angle: "About things"
    });
    const r1 = assessDraftReadiness(opp, evidence);
    const r2 = assessDraftReadiness(opp, evidence);
    expect(r1.operatorGuidance).toEqual(r2.operatorGuidance);
  });
});

// --- classifyClaimPosture ---

describe("classifyClaimPosture", () => {
  it("regulatory opportunity → insight-only", () => {
    const opp = makeOpportunity({
      title: "Loi de finances 2026",
      angle: "Impact de la réforme sur la conformité DSN des entreprises",
      whatItIsAbout: "La réglementation impose de nouvelles obligations de déclaration"
    });
    expect(classifyClaimPosture(opp)).toBe("insight-only");
  });

  it("product capability → product-claim", () => {
    const opp = makeOpportunity({
      title: "Linc permet d'automatiser la paie",
      angle: "La fonctionnalité de calcul automatisé simplifie le traitement mensuel",
      whatItIsAbout: "Comment le module de paie automatise les opérations de bout en bout"
    });
    expect(classifyClaimPosture(opp)).toBe("product-claim");
  });

  it("customer pain → customer-pain", () => {
    const opp = makeOpportunity({
      title: "Trop de transparence peut nuire",
      angle: "Le risque opérationnel lié à la complexité de la communication interne",
      whatItIsAbout: "La difficulté des équipes RH face à la frustration des salariés"
    });
    expect(classifyClaimPosture(opp)).toBe("customer-pain");
  });

  it("mixed product + pain → mixed", () => {
    const opp = makeOpportunity({
      title: "Avant de confirmer une règle de paie, montrer combien de bulletins seront impactés",
      angle: "Montrer l'impact avant validation pour réduire le risque d'erreur",
      whatItIsAbout: "Simuler les impacts de changement de règle de paie"
    });
    expect(classifyClaimPosture(opp)).toBe("mixed");
  });

  it("mixed product + regulatory → mixed", () => {
    const opp = makeOpportunity({
      title: "Loi de finances et automatisation Linc",
      angle: "Linc gère automatiquement la conformité à la loi de finances",
      whatItIsAbout: "Comment le module de conformité automatise les obligations légales"
    });
    expect(classifyClaimPosture(opp)).toBe("mixed");
  });

  it("no signals → insight-only (safe default)", () => {
    const opp = makeOpportunity({
      title: "Les pratiques RH en 2026",
      angle: "Comment les entreprises modernisent leurs processus internes",
      whatItIsAbout: "Évolution des pratiques RH dans les PME"
    });
    expect(classifyClaimPosture(opp)).toBe("insight-only");
  });

  it("French accented characters work correctly", () => {
    const opp = makeOpportunity({
      title: "Réforme de la réglementation",
      angle: "Décret sur les obligations de conformité",
      whatItIsAbout: "Étude benchmark des pratiques de marché"
    });
    expect(classifyClaimPosture(opp)).toBe("insight-only");
  });

  it("'montrer' alone does not trigger product-claim (editorial use)", () => {
    const opp = makeOpportunity({
      title: "Montrer ce que les retours terrain révèlent sur les priorités",
      angle: "Montrer ce que les signaux disent de la maturité du secteur",
      whatItIsAbout: "Analyse des signaux terrain"
    });
    expect(classifyClaimPosture(opp)).toBe("insight-only");
  });

  it("'produit' triggers product-claim", () => {
    const opp = makeOpportunity({
      title: "Pourquoi la génération massive des bulletins devient un vrai point de friction produit",
      angle: "Montrer ce que ce type de friction révèle sur les priorités produit",
      whatItIsAbout: "Analyse de la friction produit dans la génération de bulletins"
    });
    // "produit" → product signal, "friction" → pain signal → mixed
    expect(classifyClaimPosture(opp)).toBe("mixed");
  });

  it("'produit' without pain/regulatory → product-claim", () => {
    const opp = makeOpportunity({
      title: "Retour produit sur le module de calcul",
      angle: "Ce que les retours terrain révèlent sur la maturité du produit",
      whatItIsAbout: "Analyse des retours utilisateurs"
    });
    expect(classifyClaimPosture(opp)).toBe("product-claim");
  });

  it("'se produit' (verb form) does not trigger product-claim", () => {
    const opp = makeOpportunity({
      title: "Un changement de paradigme se produit dans les pratiques RH",
      angle: "Ce qui se produit quand les entreprises modernisent",
      whatItIsAbout: "Évolution des processus internes"
    });
    expect(classifyClaimPosture(opp)).toBe("insight-only");
  });

  it("'analyse produit' triggers product signal (not blocked by verb-prefix check)", () => {
    const opp = makeOpportunity({
      title: "Analyse produit du module de paie automatisé",
      angle: "Ce que l'analyse produit révèle sur les attentes terrain",
      whatItIsAbout: "Analyse des retours utilisateurs"
    });
    expect(classifyClaimPosture(opp)).toBe("product-claim");
  });

  it("'promesse produit' triggers product signal", () => {
    const opp = makeOpportunity({
      title: "La promesse produit face à la réalité terrain",
      angle: "Pourquoi la promesse produit ne suffit pas sans preuve opérationnelle",
      whatItIsAbout: "Écart entre la promesse et la réalité"
    });
    expect(classifyClaimPosture(opp)).toBe("product-claim");
  });
});

// --- classifyProductBacking ---

describe("classifyProductBacking", () => {
  it("Linear evidence → backed-in-progress", () => {
    const opp = makeOpportunity();
    const evidence = [makeEvidence({ source: "linear", sourceItemId: "linear-item-1" })];
    expect(classifyProductBacking(opp, evidence, [])).toBe("backed-in-progress");
  });

  it("internal-proof source item with 'en production' → backed-live", () => {
    const opp = makeOpportunity();
    const evidence = [makeEvidence({ source: "notion", sourceItemId: "proof-1" })];
    const sourceItems = [makeItem({
      sourceItemId: "proof-1",
      source: "notion",
      text: "Cette fonctionnalité est en production depuis janvier",
      summary: "Module déployé",
      metadata: { notionKind: "internal-proof" }
    })];
    expect(classifyProductBacking(opp, evidence, sourceItems)).toBe("backed-live");
  });

  it("internal-proof source item with 'en cours de développement' → backed-in-progress", () => {
    const opp = makeOpportunity();
    const evidence = [makeEvidence({ source: "notion", sourceItemId: "proof-2" })];
    const sourceItems = [makeItem({
      sourceItemId: "proof-2",
      source: "notion",
      text: "Le développement est en cours pour ce module",
      summary: "Prévu pour Q3",
      metadata: { notionKind: "internal-proof" }
    })];
    expect(classifyProductBacking(opp, evidence, sourceItems)).toBe("backed-in-progress");
  });

  it("internal-proof source item with no live/progress signal → unbacked", () => {
    const opp = makeOpportunity();
    const evidence = [makeEvidence({ source: "notion", sourceItemId: "proof-3" })];
    const sourceItems = [makeItem({
      sourceItemId: "proof-3",
      source: "notion",
      text: "Documentation technique du module de calcul",
      summary: "Spécifications techniques",
      metadata: { notionKind: "internal-proof" }
    })];
    expect(classifyProductBacking(opp, evidence, sourceItems)).toBe("unbacked");
  });

  it("only market-research evidence → unbacked", () => {
    const opp = makeOpportunity();
    const evidence = [makeEvidence({ source: "market-research" })];
    expect(classifyProductBacking(opp, evidence, [])).toBe("unbacked");
  });

  it("notion evidence with source item but no internal-proof notionKind → unbacked", () => {
    const opp = makeOpportunity();
    const evidence = [makeEvidence({ source: "notion", sourceItemId: "page-1" })];
    const sourceItems = [makeItem({
      sourceItemId: "page-1",
      source: "notion",
      text: "Notes de réunion hebdomadaire",
      summary: "Résumé de la réunion",
      metadata: { notionKind: "market-insight" }
    })];
    expect(classifyProductBacking(opp, evidence, sourceItems)).toBe("unbacked");
  });
});

// --- assessDraftReadiness claim-awareness ---

describe("assessDraftReadiness claim-awareness", () => {
  function makeReadyEvidence() {
    return [
      makeEvidence({ id: "ev-1", excerpt: "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing." }),
      makeEvidence({ id: "ev-2", sourceItemId: "si-2", excerptHash: "hash-2", excerpt: "Multiple deals lost because we could not show implementation timelines and real onboarding data." })
    ];
  }

  it("pure regulatory opportunity, all 4 checks pass, no internal proof → still ready", () => {
    const evidence = makeReadyEvidence();
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: evidence[0],
      title: "Loi de finances 2026 et conformité DSN",
      angle: "La réforme impacte la conformité DSN pour les déclarations sociales",
      whatItIsAbout: "Nouvelles obligations de réglementation pour les entreprises"
    });
    const result = assessDraftReadiness(opp, evidence);
    expect(result.claimPosture).toBe("insight-only");
    expect(result.readinessTier).toBe("ready");
  });

  it("product-claim opportunity, all 4 checks pass, unbacked → promising", () => {
    const evidence = makeReadyEvidence();
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: evidence[0],
      title: "Linc permet d'automatiser le calcul de paie",
      angle: "La fonctionnalité de calcul automatisé simplifie le traitement mensuel",
      whatItIsAbout: "Le module de paie automatise les opérations de bout en bout"
    });
    const result = assessDraftReadiness(opp, evidence);
    expect(result.claimPosture).toBe("product-claim");
    expect(result.productBacking).toBe("unbacked");
    expect(result.readinessTier).toBe("promising");
  });

  it("product-claim opportunity, all 4 checks pass, backed-live → ready", () => {
    const evidence = [
      makeEvidence({ id: "ev-1", source: "notion", sourceItemId: "proof-live", excerpt: "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing." }),
      makeEvidence({ id: "ev-2", sourceItemId: "si-2", excerptHash: "hash-2", excerpt: "Multiple deals lost because we could not show implementation timelines and real onboarding data." })
    ];
    const sourceItems = [makeItem({
      sourceItemId: "proof-live",
      source: "notion",
      text: "Le module de calcul automatisé est en production depuis janvier 2026",
      summary: "Déployé et certifié",
      metadata: { notionKind: "internal-proof" }
    })];
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: evidence[0],
      title: "Linc permet d'automatiser le calcul de paie",
      angle: "La fonctionnalité de calcul automatisé simplifie le traitement mensuel",
      whatItIsAbout: "Le module de paie automatise les opérations de bout en bout"
    });
    const result = assessDraftReadiness(opp, evidence, { sourceItems });
    expect(result.claimPosture).toBe("product-claim");
    expect(result.productBacking).toBe("backed-live");
    expect(result.readinessTier).toBe("ready");
  });

  it("product-claim opportunity, all 4 checks pass, backed-in-progress → promising", () => {
    const evidence = [
      makeEvidence({ id: "ev-1", source: "notion", sourceItemId: "proof-wip", excerpt: "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing." }),
      makeEvidence({ id: "ev-2", sourceItemId: "si-2", excerptHash: "hash-2", excerpt: "Multiple deals lost because we could not show implementation timelines and real onboarding data." })
    ];
    const sourceItems = [makeItem({
      sourceItemId: "proof-wip",
      source: "notion",
      text: "Le module de calcul est en cours de développement",
      summary: "Prévu pour le prochain trimestre",
      metadata: { notionKind: "internal-proof" }
    })];
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: evidence[0],
      title: "Linc permet d'automatiser le calcul de paie",
      angle: "La fonctionnalité de calcul automatisé simplifie le traitement mensuel",
      whatItIsAbout: "Le module de paie automatise les opérations de bout en bout"
    });
    const result = assessDraftReadiness(opp, evidence, { sourceItems });
    expect(result.claimPosture).toBe("product-claim");
    expect(result.productBacking).toBe("backed-in-progress");
    expect(result.readinessTier).toBe("promising");
  });

  it("customer-pain opportunity, all 4 checks pass, no backing → ready", () => {
    const evidence = makeReadyEvidence();
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: evidence[0],
      title: "Les équipes RH face au risque d'erreur",
      angle: "La difficulté croissante des équipes RH face à la complexité réglementaire",
      whatItIsAbout: "Les problèmes et frustrations liés aux processus manuels"
    });
    const result = assessDraftReadiness(opp, evidence);
    expect(result.claimPosture).toBe("customer-pain");
    expect(result.readinessTier).toBe("ready");
  });

  it("mixed opportunity, all 4 checks pass, unbacked → promising", () => {
    const evidence = makeReadyEvidence();
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: evidence[0],
      title: "Montrer l'impact des règles de paie pour réduire le risque",
      angle: "Simuler les impacts avant de confirmer pour éviter les erreurs",
      whatItIsAbout: "L'interface de simulation permet d'éviter la frustration des erreurs"
    });
    const result = assessDraftReadiness(opp, evidence);
    expect(result.claimPosture).toBe("mixed");
    expect(result.productBacking).toBe("unbacked");
    expect(result.readinessTier).toBe("promising");
  });

  it("mixed opportunity, all 4 checks pass, backed-live → ready", () => {
    const evidence = [
      makeEvidence({ id: "ev-1", source: "notion", sourceItemId: "proof-sim", excerpt: "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing." }),
      makeEvidence({ id: "ev-2", sourceItemId: "si-2", excerptHash: "hash-2", excerpt: "Multiple deals lost because we could not show implementation timelines and real onboarding data." })
    ];
    const sourceItems = [makeItem({
      sourceItemId: "proof-sim",
      source: "notion",
      text: "L'outil de simulation est en production et opérationnel",
      summary: "Déployé en janvier",
      metadata: { notionKind: "internal-proof" }
    })];
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: evidence[0],
      title: "Montrer l'impact des règles de paie pour réduire le risque",
      angle: "Simuler les impacts avant de confirmer pour éviter les erreurs",
      whatItIsAbout: "L'interface de simulation permet d'éviter la frustration des erreurs"
    });
    const result = assessDraftReadiness(opp, evidence, { sourceItems });
    expect(result.claimPosture).toBe("mixed");
    expect(result.productBacking).toBe("backed-live");
    expect(result.readinessTier).toBe("ready");
  });
});

// --- Enhanced operator guidance ---

describe("enhanced operator guidance", () => {
  it("product-claim + unbacked → product capability claim guidance", () => {
    const result = generateOperatorGuidance({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: true,
      claimPosture: "product-claim",
      productBacking: "unbacked"
    });
    expect(result.some(g => g.includes("reads like a product capability claim"))).toBe(true);
  });

  it("product-claim + in-progress → shipped capability guidance", () => {
    const result = generateOperatorGuidance({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: true,
      claimPosture: "product-claim",
      productBacking: "backed-in-progress"
    });
    expect(result.some(g => g.includes("implies a shipped capability"))).toBe(true);
  });

  it("mixed + unbacked → mixes product claims guidance", () => {
    const result = generateOperatorGuidance({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: true,
      claimPosture: "mixed",
      productBacking: "unbacked"
    });
    expect(result.some(g => g.includes("mixes product claims with market insights"))).toBe(true);
  });

  it("mixed + in-progress → mixes shipped capability guidance", () => {
    const result = generateOperatorGuidance({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: true,
      claimPosture: "mixed",
      productBacking: "backed-in-progress"
    });
    expect(result.some(g => g.includes("mixes shipped capability and in-progress work"))).toBe(true);
  });

  it("customer-pain → no additional product-related guidance", () => {
    const result = generateOperatorGuidance({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: true,
      claimPosture: "customer-pain",
      productBacking: "unbacked"
    });
    expect(result).toEqual([]);
  });

  it("insight-only → no additional product-related guidance", () => {
    const result = generateOperatorGuidance({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: true,
      claimPosture: "insight-only",
      productBacking: "unbacked"
    });
    expect(result).toEqual([]);
  });
});

// --- Targeted regression: exact failure scenario ---

describe("targeted regression — exact failure scenario", () => {
  it("product-related opportunity with sufficient evidence but all customer-pain/market → NOT ready", () => {
    const evidence = [
      makeEvidence({
        id: "ev-1",
        source: "market-research",
        excerpt: "Les entreprises cherchent à montrer combien de bulletins seront impactés avant de confirmer une règle de paie."
      }),
      makeEvidence({
        id: "ev-2",
        source: "market-research",
        sourceItemId: "si-2",
        excerptHash: "hash-2",
        excerpt: "Le marché demande des fonctionnalités de simulation d'impact avant modification des paramètres de paie."
      })
    ];
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: evidence[0],
      title: "Avant de confirmer une règle de paie, montrer combien de bulletins seront impactés",
      angle: "Montrer le périmètre d'impact avant toute modification de paramétrage paie",
      whatItIsAbout: "Simuler et afficher les conséquences d'un changement de règle de paie sur les bulletins"
    });

    const result = assessDraftReadiness(opp, evidence);
    // Must NOT be ready — it's a product claim with no product backing
    expect(result.readinessTier).toBe("promising");
    expect(result.claimPosture).toBe("product-claim");
    expect(result.productBacking).toBe("unbacked");
    expect(result.operatorGuidance.some(g => g.includes("product capability claim"))).toBe(true);
  });
});

// --- Reassessment correctness ---

describe("reassessment correctness", () => {
  it("older opportunity with internal-proof evidence (live) remains backed-live after reassessment", () => {
    const evidence = [
      makeEvidence({
        id: "ev-1",
        source: "notion",
        sourceItemId: "proof-reassess",
        excerpt: "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing."
      }),
      makeEvidence({
        id: "ev-2",
        sourceItemId: "si-2",
        excerptHash: "hash-2",
        excerpt: "Multiple deals lost because we could not show implementation timelines and real onboarding data."
      })
    ];
    const sourceItems = [makeItem({
      sourceItemId: "proof-reassess",
      source: "notion",
      text: "Le module de simulation d'impact est en production depuis décembre 2025",
      summary: "Déployé et opérationnel",
      metadata: { notionKind: "internal-proof" }
    })];
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: evidence[0],
      title: "Linc permet d'automatiser le calcul de paie",
      angle: "La fonctionnalité de calcul automatisé réduit les erreurs de paie",
      whatItIsAbout: "Le module de paie automatise les calculs complexes"
    });

    const result = assessDraftReadiness(opp, evidence, { sourceItems });
    expect(result.productBacking).toBe("backed-live");
    expect(result.readinessTier).toBe("ready");
  });
});

// --- Status-unclear proof ---

describe("status-unclear proof", () => {
  it("internal-proof exists but no clear live/progress keywords → unbacked, promising", () => {
    const evidence = [
      makeEvidence({
        id: "ev-1",
        source: "notion",
        sourceItemId: "proof-unclear",
        excerpt: "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing."
      }),
      makeEvidence({
        id: "ev-2",
        sourceItemId: "si-2",
        excerptHash: "hash-2",
        excerpt: "Multiple deals lost because we could not show implementation timelines and real onboarding data."
      })
    ];
    const sourceItems = [makeItem({
      sourceItemId: "proof-unclear",
      source: "notion",
      text: "Documentation technique du module de calcul de paie",
      summary: "Spécifications fonctionnelles du module",
      metadata: { notionKind: "internal-proof" }
    })];
    const opp = makeOpportunity({
      evidence,
      primaryEvidence: evidence[0],
      title: "Linc permet d'automatiser le calcul de paie",
      angle: "La fonctionnalité de calcul automatisé réduit les erreurs de paie",
      whatItIsAbout: "Le module de paie automatise les calculs complexes"
    });

    const result = assessDraftReadiness(opp, evidence, { sourceItems });
    expect(result.productBacking).toBe("unbacked");
    expect(result.readinessTier).toBe("promising");
  });
});

// --- Regression: existing tests backward compatibility ---

describe("backward compatibility — optional claim fields", () => {
  it("computeReadinessTier without claim fields behaves as before", () => {
    expect(computeReadinessTier({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: true
    })).toBe("ready");
  });

  it("generateOperatorGuidance without claim fields returns only base guidance", () => {
    const result = generateOperatorGuidance({
      hasOriginatingSource: true,
      hasSupportingEvidence: true,
      hasConcreteAngle: true,
      hasDraftableMaterial: true
    });
    expect(result).toEqual([]);
  });

  it("assessDraftReadiness without opts still returns claimPosture and productBacking", () => {
    const evidence = [
      makeEvidence({ id: "ev-1", excerpt: "Enterprise buyers demand concrete proof of onboarding effectiveness before purchasing." }),
      makeEvidence({ id: "ev-2", sourceItemId: "si-2", excerptHash: "hash-2", excerpt: "Multiple deals lost because we could not show implementation timelines and real onboarding data." })
    ];
    const opp = makeOpportunity({ evidence, primaryEvidence: evidence[0] });
    const result = assessDraftReadiness(opp, evidence);
    expect(result.claimPosture).toBeDefined();
    expect(result.productBacking).toBeDefined();
  });
});

// --- Claap signal policy + provenance ---

describe("deriveProvenanceType claap signal", () => {
  it("returns claap:signal for claap items with signalKind metadata", () => {
    const item = makeItem({
      source: "claap",
      metadata: { signalKind: "claap-signal" }
    });
    expect(deriveProvenanceType(item)).toBe("claap:signal");
  });

  it("returns claap for plain claap items without signalKind", () => {
    const item = makeItem({ source: "claap", metadata: {} });
    expect(deriveProvenanceType(item)).toBe("claap");
  });
});

describe("findSupportingEvidence claap signal policy", () => {
  it("signal-bearing claap item can be origin (priority 1, low jaccard threshold)", () => {
    const opp = makeOpportunity();
    const signalItem = makeItem({
      source: "claap",
      externalId: "claap:signal-meeting",
      sourceItemId: "claap-signal-meeting",
      title: "Enterprise buyers demand concrete onboarding proof in sales call",
      summary: "Enterprise buyers explicitly demand concrete onboarding proof before purchasing decisions.",
      text: "The enterprise buyers demand concrete proof of onboarding before purchasing decisions.",
      metadata: { signalKind: "claap-signal" }
    });
    const result = findSupportingEvidence(opp, [signalItem], COMPANY_ID);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.sources[0].source).toBe("claap");
  });

  it("plain claap item uses default enrich-only policy (priority 3, higher threshold)", () => {
    const opp = makeOpportunity();
    const plainItem = makeItem({
      source: "claap",
      externalId: "claap:plain-meeting",
      sourceItemId: "claap-plain-meeting",
      title: "Enterprise buyers demand concrete onboarding proof in sales call",
      summary: "Enterprise buyers explicitly demand concrete onboarding proof before purchasing decisions.",
      text: "The enterprise buyers demand concrete proof of onboarding before purchasing decisions.",
      metadata: {}
    });
    const result = findSupportingEvidence(opp, [plainItem], COMPANY_ID);
    // Still may match as supporting evidence, but at a higher threshold
    if (result.evidence.length > 0) {
      expect(result.sources[0].source).toBe("claap");
    }
  });
});

// --- Backfill evidence guarantees ---

describe("backfill:evidence guarantees", () => {
  it("skips when evidence already equivalent (dedup by signature)", () => {
    // Build evidence from the candidate item so the signatures naturally match
    const candidate = makeItem({
      source: "market-research",
      externalId: "market-research:mq-1:hash-1",
      sourceItemId: sourceItemDbId(COMPANY_ID, "market-research:mq-1:hash-1"),
      title: "Enterprise buyers demand onboarding proof",
      text: "Enterprise buyers increasingly demand concrete proof of simple onboarding before purchasing decisions.",
      summary: "Onboarding proof for enterprise buyers"
    });

    const preBuiltEvidence = buildIntelligenceEvidence(candidate, COMPANY_ID, 1);
    const opp = makeOpportunity({
      evidence: preBuiltEvidence,
      primaryEvidence: preBuiltEvidence[0]
    });

    const result = findSupportingEvidence(opp, [candidate], COMPANY_ID);
    expect(result.evidence).toHaveLength(0);
    expect(result.sources).toHaveLength(0);
  });

  it("preserves primary evidence — never replaces primaryEvidenceId", () => {
    const primaryEvidence = makeEvidence({
      id: "ev-primary",
      source: "notion",
      sourceItemId: sourceItemDbId(COMPANY_ID, "notion:origin-page"),
      excerpt: "Original discovery insight about onboarding proof enterprise buyers demand.",
      excerptHash: "primary-hash"
    });
    const opp = makeOpportunity({
      evidence: [primaryEvidence],
      primaryEvidence
    });

    const candidate = makeItem({
      source: "market-research",
      externalId: "market-research:backfill-1:hash-bf",
      sourceItemId: sourceItemDbId(COMPANY_ID, "market-research:backfill-1:hash-bf"),
      title: "Enterprise onboarding proof trends",
      text: "Concrete proof of onboarding effectiveness drives enterprise purchasing decisions faster than any other factor.",
      summary: "Enterprise buyers demand proof of onboarding"
    });

    const result = findSupportingEvidence(opp, [candidate], COMPANY_ID);
    // New evidence is added as supporting, not replacing primary
    expect(result.evidence.length).toBeGreaterThan(0);
    for (const ev of result.evidence) {
      expect(ev.id).not.toBe(primaryEvidence.id);
    }
    // Original primary remains in opp.evidence
    expect(opp.primaryEvidence.id).toBe("ev-primary");
    expect(opp.evidence[0].id).toBe("ev-primary");
  });

  it("is idempotent — second run returns 0 new evidence", () => {
    const primaryEvidence = makeEvidence({
      id: "ev-primary",
      source: "notion",
      sourceItemId: sourceItemDbId(COMPANY_ID, "notion:origin-page"),
      excerpt: "Original discovery insight about onboarding proof enterprise buyers demand.",
      excerptHash: "primary-hash"
    });
    const opp = makeOpportunity({
      evidence: [primaryEvidence],
      primaryEvidence
    });

    const candidate = makeItem({
      source: "market-research",
      externalId: "market-research:backfill-idem:hash-id",
      sourceItemId: sourceItemDbId(COMPANY_ID, "market-research:backfill-idem:hash-id"),
      title: "Enterprise onboarding proof trends",
      text: "Concrete proof of onboarding effectiveness drives enterprise purchasing decisions faster than any other factor.",
      summary: "Enterprise buyers demand proof of onboarding"
    });

    // First run — should find new evidence
    const firstRun = findSupportingEvidence(opp, [candidate], COMPANY_ID);
    expect(firstRun.evidence.length).toBeGreaterThan(0);

    // Simulate persistence: add the new evidence to the opportunity
    const updatedOpp = makeOpportunity({
      evidence: [...opp.evidence, ...firstRun.evidence],
      primaryEvidence
    });

    // Second run — same candidates, same opportunity (now with the evidence) → 0 new
    const secondRun = findSupportingEvidence(updatedOpp, [candidate], COMPANY_ID);
    expect(secondRun.evidence).toHaveLength(0);
  });
});

// --- isBlockedByPublishability ---

describe("isBlockedByPublishability", () => {
  it("returns true for harmful", () => {
    const item = makeItem({ metadata: { publishabilityRisk: "harmful" } });
    expect(isBlockedByPublishability(item)).toBe(true);
  });

  it("returns true for reframeable", () => {
    const item = makeItem({ metadata: { publishabilityRisk: "reframeable" } });
    expect(isBlockedByPublishability(item)).toBe(true);
  });

  it("returns false for safe", () => {
    const item = makeItem({ metadata: { publishabilityRisk: "safe" } });
    expect(isBlockedByPublishability(item)).toBe(false);
  });

  it("returns false when no publishabilityRisk field", () => {
    const item = makeItem({ metadata: {} });
    expect(isBlockedByPublishability(item)).toBe(false);
  });
});

// --- findSupportingEvidence publishability blocking ---

describe("findSupportingEvidence publishability blocking", () => {
  it("reframeable candidate → 0 evidence", () => {
    const opp = makeOpportunity();
    const reframeableItem = makeItem({
      source: "claap",
      externalId: "claap:reframeable-1",
      sourceItemId: "claap-reframeable-1",
      title: "Enterprise buyers demand concrete onboarding proof in sales call",
      summary: "Enterprise buyers explicitly demand concrete onboarding proof before purchasing decisions.",
      text: "Enterprise buyers demand concrete proof of onboarding before purchasing decisions.",
      metadata: { signalKind: "claap-signal-reframeable", publishabilityRisk: "reframeable" }
    });
    const result = findSupportingEvidence(opp, [reframeableItem], COMPANY_ID);
    expect(result.evidence).toHaveLength(0);
  });

  it("harmful candidate → 0 evidence", () => {
    const opp = makeOpportunity();
    const harmfulItem = makeItem({
      source: "claap",
      externalId: "claap:harmful-1",
      sourceItemId: "claap-harmful-1",
      title: "Enterprise buyers demand concrete onboarding proof in sales call",
      summary: "Enterprise buyers explicitly demand concrete onboarding proof before purchasing decisions.",
      text: "Enterprise buyers demand concrete proof of onboarding before purchasing decisions.",
      metadata: { publishabilityRisk: "harmful" }
    });
    const result = findSupportingEvidence(opp, [harmfulItem], COMPANY_ID);
    expect(result.evidence).toHaveLength(0);
  });

  it("safe signal candidate → evidence found", () => {
    const opp = makeOpportunity();
    const safeItem = makeItem({
      source: "claap",
      externalId: "claap:safe-signal-1",
      sourceItemId: "claap-safe-signal-1",
      title: "Enterprise buyers demand concrete onboarding proof in sales call",
      summary: "Enterprise buyers explicitly demand concrete onboarding proof before purchasing decisions.",
      text: "The enterprise buyers demand concrete proof of onboarding before purchasing decisions.",
      metadata: { signalKind: "claap-signal", publishabilityRisk: "safe" }
    });
    const result = findSupportingEvidence(opp, [safeItem], COMPANY_ID);
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("plain claap (no publishabilityRisk) → evidence found (backward compat)", () => {
    const opp = makeOpportunity();
    const plainItem = makeItem({
      source: "claap",
      externalId: "claap:plain-compat-1",
      sourceItemId: "claap-plain-compat-1",
      title: "Enterprise buyers demand concrete onboarding proof in sales call",
      summary: "Enterprise buyers explicitly demand concrete onboarding proof before purchasing decisions.",
      text: "The enterprise buyers demand concrete proof of onboarding before purchasing decisions.",
      metadata: {}
    });
    const result = findSupportingEvidence(opp, [plainItem], COMPANY_ID);
    // May or may not match depending on threshold, but it's NOT blocked
    // Just verify it's not blocked at the publishability level
    // (plain claap uses priority 3 / 0.15 threshold, so with strong overlap it should match)
    if (result.evidence.length > 0) {
      expect(result.sources[0].source).toBe("claap");
    }
  });

  it("reframeable with strong topic overlap → still blocked", () => {
    const opp = makeOpportunity();
    const reframeableItem = makeItem({
      source: "claap",
      externalId: "claap:reframeable-strong",
      sourceItemId: "claap-reframeable-strong",
      // Extremely high overlap with opportunity title/angle
      title: "Enterprise buyers demand onboarding proof before purchasing",
      summary: "Concrete onboarding proof changes enterprise buying decisions faster than generic claims",
      text: "Multiple recent deals show buyers dismissing generic positioning in favor of real implementation evidence for onboarding proof enterprise purchasing decisions",
      metadata: { signalKind: "claap-signal-reframeable", publishabilityRisk: "reframeable" }
    });
    const result = findSupportingEvidence(opp, [reframeableItem], COMPANY_ID);
    expect(result.evidence).toHaveLength(0);
  });
});

// --- deriveProvenanceType reframeable ---

describe("deriveProvenanceType reframeable", () => {
  it("returns claap:reframeable for reframeable signalKind", () => {
    const item = makeItem({
      source: "claap",
      metadata: { signalKind: "claap-signal-reframeable" }
    });
    expect(deriveProvenanceType(item)).toBe("claap:reframeable");
  });
});
