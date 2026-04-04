import { describe, expect, it } from "vitest";

import {
  buildClustersFromPairs,
  clusterSuppressionHash,
  computeTopicalScore
} from "../src/admin/queries.js";
import {
  validateDecisions,
  type ClusterDecision
} from "../src/admin/duplicate-actions.js";
import { withCompany } from "../src/admin/components.js";

// ── buildClustersFromPairs ────────────────────────────────────────────

describe("buildClustersFromPairs", () => {
  it("groups a single pair into one cluster", () => {
    const clusters = buildClustersFromPairs([["A", "B"]]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sort()).toEqual(["A", "B"]);
  });

  it("merges transitive pairs: A~B + B~C → {A,B,C}", () => {
    const clusters = buildClustersFromPairs([
      ["A", "B"],
      ["B", "C"]
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sort()).toEqual(["A", "B", "C"]);
  });

  it("keeps disjoint pairs as separate clusters", () => {
    const clusters = buildClustersFromPairs([
      ["A", "B"],
      ["C", "D"]
    ]);
    expect(clusters).toHaveLength(2);
    const sorted = clusters.map((c) => c.sort()).sort((a, b) => a[0].localeCompare(b[0]));
    expect(sorted[0]).toEqual(["A", "B"]);
    expect(sorted[1]).toEqual(["C", "D"]);
  });

  it("handles a long transitive chain", () => {
    const clusters = buildClustersFromPairs([
      ["A", "B"],
      ["B", "C"],
      ["C", "D"],
      ["D", "E"]
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sort()).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("preserves all members in a large chain (no silent truncation)", () => {
    // Create 12 nodes in a chain — all must appear so the suppression
    // hash covers the full connected component
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < 11; i++) {
      pairs.push([`N${i}`, `N${i + 1}`]);
    }
    const clusters = buildClustersFromPairs(pairs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].length).toBe(12);
  });

  it("returns empty array for no pairs", () => {
    const clusters = buildClustersFromPairs([]);
    expect(clusters).toHaveLength(0);
  });

  it("handles duplicate pairs gracefully", () => {
    const clusters = buildClustersFromPairs([
      ["A", "B"],
      ["A", "B"],
      ["B", "C"]
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sort()).toEqual(["A", "B", "C"]);
  });
});

// ── clusterSuppressionHash ────────────────────────────────────────────

describe("clusterSuppressionHash", () => {
  it("produces a deterministic hash for the same sorted members", () => {
    const hash1 = clusterSuppressionHash(["opp_a", "opp_b", "opp_c"]);
    const hash2 = clusterSuppressionHash(["opp_a", "opp_b", "opp_c"]);
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different member sets", () => {
    const hash1 = clusterSuppressionHash(["opp_a", "opp_b"]);
    const hash2 = clusterSuppressionHash(["opp_a", "opp_c"]);
    expect(hash1).not.toBe(hash2);
  });

  it("starts with the dcluster_ prefix", () => {
    const hash = clusterSuppressionHash(["opp_a", "opp_b"]);
    expect(hash).toMatch(/^dcluster_/);
  });

  it("produces different hashes when a new member is added", () => {
    const hash1 = clusterSuppressionHash(["opp_a", "opp_b"]);
    const hash2 = clusterSuppressionHash(["opp_a", "opp_b", "opp_c"]);
    expect(hash1).not.toBe(hash2);
  });
});

// ── computeTopicalScore ───────────────────────────────────────────────

describe("computeTopicalScore", () => {
  it("returns 0 for completely different content", () => {
    const score = computeTopicalScore(
      "Migration paie cloud", "Risques techniques migration",
      "Recrutement alternants 2026", "Aide embauche apprentissage"
    );
    expect(score).toBeLessThan(0.15);
  });

  it("returns high score for very similar content", () => {
    const score = computeTopicalScore(
      "Migration paie DSN", "Risques migration DSN conformité",
      "Migration paie DSN cloud", "Risques migration DSN réglementaire"
    );
    expect(score).toBeGreaterThan(0.3);
  });

  it("returns 0 for empty strings", () => {
    const score = computeTopicalScore("", "", "", "");
    expect(score).toBe(0);
  });
});

// ── validateDecisions ─────────────────────────────────────────────────

describe("validateDecisions", () => {
  const members = ["opp_a", "opp_b", "opp_c"];

  it("accepts canonical + archive decisions", () => {
    const result = validateDecisions(members, {
      opp_a: "canonical",
      opp_b: "archive",
      opp_c: "archive"
    });
    expect(result).toBeNull();
  });

  it("accepts all keep-separate", () => {
    const result = validateDecisions(members, {
      opp_a: "keep-separate",
      opp_b: "keep-separate",
      opp_c: "keep-separate"
    });
    expect(result).toBeNull();
  });

  it("accepts canonical + archive + keep-separate mix", () => {
    const result = validateDecisions(members, {
      opp_a: "canonical",
      opp_b: "archive",
      opp_c: "keep-separate"
    });
    expect(result).toBeNull();
  });

  it("rejects missing decision for a member", () => {
    const result = validateDecisions(members, {
      opp_a: "canonical",
      opp_b: "archive"
    });
    expect(result).toContain("Missing decision");
  });

  it("rejects decision for non-member", () => {
    const result = validateDecisions(members, {
      opp_a: "canonical",
      opp_b: "archive",
      opp_c: "archive",
      opp_d: "keep-separate"
    });
    expect(result).toContain("non-member");
  });

  it("rejects multiple canonicals", () => {
    const result = validateDecisions(members, {
      opp_a: "canonical",
      opp_b: "canonical",
      opp_c: "archive"
    });
    expect(result).toContain("Exactly one");
  });

  it("rejects archive without canonical", () => {
    const result = validateDecisions(members, {
      opp_a: "archive",
      opp_b: "archive",
      opp_c: "keep-separate"
    });
    expect(result).toContain("Exactly one");
  });

  it("rejects canonical without any archive", () => {
    const result = validateDecisions(members, {
      opp_a: "canonical",
      opp_b: "keep-separate",
      opp_c: "keep-separate"
    });
    expect(result).toContain("At least one member must be archived");
  });

  it("works with a two-member cluster", () => {
    const result = validateDecisions(["opp_a", "opp_b"], {
      opp_a: "canonical",
      opp_b: "archive"
    });
    expect(result).toBeNull();
  });
});

// ── Redirect URL construction ────────────────────────────────────────

describe("duplicate review redirect URL", () => {
  it("uses ? separator when no company slug is provided", () => {
    const base = withCompany("/admin/reviews/duplicates", undefined);
    const separator = base.includes("?") ? "&" : "?";
    const url = base + separator + "success=1";
    expect(url).toBe("/admin/reviews/duplicates?success=1");
  });

  it("uses & separator when company slug adds ?company=", () => {
    const base = withCompany("/admin/reviews/duplicates", "acme");
    const separator = base.includes("?") ? "&" : "?";
    const url = base + separator + "success=1";
    expect(url).toBe("/admin/reviews/duplicates?company=acme&success=1");
  });
});
