// ---------------------------------------------------------------------------
// HubSpot Signal Bridge — Policy Module
//
// Pure-function module: no I/O, no DB access. Classifies signals and facts
// to determine which upstream evidence units are eligible for bridging into
// the intelligence pipeline.
//
// Signals are policy gates — they unlock their constituent facts.
// Facts are the only emitted evidence units.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal signal shape required by the policy (avoids coupling to Prisma). */
export interface PolicySignal {
  id: string;
  signalType: string;
  dealId: string | null;
  confidence: string;
}

/** Minimal fact shape required by the policy (avoids coupling to Prisma). */
export interface PolicyFact {
  id: string;
  category: string;
  label: string;
  extractedValue: string;
  confidence: number;
}

export interface SignalClassification {
  eligible: boolean;
  unlockedFactIds: string[];
}

export type FactClassification = "enrich-eligible" | "ignore";

// ---------------------------------------------------------------------------
// Signal allowlist — closed set, anything not listed is rejected
// ---------------------------------------------------------------------------

const SIGNAL_ALLOWLIST = new Set([
  "positive_momentum",
  "champion_identified",
  "competitor_mentioned",
  "budget_surfaced",
  "urgent_timeline",
]);

// ---------------------------------------------------------------------------
// Signal → fact unlock filters
//
// Each filter references exact (category, label, extractedValue) conventions
// produced by fanOutFacts() in src/sales/services/extraction.ts:107-170.
// ---------------------------------------------------------------------------

type FactFilter = (fact: PolicyFact) => boolean;

const SIGNAL_FACT_FILTERS: Record<string, FactFilter> = {
  champion_identified: (f) =>
    f.category === "persona_stakeholder" && f.label === "champion",

  competitor_mentioned: (f) =>
    f.category === "competitor_reference",

  budget_surfaced: (f) =>
    f.category === "budget_sensitivity",

  urgent_timeline: (f) =>
    f.category === "urgency_timing"
    && f.label === "urgency_level"
    && f.extractedValue === "high",
};

// ---------------------------------------------------------------------------
// classifySignal
// ---------------------------------------------------------------------------

/**
 * Classify a signal and determine which supporting facts it unlocks.
 *
 * Returns `{ eligible: false, unlockedFactIds: [] }` for any signal type
 * not in the allowlist (including unknown/future types).
 */
export function classifySignal(
  signal: PolicySignal,
  supportingFacts: PolicyFact[]
): SignalClassification {
  if (!SIGNAL_ALLOWLIST.has(signal.signalType)) {
    return { eligible: false, unlockedFactIds: [] };
  }

  if (!signal.dealId) {
    return { eligible: false, unlockedFactIds: [] };
  }

  // positive_momentum has a compound eligibility condition:
  // requires BOTH champion AND positive sentiment facts
  if (signal.signalType === "positive_momentum") {
    const hasChampion = supportingFacts.some(
      (f) => f.category === "persona_stakeholder" && f.label === "champion"
    );
    const hasPositiveSentiment = supportingFacts.some(
      (f) => f.category === "sentiment" && f.label === "positive"
    );

    if (!hasChampion || !hasPositiveSentiment) {
      return { eligible: false, unlockedFactIds: [] };
    }

    // Unlock both champion and positive sentiment facts
    const unlocked = supportingFacts.filter(
      (f) =>
        (f.category === "persona_stakeholder" && f.label === "champion")
        || (f.category === "sentiment" && f.label === "positive")
    );
    return { eligible: true, unlockedFactIds: unlocked.map((f) => f.id) };
  }

  // All other allowlisted signals use their specific fact filter
  const filter = SIGNAL_FACT_FILTERS[signal.signalType];
  if (!filter) {
    // Defensive: allowlist entry without a filter → reject
    return { eligible: false, unlockedFactIds: [] };
  }

  const unlocked = supportingFacts.filter(filter);
  if (unlocked.length === 0) {
    // Signal is eligible type but no matching facts → not eligible
    return { eligible: false, unlockedFactIds: [] };
  }

  return { eligible: true, unlockedFactIds: unlocked.map((f) => f.id) };
}

// ---------------------------------------------------------------------------
// classifyFact (standalone eligibility — no gating signal required)
// ---------------------------------------------------------------------------

/**
 * Classify a fact for standalone eligibility (without a gating signal).
 *
 * Only `requested_capability` facts with high confidence are eligible.
 * All other categories return `"ignore"`.
 */
export function classifyFact(fact: PolicyFact): FactClassification {
  if (
    fact.category === "requested_capability"
    && fact.confidence >= 0.7
    && fact.extractedValue.trim().length > 0
  ) {
    return "enrich-eligible";
  }
  return "ignore";
}
