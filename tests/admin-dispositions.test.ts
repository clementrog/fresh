import { describe, expect, it } from "vitest";

import { DISPOSITION_CLAUSES, type Disposition } from "../src/admin/queries.js";

// ── Prisma WHERE clause matcher ─────────────────────────────────────────────
// Evaluates Prisma-style WHERE clauses against in-memory objects.
// Covers the exact operator subset used by DISPOSITION_CLAUSES:
//   - direct equality, null checks
//   - { not: null }
//   - { path: [...], equals: value } (JSON field queries)
//   - { every: { ... } }, { none: {} } (relation array operators)
//   - OR, NOT logical combinators

function matchesWhere(item: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      const clauses = condition as Record<string, unknown>[];
      if (!clauses.some((c) => matchesWhere(item, c))) return false;
      continue;
    }
    if (key === "NOT") {
      const notClauses = Array.isArray(condition) ? condition : [condition];
      if ((notClauses as Record<string, unknown>[]).some((c) => matchesWhere(item, c))) return false;
      continue;
    }

    const value = item[key];

    if (condition === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }

    if (typeof condition === "object" && condition !== null) {
      const cond = condition as Record<string, unknown>;

      // { not: null } — value must not be null/undefined
      if ("not" in cond && cond.not === null) {
        if (value === null || value === undefined) return false;
        continue;
      }

      // { path: ["field"], equals: "value" } — JSON field query
      if ("path" in cond && "equals" in cond) {
        const pathParts = cond.path as string[];
        let current: unknown = value;
        for (const part of pathParts) {
          if (current === null || current === undefined) return false;
          current = (current as Record<string, unknown>)[part];
        }
        if (current !== cond.equals) return false;
        continue;
      }

      // { every: { ... } } — all elements in array must match
      if ("every" in cond) {
        const arr = (value ?? []) as Record<string, unknown>[];
        if (!arr.every((el) => matchesWhere(el, cond.every as Record<string, unknown>))) return false;
        continue;
      }

      // { none: { ... } } — no element in array may match
      if ("none" in cond) {
        const arr = (value ?? []) as Record<string, unknown>[];
        if (arr.some((el) => matchesWhere(el, cond.none as Record<string, unknown>))) return false;
        continue;
      }
    }

    // Direct equality
    if (value !== condition) return false;
  }
  return true;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Realistic source items in various states, matching the Prisma model shape.

