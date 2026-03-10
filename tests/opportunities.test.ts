import { describe, expect, it } from "vitest";

import { maybeCreateOpportunity, qualifyDraftCandidate } from "../src/services/opportunities.js";

const signal = {
  id: "signal_1",
  sourceFingerprint: "signal-fp-1",
  title: "Recurring objection",
  summary: "Buyers ask for proof of adoption.",
  type: "objection" as const,
  freshness: 0.9,
  confidence: 0.85,
  probableOwnerProfile: "quentin" as const,
  suggestedAngle: "Use the objection as market proof.",
  status: "New" as const,
  sourceItemIds: ["1"],
  duplicateOfSignalId: undefined,
  themeClusterKey: "cluster_1",
  notionPageFingerprint: "signal-fp-1",
  sensitivity: {
    blocked: false,
    categories: [],
    rationale: "",
    stageOneMatchedRules: [],
    stageTwoScore: 0.1
  },
  evidence: [
    {
      id: "e1",
      source: "slack" as const,
      sourceItemId: "1",
      sourceUrl: "https://example.com",
      timestamp: new Date().toISOString(),
      excerpt: "We need proof of adoption.",
      excerptHash: "hash1",
      speakerOrAuthor: "user-1",
      freshnessScore: 0.9
    },
    {
      id: "e2",
      source: "linear" as const,
      sourceItemId: "2",
      sourceUrl: "https://example.com/2",
      timestamp: new Date().toISOString(),
      excerpt: "Same objection in product review.",
      excerptHash: "hash2",
      speakerOrAuthor: "user-2",
      freshnessScore: 0.8
    }
  ]
};

describe("opportunity gating", () => {
  it("creates opportunities only for routed, evidence-rich signals", () => {
    const opportunity = maybeCreateOpportunity({
      signal,
      assignment: {
        profileId: "quentin",
        territory: "terrain commercial / adoption",
        confidence: 0.8,
        needsRouting: false,
        rationale: "Sales/adoption evidence"
      },
      clusterConflict: false
    });

    expect(opportunity).not.toBeNull();
    expect(opportunity?.readiness).toBe("Opportunity only");
    expect(opportunity?.evidence).toHaveLength(2);
    expect(opportunity?.supportingEvidenceCount).toBe(1);
    expect(opportunity?.primaryEvidence.id).not.toBe(signal.evidence[0].id);
  });

  it("promotes evidence-rich opportunities to draft candidate", () => {
    const opportunity = maybeCreateOpportunity({
      signal,
      assignment: {
        profileId: "quentin",
        territory: "terrain commercial / adoption",
        confidence: 0.8,
        needsRouting: false,
        rationale: "Sales/adoption evidence"
      },
      clusterConflict: false
    });

    const qualified = qualifyDraftCandidate(opportunity!, false);
    expect(qualified.readiness).toBe("Draft candidate");
    expect(qualified.status).toBe("Ready for V1");
  });
});
