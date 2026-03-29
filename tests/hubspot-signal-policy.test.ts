import { describe, it, expect } from "vitest";
import {
  classifySignal,
  classifyFact,
  type PolicySignal,
  type PolicyFact,
} from "../src/connectors/hubspot-signal-policy.js";

// ---------------------------------------------------------------------------
// Fixtures — shaped by the exact (category, label, extractedValue) conventions
// from fanOutFacts() in src/sales/services/extraction.ts:107-170
// ---------------------------------------------------------------------------

function makeSignal(overrides?: Partial<PolicySignal>): PolicySignal {
  return {
    id: "sig-1",
    signalType: "champion_identified",
    dealId: "deal-1",
    confidence: "high",
    ...overrides,
  };
}

function makeFact(overrides?: Partial<PolicyFact>): PolicyFact {
  return {
    id: "fact-1",
    category: "persona_stakeholder",
    label: "champion",
    extractedValue: "Marie Dupont",
    confidence: 0.8,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifySignal — allowlisted signal types
// ---------------------------------------------------------------------------

describe("classifySignal", () => {
  describe("champion_identified", () => {
    it("returns eligible with champion facts unlocked", () => {
      const signal = makeSignal({ signalType: "champion_identified" });
      const facts = [
        makeFact({ id: "f1", category: "persona_stakeholder", label: "champion", extractedValue: "Marie Dupont" }),
        makeFact({ id: "f2", category: "objection_mentioned", label: "pain:integration-complexity", extractedValue: "integration complexity" }),
      ];
      const result = classifySignal(signal, facts);
      expect(result.eligible).toBe(true);
      expect(result.unlockedFactIds).toEqual(["f1"]);
    });

    it("returns not eligible when no champion facts exist", () => {
      const signal = makeSignal({ signalType: "champion_identified" });
      const facts = [
        makeFact({ id: "f1", category: "objection_mentioned", label: "pain:x", extractedValue: "x" }),
      ];
      const result = classifySignal(signal, facts);
      expect(result.eligible).toBe(false);
      expect(result.unlockedFactIds).toEqual([]);
    });
  });

  describe("competitor_mentioned", () => {
    it("returns eligible with competitor_reference facts unlocked", () => {
      const signal = makeSignal({ signalType: "competitor_mentioned" });
      const facts = [
        makeFact({ id: "f1", category: "competitor_reference", label: "acme-corp", extractedValue: "Acme Corp", confidence: 0.9 }),
        makeFact({ id: "f2", category: "competitor_reference", label: "beta-inc", extractedValue: "Beta Inc", confidence: 0.9 }),
      ];
      const result = classifySignal(signal, facts);
      expect(result.eligible).toBe(true);
      expect(result.unlockedFactIds).toEqual(["f1", "f2"]);
    });
  });

  describe("budget_surfaced", () => {
    it("returns eligible with budget_sensitivity facts unlocked", () => {
      const signal = makeSignal({ signalType: "budget_surfaced" });
      // ref extraction.ts:147-148: category="budget_sensitivity", label="budget_mentioned"
      const facts = [
        makeFact({ id: "f1", category: "budget_sensitivity", label: "budget_mentioned", extractedValue: "50k EUR allocated", confidence: 0.7 }),
      ];
      const result = classifySignal(signal, facts);
      expect(result.eligible).toBe(true);
      expect(result.unlockedFactIds).toEqual(["f1"]);
    });
  });

  describe("urgent_timeline", () => {
    it("returns eligible with high urgency fact unlocked", () => {
      const signal = makeSignal({ signalType: "urgent_timeline" });
      // ref extraction.ts:141-142: category="urgency_timing", label="urgency_level", extractedValue="high"
      const facts = [
        makeFact({ id: "f1", category: "urgency_timing", label: "urgency_level", extractedValue: "high", confidence: 0.7 }),
      ];
      const result = classifySignal(signal, facts);
      expect(result.eligible).toBe(true);
      expect(result.unlockedFactIds).toEqual(["f1"]);
    });

    it("does not unlock medium urgency facts", () => {
      const signal = makeSignal({ signalType: "urgent_timeline" });
      const facts = [
        makeFact({ id: "f1", category: "urgency_timing", label: "urgency_level", extractedValue: "medium", confidence: 0.7 }),
      ];
      const result = classifySignal(signal, facts);
      expect(result.eligible).toBe(false);
    });

    it("does not unlock next_step facts", () => {
      const signal = makeSignal({ signalType: "urgent_timeline" });
      // ref extraction.ts:138-139: label="next_step" is a different urgency_timing fact
      const facts = [
        makeFact({ id: "f1", category: "urgency_timing", label: "next_step", extractedValue: "send proposal", confidence: 0.7 }),
      ];
      const result = classifySignal(signal, facts);
      expect(result.eligible).toBe(false);
    });
  });

  describe("positive_momentum", () => {
    it("returns eligible when champion exists (positive sentiment not required)", () => {
      const signal = makeSignal({ signalType: "positive_momentum" });
      const facts = [
        makeFact({ id: "f1", category: "persona_stakeholder", label: "champion", extractedValue: "Marie Dupont" }),
        makeFact({ id: "f2", category: "sentiment", label: "positive", extractedValue: "positive", confidence: 0.9 }),
      ];
      const result = classifySignal(signal, facts);
      expect(result.eligible).toBe(true);
      // Only champion facts unlocked, not sentiment
      expect(result.unlockedFactIds).toEqual(["f1"]);
    });

    it("returns eligible with champion only (no sentiment facts at all)", () => {
      const signal = makeSignal({ signalType: "positive_momentum" });
      const facts = [
        makeFact({ id: "f1", category: "persona_stakeholder", label: "champion", extractedValue: "Marie Dupont" }),
      ];
      const result = classifySignal(signal, facts);
      expect(result.eligible).toBe(true);
      expect(result.unlockedFactIds).toEqual(["f1"]);
    });

    it("returns not eligible when only positive sentiment exists (no champion)", () => {
      const signal = makeSignal({ signalType: "positive_momentum" });
      const facts = [
        makeFact({ id: "f1", category: "sentiment", label: "positive", extractedValue: "positive" }),
      ];
      const result = classifySignal(signal, facts);
      expect(result.eligible).toBe(false);
    });

    it("returns eligible with champion even when sentiment is negative", () => {
      const signal = makeSignal({ signalType: "positive_momentum" });
      const facts = [
        makeFact({ id: "f1", category: "persona_stakeholder", label: "champion", extractedValue: "Marie" }),
        makeFact({ id: "f2", category: "sentiment", label: "negative", extractedValue: "negative" }),
      ];
      const result = classifySignal(signal, facts);
      expect(result.eligible).toBe(true);
      // Only champion unlocked, not the negative sentiment
      expect(result.unlockedFactIds).toEqual(["f1"]);
    });

    it("does not unlock sentiment facts (only champion)", () => {
      const signal = makeSignal({ signalType: "positive_momentum" });
      const facts = [
        makeFact({ id: "f1", category: "persona_stakeholder", label: "champion", extractedValue: "Marie" }),
        makeFact({ id: "f2", category: "sentiment", label: "positive", extractedValue: "positive" }),
        makeFact({ id: "f3", category: "sentiment", label: "negative", extractedValue: "negative" }),
      ];
      const result = classifySignal(signal, facts);
      expect(result.eligible).toBe(true);
      expect(result.unlockedFactIds).toEqual(["f1"]);
      expect(result.unlockedFactIds).not.toContain("f2");
      expect(result.unlockedFactIds).not.toContain("f3");
    });
  });

  // --- Explicitly ignored signal types ---

  describe("ignored signal types", () => {
    const ignoredTypes = [
      "deal_stale",
      "deal_going_cold",
      "next_step_missing",
      "blocker_identified",
      "negative_momentum",
      "lead_engaged",
      "lead_ready_for_deal",
      "lead_re_engaged",
    ];

    for (const signalType of ignoredTypes) {
      it(`rejects ${signalType}`, () => {
        const signal = makeSignal({ signalType });
        const facts = [
          makeFact({ id: "f1", category: "persona_stakeholder", label: "champion", extractedValue: "Marie" }),
          makeFact({ id: "f2", category: "sentiment", label: "positive", extractedValue: "positive" }),
          makeFact({ id: "f3", category: "competitor_reference", label: "acme", extractedValue: "Acme" }),
          makeFact({ id: "f4", category: "budget_sensitivity", label: "budget_mentioned", extractedValue: "100k" }),
        ];
        const result = classifySignal(signal, facts);
        expect(result.eligible).toBe(false);
        expect(result.unlockedFactIds).toEqual([]);
      });
    }
  });

  // --- Unknown signal types ---

  it("rejects unknown/future signal types", () => {
    const signal = makeSignal({ signalType: "some_future_type" });
    const facts = [makeFact()];
    const result = classifySignal(signal, facts);
    expect(result.eligible).toBe(false);
    expect(result.unlockedFactIds).toEqual([]);
  });

  it("rejects empty string signal type", () => {
    const signal = makeSignal({ signalType: "" });
    const result = classifySignal(signal, []);
    expect(result.eligible).toBe(false);
  });

  // --- Null dealId ---

  it("rejects signal with null dealId", () => {
    const signal = makeSignal({ dealId: null });
    const facts = [makeFact()];
    const result = classifySignal(signal, facts);
    expect(result.eligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyFact — standalone eligibility
// ---------------------------------------------------------------------------

describe("classifyFact", () => {
  it("returns enrich-eligible for requested_capability with confidence >= 0.7", () => {
    // ref extraction.ts:159-160: category="requested_capability", label=slugify(rc), extractedValue=rc
    const fact = makeFact({
      category: "requested_capability",
      label: "automated-payroll-processing",
      extractedValue: "automated payroll processing",
      confidence: 0.8,
    });
    expect(classifyFact(fact)).toBe("enrich-eligible");
  });

  it("returns enrich-eligible for requested_capability at exactly 0.7 confidence", () => {
    const fact = makeFact({
      category: "requested_capability",
      label: "api-integration",
      extractedValue: "API integration",
      confidence: 0.7,
    });
    expect(classifyFact(fact)).toBe("enrich-eligible");
  });

  it("returns ignore for requested_capability with confidence < 0.7", () => {
    const fact = makeFact({
      category: "requested_capability",
      label: "some-feature",
      extractedValue: "some feature",
      confidence: 0.6,
    });
    expect(classifyFact(fact)).toBe("ignore");
  });

  it("returns ignore for requested_capability with empty extractedValue", () => {
    const fact = makeFact({
      category: "requested_capability",
      label: "empty",
      extractedValue: "",
      confidence: 0.8,
    });
    expect(classifyFact(fact)).toBe("ignore");
  });

  it("returns ignore for requested_capability with whitespace-only extractedValue", () => {
    const fact = makeFact({
      category: "requested_capability",
      label: "whitespace",
      extractedValue: "   ",
      confidence: 0.8,
    });
    expect(classifyFact(fact)).toBe("ignore");
  });

  it("returns ignore for single-word requested_capability (too vague)", () => {
    const fact = makeFact({
      category: "requested_capability",
      label: "payroll",
      extractedValue: "payroll",
      confidence: 0.8,
    });
    expect(classifyFact(fact)).toBe("ignore");
  });

  it("returns enrich-eligible for two-word requested_capability", () => {
    const fact = makeFact({
      category: "requested_capability",
      label: "absence-management",
      extractedValue: "absence management",
      confidence: 0.8,
    });
    expect(classifyFact(fact)).toBe("enrich-eligible");
  });

  it("returns ignore for single compound word with slash (still one token)", () => {
    const fact = makeFact({
      category: "requested_capability",
      label: "modernite-ergonomie",
      extractedValue: "modernité/ergonomie",
      confidence: 0.8,
    });
    expect(classifyFact(fact)).toBe("ignore");
  });

  // All non-requested_capability categories are ignored
  const nonEligibleCategories = [
    "objection_mentioned",
    "competitor_reference",
    "urgency_timing",
    "budget_sensitivity",
    "persona_stakeholder",
    "compliance_security",
    "sentiment",
  ];

  for (const category of nonEligibleCategories) {
    it(`returns ignore for ${category} (not standalone-eligible)`, () => {
      const fact = makeFact({
        category,
        label: "test",
        extractedValue: "test value",
        confidence: 0.9,
      });
      expect(classifyFact(fact)).toBe("ignore");
    });
  }

  it("returns ignore for unknown category", () => {
    const fact = makeFact({
      category: "unknown_future_category",
      label: "test",
      extractedValue: "test value",
      confidence: 0.9,
    });
    expect(classifyFact(fact)).toBe("ignore");
  });
});
