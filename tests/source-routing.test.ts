import { describe, expect, it } from "vitest";
import { getSourceFamily, isFirstPartyFamily } from "../src/domain/source-family.js";
import {
  adjustOwnerRouting,
  enforceRoutingOnDecision,
  findFirstPartyCorroboration,
  FIRST_PARTY_REQUIRED_OWNERS,
  STRUCTURAL_PROMOTION_TARGET,
  type RoutingAdjustment
} from "../src/services/routing.js";
import { normalizeNarrativePillar } from "../src/lib/text.js";
import type { NormalizedSourceItem, ScreeningResult } from "../src/domain/types.js";

function makeItem(overrides: Partial<NormalizedSourceItem> = {}): NormalizedSourceItem {
  return {
    source: "notion",
    sourceItemId: "page-1",
    externalId: "notion:page-1",
    sourceFingerprint: "fp-1",
    sourceUrl: "https://notion.so/page-1",
    title: "Item title",
    text: "Some body text about DSN regularization and HCR convention handling across cabinets.",
    summary: "Summary about DSN regularization",
    occurredAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    metadata: {},
    rawPayload: {},
    ...overrides
  };
}

function makeScreening(overrides: Partial<ScreeningResult> = {}): ScreeningResult {
  return {
    decision: "retain",
    rationale: "looks retainable",
    createOrEnrich: "create",
    relevanceScore: 0.7,
    sensitivityFlag: false,
    sensitivityCategories: [],
    ...overrides
  };
}

// ─────────────────────────────────────────────────────────────────────
// getSourceFamily
// ─────────────────────────────────────────────────────────────────────