const fixtures = {
  // Normal: processed, has direct opportunity, synced to Notion, safe
  normal: {
    id: "si_normal",
    processedAt: new Date("2026-01-01"),
    notionPageId: "notion_1",
    screeningResultJson: { decision: "retain" },
    metadataJson: { publishabilityRisk: "safe" },
    evidenceReferences: [
      { opportunityId: "opp_1", opportunityLinks: [{ opportunityId: "opp_1" }], primaryForOpportunities: [] }
    ]
  },

  // Orphaned: processed, no opp connections at all, retained, no risk
  orphaned: {
    id: "si_orphaned",
    processedAt: new Date("2026-01-01"),
    notionPageId: "notion_2",
    screeningResultJson: { decision: "retain" },
    metadataJson: {},
    evidenceReferences: [
      { opportunityId: null, opportunityLinks: [], primaryForOpportunities: [] }
    ]
  },

  // PRIMARY-LINKED: evidence is primary for an opportunity — NOT orphaned
  primaryLinked: {
    id: "si_primary",
    processedAt: new Date("2026-01-01"),
    notionPageId: "notion_3",
    screeningResultJson: { decision: "retain" },
    metadataJson: {},
    evidenceReferences: [
      { opportunityId: null, opportunityLinks: [], primaryForOpportunities: [{ id: "opp_1" }] }
    ]
  },

  // OPPORTUNITY-LINKED via OpportunityEvidence join table — NOT orphaned
  joinLinked: {
    id: "si_join",
    processedAt: new Date("2026-01-01"),
    notionPageId: "notion_4",
    screeningResultJson: { decision: "retain" },
    metadataJson: {},
    evidenceReferences: [
      { opportunityId: null, opportunityLinks: [{ opportunityId: "opp_2" }], primaryForOpportunities: [] }
    ]
  },

  // Mixed evidence: one ref is orphaned, one is linked — NOT orphaned (every must match)
  mixedEvidence: {
    id: "si_mixed",
    processedAt: new Date("2026-01-01"),
    notionPageId: "notion_5",
    screeningResultJson: { decision: "retain" },
    metadataJson: {},
    evidenceReferences: [
      { opportunityId: null, opportunityLinks: [], primaryForOpportunities: [] },
      { opportunityId: "opp_3", opportunityLinks: [], primaryForOpportunities: [] }
    ]
  },

  // No evidence at all — vacuously matches `every` so IS orphaned (if processed)
  noEvidence: {
    id: "si_no_evidence",
    processedAt: new Date("2026-01-01"),
    notionPageId: "notion_6",
    screeningResultJson: { decision: "retain" },
    metadataJson: {},
    evidenceReferences: []
  },

  // Blocked: harmful publishability risk
  blockedHarmful: {
    id: "si_blocked_h",
    processedAt: new Date("2026-01-01"),
    notionPageId: null,
    screeningResultJson: { decision: "retain" },
    metadataJson: { publishabilityRisk: "harmful" },
    evidenceReferences: []
  },

  // Blocked: reframeable publishability risk
  blockedReframeable: {
    id: "si_blocked_r",
    processedAt: new Date("2026-01-01"),
    notionPageId: null,
    screeningResultJson: { decision: "retain" },
    metadataJson: { publishabilityRisk: "reframeable" },
    evidenceReferences: []
  },

  // Safe publishability — NOT blocked
  safeRisk: {
    id: "si_safe",
    processedAt: new Date("2026-01-01"),
    notionPageId: null,
    screeningResultJson: { decision: "retain" },
    metadataJson: { publishabilityRisk: "safe" },
    evidenceReferences: []
  },

  // Screened out
  screenedOut: {
    id: "si_screened",
    processedAt: null,
    notionPageId: null,
    screeningResultJson: { decision: "skip" },
    metadataJson: {},
    evidenceReferences: []
  },

  // Unsynced: processed, no Notion page, retained, no risk
  unsynced: {
    id: "si_unsynced",
    processedAt: new Date("2026-01-01"),
    notionPageId: null,
    screeningResultJson: { decision: "retain" },
    metadataJson: {},
    evidenceReferences: []
  },

  // Unprocessed
  unprocessed: {
    id: "si_unprocessed",
    processedAt: null,
    notionPageId: null,
    screeningResultJson: null,
    metadataJson: {},
    evidenceReferences: []
  },

  // Synced: has Notion page
  synced: {
    id: "si_synced",
    processedAt: new Date("2026-01-01"),
    notionPageId: "notion_7",
    screeningResultJson: { decision: "retain" },
    metadataJson: { publishabilityRisk: "safe" },
    evidenceReferences: []
  }
};

