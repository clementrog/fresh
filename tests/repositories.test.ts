import { describe, expect, it } from "vitest";

import type { EvidenceReference } from "../src/domain/types.js";
import { validateOpportunityPrimaryEvidence } from "../src/db/repositories.js";

describe("repository evidence validation", () => {
  it("rejects a primary evidence id that does not belong to the opportunity evidence set", () => {
    const evidence: EvidenceReference[] = [
      {
        id: "evidence_1",
        source: "slack",
        sourceItemId: "source-1",
        sourceUrl: "https://example.com",
        timestamp: new Date().toISOString(),
        excerpt: "Proof",
        excerptHash: "hash-1",
        freshnessScore: 0.9
      }
    ];

    expect(() => validateOpportunityPrimaryEvidence(evidence, "evidence_2")).toThrow(
      "Primary evidence id must reference an evidence row owned by the opportunity."
    );
  });
});