describe("getSourceFamily", () => {
  it("classifies linear as first-party-work", () => {
    expect(getSourceFamily(makeItem({ source: "linear" }))).toBe("first-party-work");
  });

  it("classifies github as first-party-work", () => {
    expect(getSourceFamily(makeItem({ source: "github" }))).toBe("first-party-work");
  });

  it("classifies hubspot as field-proof", () => {
    expect(getSourceFamily(makeItem({ source: "hubspot" }))).toBe("field-proof");
  });

  it("classifies claap prospect calls as field-proof", () => {
    const item = makeItem({
      source: "claap",
      metadata: { routingDecision: "prospect_call" }
    });
    expect(getSourceFamily(item)).toBe("field-proof");
  });

  it("classifies claap internal retros as first-party-work", () => {
    const item = makeItem({
      source: "claap",
      metadata: { routingDecision: "create_opportunity" }
    });
    expect(getSourceFamily(item)).toBe("first-party-work");
  });

  it("classifies notion market-insight pages as synthesized-market", () => {
    const item = makeItem({
      source: "notion",
      metadata: { notionKind: "market-insight" }
    });
    expect(getSourceFamily(item)).toBe("synthesized-market");
  });

  it("classifies non-insight notion pages as first-party-work", () => {
    const item = makeItem({
      source: "notion",
      metadata: { notionKind: "product-doc" }
    });
    expect(getSourceFamily(item)).toBe("first-party-work");
  });

  it("classifies market-research as synthesized-market", () => {
    expect(getSourceFamily(makeItem({ source: "market-research" }))).toBe("synthesized-market");
  });

  it("classifies market-findings as synthesized-market", () => {
    expect(getSourceFamily(makeItem({ source: "market-findings" }))).toBe("synthesized-market");
  });

  it("isFirstPartyFamily returns true for first-party-work and field-proof", () => {
    expect(isFirstPartyFamily("first-party-work")).toBe(true);
    expect(isFirstPartyFamily("field-proof")).toBe(true);
    expect(isFirstPartyFamily("synthesized-market")).toBe(false);
    expect(isFirstPartyFamily("other")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// normalizeNarrativePillar
// ─────────────────────────────────────────────────────────────────────

describe("normalizeNarrativePillar", () => {
  it("strips accents and lowercases", () => {
    expect(normalizeNarrativePillar("Expertise métier / fiabilité")).toBe("expertise metier / fiabilite");
  });

  it("collapses unaccented and accented duplicates into one key", () => {
    const a = normalizeNarrativePillar("expertise metier / fiabilite");
    const b = normalizeNarrativePillar("Expertise métier / Fiabilité");
    const c = normalizeNarrativePillar("EXPERTISE MÉTIER / FIABILITÉ");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("normalizes slash separators with consistent spacing", () => {
    expect(normalizeNarrativePillar("produit/feedback")).toBe("produit / feedback");
    expect(normalizeNarrativePillar("produit /feedback")).toBe("produit / feedback");
    expect(normalizeNarrativePillar("produit/ feedback")).toBe("produit / feedback");
    expect(normalizeNarrativePillar("produit  /  feedback")).toBe("produit / feedback");
  });

  it("collapses runs of whitespace", () => {
    expect(normalizeNarrativePillar("  expertise    metier  ")).toBe("expertise metier");
  });

  it("drops punctuation that is not / or -", () => {
    expect(normalizeNarrativePillar("paie, conformite, operations")).toBe("paie conformite operations");
  });

  it("returns undefined for null / undefined / empty", () => {
    expect(normalizeNarrativePillar(null)).toBeUndefined();
    expect(normalizeNarrativePillar(undefined)).toBeUndefined();
    expect(normalizeNarrativePillar("")).toBeUndefined();
    expect(normalizeNarrativePillar("   ")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// findFirstPartyCorroboration
// ─────────────────────────────────────────────────────────────────────

describe("findFirstPartyCorroboration", () => {
  it("finds a corroborating Linear item when token overlap is meaningful", () => {
    const notionItem = makeItem({
      source: "notion",
      externalId: "notion:dsn-insight",
      title: "DSN regularization failures across cabinets",
      summary: "Recurring DSN regularization issue",
      text: "Cabinets systematically lose 2-3 hours per DSN cycle reconciling regularization anomalies between HCR conventions and payroll software",
      metadata: { notionKind: "market-insight" }
    });
    const linearItem = makeItem({
      source: "linear",
      externalId: "linear:issue-42",
      title: "Fix DSN regularization error on HCR convention",
      summary: "HCR convention DSN regularization anomaly",
      text: "Cabinets report DSN regularization anomaly under HCR convention. Fix shipped in version 1.42.",
      metadata: {}
    });
    const result = findFirstPartyCorroboration({
      item: notionItem,
      candidateItems: [notionItem, linearItem]
    });
    expect(result).toHaveLength(1);
    expect(result[0].externalId).toBe("linear:issue-42");
  });

  it("does not return items with low overlap", () => {
    const notionItem = makeItem({
      source: "notion",
      externalId: "notion:dsn-insight",
      title: "DSN regularization failures across cabinets",
      summary: "Recurring DSN regularization friction",
      text: "Cabinets lose time on DSN regularization cycles",
      metadata: { notionKind: "market-insight" }
    });
    const unrelatedLinear = makeItem({
      source: "linear",
      externalId: "linear:unrelated",
      title: "Refactor authentication middleware",
      summary: "Auth refactor cleanup",
      text: "Cleanup of authentication stack in API gateway framework",
      metadata: {}
    });
    const result = findFirstPartyCorroboration({
      item: notionItem,
      candidateItems: [unrelatedLinear]
    });
    expect(result).toHaveLength(0);
  });

  it("skips synthesized-market candidates (never counts as corroboration)", () => {
    const notionA = makeItem({
      source: "notion",
      externalId: "notion:a",
      title: "DSN regularization failures across cabinets",
      text: "DSN regularization anomaly HCR convention",
      metadata: { notionKind: "market-insight" }
    });
    const notionB = makeItem({
      source: "notion",
      externalId: "notion:b",
      title: "DSN regularization failures across cabinets",
      text: "DSN regularization anomaly HCR convention",
      metadata: { notionKind: "market-insight" }
    });
    const result = findFirstPartyCorroboration({
      item: notionA,
      candidateItems: [notionA, notionB]
    });
    expect(result).toHaveLength(0);
  });

  it("caps results at 3 items, ordered by relevance", () => {
    const target = makeItem({
      source: "notion",
      externalId: "notion:target",
      title: "HCR convention payroll bulletin changes",
      text: "HCR convention payroll bulletin rules changed",
      metadata: { notionKind: "market-insight" }
    });
    const linearItems = Array.from({ length: 5 }, (_, i) =>
      makeItem({
        source: "linear",
        externalId: `linear:${i}`,
        title: "HCR convention payroll bulletin fix",
        text: `HCR convention payroll bulletin rules ${"lorem ipsum ".repeat(i)}`
      })
    );
    const result = findFirstPartyCorroboration({
      item: target,
      candidateItems: linearItems
    });
    expect(result.length).toBeLessThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────
// adjustOwnerRouting
// ─────────────────────────────────────────────────────────────────────

describe("adjustOwnerRouting", () => {
  it("clears baptiste when source is synthesized-market with no corroboration", () => {
    const item = makeItem({
      source: "notion",
      metadata: { notionKind: "market-insight" }
    });
    const screening = makeScreening({ ownerSuggestion: "baptiste" });
    const out = adjustOwnerRouting({ item, screening, corroboratingItems: [] });
    expect(out.outcome).toBe("cleared");
    expect(out.finalOwnerSuggestion).toBeUndefined();
    expect(out.originalOwnerSuggestion).toBe("baptiste");
    expect(out.reason).toMatch(/first-party/);
  });

  it("clears virginie when source is synthesized-market with no corroboration", () => {
    const item = makeItem({
      source: "market-findings",
      metadata: {}
    });
    const screening = makeScreening({ ownerSuggestion: "virginie" });
    const out = adjustOwnerRouting({ item, screening, corroboratingItems: [] });
    expect(out.outcome).toBe("cleared");
    expect(out.finalOwnerSuggestion).toBeUndefined();
  });

  it("clears linc-corporate when source is synthesized-market with no corroboration", () => {
    const item = makeItem({
      source: "market-research",
      metadata: {}
    });
    const screening = makeScreening({ ownerSuggestion: "linc-corporate" });
    const out = adjustOwnerRouting({ item, screening, corroboratingItems: [] });
    expect(out.outcome).toBe("cleared");
  });

  it("does NOT clear thomas/quentin even on synthesized-market with no corroboration", () => {
    const item = makeItem({
      source: "notion",
      metadata: { notionKind: "market-insight" }
    });
    const thomasScreening = makeScreening({ ownerSuggestion: "thomas" });
    const thomasOut = adjustOwnerRouting({ item, screening: thomasScreening, corroboratingItems: [] });
    expect(thomasOut.outcome).toBe("kept");
    expect(thomasOut.finalOwnerSuggestion).toBe("thomas");

    const quentinScreening = makeScreening({ ownerSuggestion: "quentin" });
    const quentinOut = adjustOwnerRouting({ item, screening: quentinScreening, corroboratingItems: [] });
    expect(quentinOut.outcome).toBe("kept");
    expect(quentinOut.finalOwnerSuggestion).toBe("quentin");
  });

  it("keeps baptiste when source is synthesized-market WITH corroboration", () => {
    const item = makeItem({
      source: "notion",
      metadata: { notionKind: "market-insight" }
    });
    const corroboration = makeItem({ source: "linear", externalId: "linear:1" });
    const screening = makeScreening({ ownerSuggestion: "baptiste" });
    const out = adjustOwnerRouting({ item, screening, corroboratingItems: [corroboration] });
    // Without structural significance flag, the gate passes baptiste through
    // (the synthesized-market lockout only fires when corroboration is absent).
    expect(out.outcome).toBe("kept");
    expect(out.finalOwnerSuggestion).toBe("baptiste");
  });

  it("promotes thomas → baptiste when structural significance is true and corroboration exists", () => {
    const item = makeItem({ source: "claap", metadata: {} }); // first-party-work
    const corroboration = makeItem({ source: "linear", externalId: "linear:proof" });
    const screening = makeScreening({
      ownerSuggestion: "thomas",
      hasStructuralSignificance: true
    });
    const out = adjustOwnerRouting({
      item,
      screening,
      corroboratingItems: [corroboration]
    });
    expect(out.outcome).toBe("promoted");
    expect(out.finalOwnerSuggestion).toBe(STRUCTURAL_PROMOTION_TARGET);
    expect(out.originalOwnerSuggestion).toBe("thomas");
  });

  it("promotes quentin → baptiste when structural significance is true and corroboration exists", () => {
    const item = makeItem({ source: "linear" });
    const screening = makeScreening({
      ownerSuggestion: "quentin",
      hasStructuralSignificance: true
    });
    const out = adjustOwnerRouting({
      item,
      screening,
      corroboratingItems: [makeItem({ source: "claap", externalId: "claap:proof" })]
    });
    expect(out.outcome).toBe("promoted");
    expect(out.finalOwnerSuggestion).toBe("baptiste");
  });

  it("does NOT promote virginie to baptiste (virginie is not a purely operational voice)", () => {
    const item = makeItem({ source: "linear" });
    const screening = makeScreening({
      ownerSuggestion: "virginie",
      hasStructuralSignificance: true
    });
    const out = adjustOwnerRouting({
      item,
      screening,
      corroboratingItems: [makeItem({ source: "linear", externalId: "linear:1" })]
    });
    // Pass-through: virginie stays because promotion only applies to thomas/quentin/unset.
    expect(out.outcome).toBe("kept");
    expect(out.finalOwnerSuggestion).toBe("virginie");
  });

  it("does NOT promote without corroboration even when structural significance is true", () => {
    const item = makeItem({ source: "linear" });
    const screening = makeScreening({
      ownerSuggestion: "thomas",
      hasStructuralSignificance: true
    });
    const out = adjustOwnerRouting({ item, screening, corroboratingItems: [] });
    // No corroboration → default pass-through.
    expect(out.outcome).toBe("kept");
    expect(out.finalOwnerSuggestion).toBe("thomas");
  });

  it("passes through when owner is undefined, source is first-party, and no structural flag", () => {
    const item = makeItem({ source: "linear" });
    const screening = makeScreening({ ownerSuggestion: undefined });
    const out = adjustOwnerRouting({ item, screening, corroboratingItems: [] });
    expect(out.outcome).toBe("kept");
    expect(out.finalOwnerSuggestion).toBeUndefined();
  });

  it("promotes unset → baptiste when structural significance is true and corroboration exists", () => {
    const item = makeItem({ source: "linear" });
    const screening = makeScreening({
      ownerSuggestion: undefined,
      hasStructuralSignificance: true
    });
    const out = adjustOwnerRouting({
      item,
      screening,
      corroboratingItems: [makeItem({ source: "linear", externalId: "linear:proof" })]
    });
    expect(out.outcome).toBe("promoted");
    expect(out.finalOwnerSuggestion).toBe("baptiste");
  });

  it("exposes FIRST_PARTY_REQUIRED_OWNERS with the expected membership", () => {
    expect(FIRST_PARTY_REQUIRED_OWNERS.has("baptiste")).toBe(true);
    expect(FIRST_PARTY_REQUIRED_OWNERS.has("virginie")).toBe(true);
    expect(FIRST_PARTY_REQUIRED_OWNERS.has("linc-corporate")).toBe(true);
    expect(FIRST_PARTY_REQUIRED_OWNERS.has("thomas")).toBe(false);
    expect(FIRST_PARTY_REQUIRED_OWNERS.has("quentin")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// enforceRoutingOnDecision — the post-LLM enforcement step
// ─────────────────────────────────────────────────────────────────────

function makeAdjustment(overrides: Partial<RoutingAdjustment>): RoutingAdjustment {
  return {
    originalOwnerSuggestion: undefined,
    finalOwnerSuggestion: undefined,
    outcome: "kept",
    reason: "test",
    sourceFamily: "first-party-work",
    hasFirstPartyCorroboration: false,
    corroboratingItemIds: [],
    ...overrides
  };
}

describe("enforceRoutingOnDecision", () => {
  it("is a no-op when LLM agrees with gate (both baptiste)", () => {
    const gateDecision = makeAdjustment({
      originalOwnerSuggestion: "baptiste",
      finalOwnerSuggestion: "baptiste",
      outcome: "kept"
    });
    const out = enforceRoutingOnDecision({
      gateDecision,
      llmOwnerDisplayName: "baptiste"
    });
    expect(out.finalOwnerDisplayName).toBe("baptiste");
    expect(out.enforcement.kind).toBe("agreement");
  });

  it("is a no-op when both gate and LLM are undefined", () => {
    const gateDecision = makeAdjustment({ outcome: "kept" });
    const out = enforceRoutingOnDecision({
      gateDecision,
      llmOwnerDisplayName: undefined
    });
    expect(out.finalOwnerDisplayName).toBeUndefined();
    expect(out.enforcement.kind).toBe("agreement");
  });

  it("rejects LLM re-assigning baptiste after gate cleared it", () => {
    const gateDecision = makeAdjustment({
      originalOwnerSuggestion: "baptiste",
      finalOwnerSuggestion: undefined,
      outcome: "cleared",
      sourceFamily: "synthesized-market",
      reason: "notion-alone, no corroboration"
    });
    // LLM (create/enrich step) ignored the gate and put baptiste back.
    const out = enforceRoutingOnDecision({
      gateDecision,
      llmOwnerDisplayName: "baptiste"
    });
    expect(out.finalOwnerDisplayName).toBeUndefined();
    expect(out.enforcement.kind).toBe("reject-llm-reroute");
    expect(out.enforcement.llmProposedOwner).toBe("baptiste");
    expect(out.enforcement.finalOwner).toBeUndefined();
    expect(out.enforcement.reason).toMatch(/rejected/);
  });

  it("rejects LLM re-assigning virginie after gate cleared it", () => {
    const gateDecision = makeAdjustment({
      originalOwnerSuggestion: "virginie",
      finalOwnerSuggestion: undefined,
      outcome: "cleared",
      sourceFamily: "synthesized-market"
    });
    const out = enforceRoutingOnDecision({
      gateDecision,
      llmOwnerDisplayName: "virginie"
    });
    expect(out.finalOwnerDisplayName).toBeUndefined();
    expect(out.enforcement.kind).toBe("reject-llm-reroute");
  });

  it("rejects LLM re-assigning linc-corporate after gate cleared it", () => {
    const gateDecision = makeAdjustment({
      originalOwnerSuggestion: "linc-corporate",
      finalOwnerSuggestion: undefined,
      outcome: "cleared",
      sourceFamily: "synthesized-market"
    });
    const out = enforceRoutingOnDecision({
      gateDecision,
      llmOwnerDisplayName: "linc-corporate"
    });
    expect(out.finalOwnerDisplayName).toBeUndefined();
    expect(out.enforcement.kind).toBe("reject-llm-reroute");
  });

  it("does NOT reject LLM choice of thomas after gate cleared baptiste", () => {
    // If the gate cleared baptiste but the LLM picked thomas instead, that's
    // a GOOD outcome — the LLM routed to a non-first-party-required owner.
    const gateDecision = makeAdjustment({
      originalOwnerSuggestion: "baptiste",
      finalOwnerSuggestion: undefined,
      outcome: "cleared",
      sourceFamily: "synthesized-market"
    });
    const out = enforceRoutingOnDecision({
      gateDecision,
      llmOwnerDisplayName: "thomas"
    });
    expect(out.finalOwnerDisplayName).toBe("thomas");
    expect(out.enforcement.kind).toBe("agreement");
  });

  it("overrides LLM choice when gate promoted to baptiste", () => {
    const gateDecision = makeAdjustment({
      originalOwnerSuggestion: "thomas",
      finalOwnerSuggestion: "baptiste",
      outcome: "promoted",
      sourceFamily: "first-party-work",
      hasFirstPartyCorroboration: true,
      corroboratingItemIds: ["linear:proof-1"]
    });
    // The create/enrich LLM, unaware of the gate, routes back to thomas.
    const out = enforceRoutingOnDecision({
      gateDecision,
      llmOwnerDisplayName: "thomas"
    });
    expect(out.finalOwnerDisplayName).toBe("baptiste");
    expect(out.enforcement.kind).toBe("override-llm-reroute");
    expect(out.enforcement.llmProposedOwner).toBe("thomas");
    expect(out.enforcement.finalOwner).toBe("baptiste");
    expect(out.enforcement.reason).toMatch(/baptiste/);
  });

  it("overrides when gate promoted to baptiste and LLM left it undefined", () => {
    const gateDecision = makeAdjustment({
      originalOwnerSuggestion: undefined,
      finalOwnerSuggestion: "baptiste",
      outcome: "promoted"
    });
    const out = enforceRoutingOnDecision({
      gateDecision,
      llmOwnerDisplayName: undefined
    });
    expect(out.finalOwnerDisplayName).toBe("baptiste");
    expect(out.enforcement.kind).toBe("override-llm-reroute");
  });

  it("respects LLM choice when gate is pass-through and they disagree", () => {
    // Gate default outcome is "kept" — advisory, not prescriptive. We should
    // not override in that case; the LLM has full context from create/enrich.
    const gateDecision = makeAdjustment({
      originalOwnerSuggestion: "thomas",
      finalOwnerSuggestion: "thomas",
      outcome: "kept"
    });
    const out = enforceRoutingOnDecision({
      gateDecision,
      llmOwnerDisplayName: "quentin"
    });
    expect(out.finalOwnerDisplayName).toBe("quentin");
    expect(out.enforcement.kind).toBe("agreement");
  });
});
