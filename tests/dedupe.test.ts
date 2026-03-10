import { describe, expect, it } from "vitest";

import { buildThemeClusters, markObviousDuplicates } from "../src/services/dedupe.js";

describe("dedupe and clustering", () => {
  it("marks exact duplicate-looking signals without losing clustering", () => {
    const signals = [
      {
        id: "signal_1",
        sourceFingerprint: "signal-fp-1",
        title: "Proof matters",
        summary: "Proof matters for adoption",
        type: "market-pattern" as const,
        freshness: 0.9,
        confidence: 0.8,
        probableOwnerProfile: "quentin" as const,
        suggestedAngle: "Explain why proof beats promise.",
        status: "New" as const,
        evidence: [],
        sourceItemIds: ["1"],
        notionPageFingerprint: "signal-fp-1",
        sensitivity: {
          blocked: false,
          categories: [],
          rationale: "",
          stageOneMatchedRules: [],
          stageTwoScore: 0.1
        }
      },
      {
        id: "signal_2",
        sourceFingerprint: "signal-fp-2",
        title: "Proof matters",
        summary: "Proof matters for adoption",
        type: "market-pattern" as const,
        freshness: 0.8,
        confidence: 0.79,
        probableOwnerProfile: "quentin" as const,
        suggestedAngle: "Explain why proof beats promise.",
        status: "New" as const,
        evidence: [],
        sourceItemIds: ["1"],
        notionPageFingerprint: "signal-fp-2",
        sensitivity: {
          blocked: false,
          categories: [],
          rationale: "",
          stageOneMatchedRules: [],
          stageTwoScore: 0.1
        }
      }
    ];

    const deduped = markObviousDuplicates(signals);
    expect(deduped[1]?.duplicateOfSignalId).toBe("signal_1");

    const clusters = buildThemeClusters(deduped);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.signalIds).toEqual(["signal_1", "signal_2"]);
  });
});