function matches(item: Record<string, unknown>, disposition: Disposition): boolean {
  return matchesWhere(item, DISPOSITION_CLAUSES[disposition] as unknown as Record<string, unknown>);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("screened-out disposition semantics", () => {
  it("matches item with decision=skip", () => {
    expect(matches(fixtures.screenedOut, "screened-out")).toBe(true);
  });

  it("rejects item with decision=retain", () => {
    expect(matches(fixtures.normal, "screened-out")).toBe(false);
  });

  it("rejects item with null screening result", () => {
    expect(matches(fixtures.unprocessed, "screened-out")).toBe(false);
  });
});

describe("blocked disposition semantics", () => {
  it("matches harmful publishability risk", () => {
    expect(matches(fixtures.blockedHarmful, "blocked")).toBe(true);
  });

  it("matches reframeable publishability risk", () => {
    expect(matches(fixtures.blockedReframeable, "blocked")).toBe(true);
  });

  it("rejects safe publishability risk", () => {
    expect(matches(fixtures.safeRisk, "blocked")).toBe(false);
  });

  it("rejects item with no publishability risk field", () => {
    expect(matches(fixtures.orphaned, "blocked")).toBe(false);
  });
});

describe("orphaned disposition semantics", () => {
  it("matches processed item with no opportunity connections", () => {
    expect(matches(fixtures.orphaned, "orphaned")).toBe(true);
  });

  it("matches processed item with zero evidence references (vacuous every)", () => {
    expect(matches(fixtures.noEvidence, "orphaned")).toBe(true);
  });

  it("rejects item with direct opportunityId on evidence", () => {
    expect(matches(fixtures.normal, "orphaned")).toBe(false);
  });

  it("rejects item where evidence is primaryForOpportunities", () => {
    expect(matches(fixtures.primaryLinked, "orphaned")).toBe(false);
  });

  it("rejects item where evidence has opportunityLinks", () => {
    expect(matches(fixtures.joinLinked, "orphaned")).toBe(false);
  });

  it("rejects item with mixed evidence (one linked, one not) — every must match", () => {
    expect(matches(fixtures.mixedEvidence, "orphaned")).toBe(false);
  });

  it("rejects unprocessed item", () => {
    expect(matches(fixtures.unprocessed, "orphaned")).toBe(false);
  });

  it("rejects screened-out item (NOT exclusion)", () => {
    expect(matches(fixtures.screenedOut, "orphaned")).toBe(false);
  });

  it("rejects blocked-harmful item (NOT exclusion)", () => {
    expect(matches(fixtures.blockedHarmful, "orphaned")).toBe(false);
  });

  it("rejects blocked-reframeable item (NOT exclusion)", () => {
    expect(matches(fixtures.blockedReframeable, "orphaned")).toBe(false);
  });
});

describe("unsynced disposition semantics", () => {
  it("matches processed item with no Notion page", () => {
    expect(matches(fixtures.unsynced, "unsynced")).toBe(true);
  });

  it("rejects item with Notion page", () => {
    expect(matches(fixtures.synced, "unsynced")).toBe(false);
  });

  it("rejects unprocessed item", () => {
    expect(matches(fixtures.unprocessed, "unsynced")).toBe(false);
  });

  it("rejects screened-out item (NOT exclusion)", () => {
    expect(matches(fixtures.screenedOut, "unsynced")).toBe(false);
  });

  it("rejects blocked-harmful item (NOT exclusion)", () => {
    expect(matches(fixtures.blockedHarmful, "unsynced")).toBe(false);
  });

  it("rejects blocked-reframeable item (NOT exclusion)", () => {
    expect(matches(fixtures.blockedReframeable, "unsynced")).toBe(false);
  });
});

describe("primaryForOpportunities exclusion path", () => {
  it("a single primaryForOpportunities entry prevents orphaned classification", () => {
    const item = {
      ...fixtures.orphaned,
      evidenceReferences: [
        { opportunityId: null, opportunityLinks: [], primaryForOpportunities: [{ id: "opp_x" }] }
      ]
    };
    expect(matches(item, "orphaned")).toBe(false);
  });

  it("multiple evidence refs — one primary-linked suffices to prevent orphaned", () => {
    const item = {
      ...fixtures.orphaned,
      evidenceReferences: [
        { opportunityId: null, opportunityLinks: [], primaryForOpportunities: [] },
        { opportunityId: null, opportunityLinks: [], primaryForOpportunities: [{ id: "opp_y" }] }
      ]
    };
    expect(matches(item, "orphaned")).toBe(false);
  });

  it("primaryForOpportunities does not affect blocked classification", () => {
    const item = {
      ...fixtures.blockedHarmful,
      evidenceReferences: [
        { opportunityId: null, opportunityLinks: [], primaryForOpportunities: [{ id: "opp_z" }] }
      ]
    };
    expect(matches(item, "blocked")).toBe(true);
  });
});
