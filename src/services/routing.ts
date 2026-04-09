/**
 * Deterministic post-screening routing gate.
 *
 * The screening LLM proposes an `ownerSuggestion` for each retained signal.
 * This gate applies two non-LLM rules before the create/enrich step sees
 * that suggestion:
 *
 *  1. Source leverage — synthesized-market signals (Notion market-insights,
 *     market-research articles, market-findings files) cannot drive the
 *     founder (baptiste), product-lead (virginie), or corporate
 *     (linc-corporate) voices on their own. They must be corroborated by
 *     at least one first-party or field signal covering the same subject.
 *
 *  2. Structural promotion — when the screening LLM flags a signal as
 *     `hasStructuralSignificance = true` AND there is first-party
 *     corroboration, routing may promote the owner to baptiste (the
 *     structural-reading voice) even if the LLM suggested an
 *     operationally-shaped owner like thomas or quentin.
 *
 * The gate is deterministic, audit-friendly, and reason-tagged. All calls
 * produce a `RoutingAdjustment` that can be persisted as telemetry.
 *
 * This file intentionally does NOT call an LLM. It only consumes the
 * already-parsed screening result plus a list of candidate corroborating
 * items.
 */
import type { NormalizedSourceItem, ScreeningResult } from "../domain/types.js";
import { getSourceFamily, isFirstPartyFamily, type SourceFamily } from "../domain/source-family.js";
import { jaccardSimilarity, removeStopWords, tokenizeV2 } from "../lib/text.js";

/** Owners that require first-party proof to be driven by a synthesized-market signal. */
export const FIRST_PARTY_REQUIRED_OWNERS = new Set<string>([
  "baptiste",
  "virginie",
  "linc-corporate"
]);

/**
 * Owners that the structural-reading promotion can route toward.
 * We only promote to baptiste today — the CEO/founder voice is the one with
 * explicit structural territory.
 */
export const STRUCTURAL_PROMOTION_TARGET = "baptiste";

/**
 * Owners whose territory is purely operational/concrete — a structural
 * reading is NOT their job. We can safely promote away from these when
 * `hasStructuralSignificance` is true and corroboration exists.
 */
const STRUCTURAL_PROMOTION_SOURCES = new Set<string>(["thomas", "quentin"]);

/** Minimum Jaccard score for a candidate to count as corroboration. */
export const CORROBORATION_MIN_JACCARD = 0.08;
/** Max corroborating items returned per call (keeps telemetry bounded). */
export const CORROBORATION_MAX_MATCHES = 3;

export type RoutingOutcome = "kept" | "changed" | "cleared" | "promoted";

export interface RoutingAdjustment {
  /** Owner originally suggested by the screening LLM (may be undefined). */
  originalOwnerSuggestion?: string;
  /** Owner after gate application (undefined if the gate cleared it). */
  finalOwnerSuggestion?: string;
  outcome: RoutingOutcome;
  /** Human-readable explanation suitable for logs and audit UI. */
  reason: string;
  sourceFamily: SourceFamily;
  hasFirstPartyCorroboration: boolean;
  /** externalIds of the corroborating source items (may be empty). */
  corroboratingItemIds: string[];
}

/**
 * Apply the deterministic routing rules. Pure function — does not mutate
 * its inputs and does not touch the LLM or DB.
 */
export function adjustOwnerRouting(params: {
  item: NormalizedSourceItem;
  screening: ScreeningResult;
  corroboratingItems: NormalizedSourceItem[];
}): RoutingAdjustment {
  const sourceFamily = getSourceFamily(params.item);
  const original = params.screening.ownerSuggestion;
  const hasCorroboration = params.corroboratingItems.length > 0;
  const corroboratingIds = params.corroboratingItems.map((i) => i.externalId);

  // --- Rule 1: synthesized-market cannot drive first-party-required owners ---
  if (
    sourceFamily === "synthesized-market" &&
    original !== undefined &&
    FIRST_PARTY_REQUIRED_OWNERS.has(original) &&
    !hasCorroboration
  ) {
    return {
      originalOwnerSuggestion: original,
      finalOwnerSuggestion: undefined,
      outcome: "cleared",
      reason:
        `Routing gate: "${original}" requires first-party or field corroboration when the source is synthesized-market; none found in the current window.`,
      sourceFamily,
      hasFirstPartyCorroboration: false,
      corroboratingItemIds: corroboratingIds
    };
  }

  // --- Rule 2: structural promotion toward baptiste ---
  // Promote when the screening LLM judged structural significance AND we
  // have first-party evidence AND the LLM-suggested owner is either empty
  // or a purely operational voice (thomas/quentin).
  if (
    params.screening.hasStructuralSignificance === true &&
    hasCorroboration &&
    (original === undefined || STRUCTURAL_PROMOTION_SOURCES.has(original))
  ) {
    if (original === STRUCTURAL_PROMOTION_TARGET) {
      return {
        originalOwnerSuggestion: original,
        finalOwnerSuggestion: original,
        outcome: "kept",
        reason: `Routing gate: structural significance confirmed; ${original} kept.`,
        sourceFamily,
        hasFirstPartyCorroboration: true,
        corroboratingItemIds: corroboratingIds
      };
    }
    return {
      originalOwnerSuggestion: original,
      finalOwnerSuggestion: STRUCTURAL_PROMOTION_TARGET,
      outcome: "promoted",
      reason:
        `Routing gate: structural significance + ${corroboratingIds.length} first-party corroboration(s) → promoted to ${STRUCTURAL_PROMOTION_TARGET} (was ${original ?? "unset"}).`,
      sourceFamily,
      hasFirstPartyCorroboration: true,
      corroboratingItemIds: corroboratingIds
    };
  }

  // --- Default: pass-through ---
  return {
    originalOwnerSuggestion: original,
    finalOwnerSuggestion: original,
    outcome: "kept",
    reason: hasCorroboration
      ? `Routing gate: pass-through (owner=${original ?? "unset"}, source=${sourceFamily}, corroboration=${corroboratingIds.length})`
      : `Routing gate: pass-through (owner=${original ?? "unset"}, source=${sourceFamily}, no corroboration)`,
    sourceFamily,
    hasFirstPartyCorroboration: hasCorroboration,
    corroboratingItemIds: corroboratingIds
  };
}

/**
 * Find first-party-work or field-proof source items that share meaningful
 * token overlap with the given item. The gate uses the returned list to
 * decide whether a synthesized-market item can drive first-party-required
 * owners, and whether a structural promotion is defensible.
 *
 * Deterministic, LLM-free. Reuses the existing Jaccard helpers from
 * `src/lib/text.ts` for consistency with dedup and duplicate-review logic.
 */
export function findFirstPartyCorroboration(params: {
  item: NormalizedSourceItem;
  candidateItems: NormalizedSourceItem[];
}): NormalizedSourceItem[] {
  const baseText = `${params.item.title} ${params.item.summary} ${params.item.text.slice(0, 1500)}`;
  const baseSet = new Set(removeStopWords(tokenizeV2(baseText)));
  if (baseSet.size === 0) return [];

  const scored: Array<{ item: NormalizedSourceItem; score: number }> = [];
  for (const candidate of params.candidateItems) {
    if (candidate.externalId === params.item.externalId) continue;
    const family = getSourceFamily(candidate);
    if (!isFirstPartyFamily(family)) continue;
    const candidateText =
      `${candidate.title} ${candidate.summary} ${candidate.text.slice(0, 1500)}`;
    const candidateSet = new Set(removeStopWords(tokenizeV2(candidateText)));
    const score = jaccardSimilarity(baseSet, candidateSet);
    if (score >= CORROBORATION_MIN_JACCARD) {
      scored.push({ item: candidate, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, CORROBORATION_MAX_MATCHES).map((s) => s.item);
}

/** Telemetry event emitted per retained item by the pipeline. */
export interface RoutingEvent {
  sourceItemId: string;
  sourceFamily: SourceFamily;
  originalOwnerSuggestion?: string;
  finalOwnerSuggestion?: string;
  outcome: RoutingOutcome;
  reason: string;
  hasFirstPartyCorroboration: boolean;
  corroboratingItemIds: string[];
  /** True when screening flagged the signal as structurally significant. */
  hasStructuralSignificance?: boolean;
  /** Filled AFTER the create/enrich LLM runs, when the enforcement step
   *  reconciles the LLM-returned `ownerDisplayName` with the gate's decision.
   *  Absent when the LLM already agreed with the gate or when no item reached
   *  the create/enrich step (skipped by publishability, enrich-only, etc). */
  enforcement?: RoutingEnforcement;
}

/**
 * Result of the post-LLM enforcement step. Captures what the LLM proposed
 * and what the gate enforced as the final owner.
 */
export interface RoutingEnforcement {
  kind: "agreement" | "reject-llm-reroute" | "override-llm-reroute";
  llmProposedOwner?: string;
  finalOwner?: string;
  reason: string;
}

/**
 * Helper kept separate from `adjustOwnerRouting` so callers that already
 * have EvidenceReference lists (e.g. tests) can build a minimal pipeline
 * without needing a full NormalizedSourceItem window.
 */
export function buildRoutingEvent(params: {
  item: NormalizedSourceItem;
  screening: ScreeningResult;
  adjustment: RoutingAdjustment;
}): RoutingEvent {
  return {
    sourceItemId: params.item.externalId,
    sourceFamily: params.adjustment.sourceFamily,
    originalOwnerSuggestion: params.adjustment.originalOwnerSuggestion,
    finalOwnerSuggestion: params.adjustment.finalOwnerSuggestion,
    outcome: params.adjustment.outcome,
    reason: params.adjustment.reason,
    hasFirstPartyCorroboration: params.adjustment.hasFirstPartyCorroboration,
    corroboratingItemIds: params.adjustment.corroboratingItemIds,
    hasStructuralSignificance: params.screening.hasStructuralSignificance
  };
}

/**
 * Post-LLM enforcement step. Reconciles the `ownerDisplayName` returned by
 * the create/enrich LLM against the routing gate's decision.
 *
 * The gate runs BEFORE the create/enrich call and mutates
 * `screening.ownerSuggestion` to its authoritative value. But the
 * create/enrich LLM can still return ANY `ownerDisplayName` — including one
 * the gate cleared or a different owner than the gate promoted to. Without
 * this enforcement step, the gate's decision is merely advisory and the
 * final published voice is whatever the last LLM call happens to pick.
 *
 * Rules (applied in order):
 *
 *  1. **Agreement** — if the LLM's choice matches the gate's routed owner
 *     (or both are undefined), no change. Emit `kind="agreement"`.
 *
 *  2. **Reject-and-clear** — the gate CLEARED the owner (set `undefined`
 *     because a first-party-required owner had no corroboration) but the
 *     LLM re-assigned that same first-party-required owner. Reject the
 *     LLM's choice and clear `ownerDisplayName`. The opportunity is
 *     created without a forced voice; an operator can assign one later.
 *     Emit `kind="reject-llm-reroute"`.
 *
 *  3. **Override** — the gate routed to a specific owner (usually a
 *     structural promotion to baptiste) but the LLM picked a different
 *     owner. Override to the gate's choice. Emit `kind="override-llm-reroute"`.
 *
 *  4. **Agreement (fallback)** — any other divergence is treated as
 *     agreement with a diagnostic reason, because the gate's default
 *     outcome is pass-through and we should not override pass-throughs.
 *
 * Pure function: does not mutate its inputs. Returns the reconciled
 * `finalOwnerDisplayName` plus an enforcement record for telemetry.
 */
export function enforceRoutingOnDecision(params: {
  gateDecision: RoutingAdjustment;
  llmOwnerDisplayName?: string;
}): { finalOwnerDisplayName?: string; enforcement: RoutingEnforcement } {
  const gateRouted = params.gateDecision.finalOwnerSuggestion;
  const llmChose = params.llmOwnerDisplayName;

  // Rule 1: exact agreement (including both undefined)
  if (gateRouted === llmChose) {
    return {
      finalOwnerDisplayName: llmChose,
      enforcement: {
        kind: "agreement",
        llmProposedOwner: llmChose,
        finalOwner: llmChose,
        reason: "LLM and routing gate agreed on the owner."
      }
    };
  }

  // Rule 2: gate cleared AND the LLM re-assigned a first-party-required owner
  if (params.gateDecision.outcome === "cleared" && llmChose && FIRST_PARTY_REQUIRED_OWNERS.has(llmChose)) {
    return {
      finalOwnerDisplayName: undefined,
      enforcement: {
        kind: "reject-llm-reroute",
        llmProposedOwner: llmChose,
        finalOwner: undefined,
        reason: `Gate cleared first-party-required owner "${params.gateDecision.originalOwnerSuggestion}" (no corroboration). LLM re-assigned "${llmChose}" — rejected; left unset for operator assignment.`
      }
    };
  }

  // Rule 3: gate promoted to a specific owner (usually baptiste) and the LLM disagreed
  if (params.gateDecision.outcome === "promoted" && gateRouted !== undefined) {
    return {
      finalOwnerDisplayName: gateRouted,
      enforcement: {
        kind: "override-llm-reroute",
        llmProposedOwner: llmChose,
        finalOwner: gateRouted,
        reason: `Gate promoted to "${gateRouted}" (structural + corroboration). LLM picked "${llmChose ?? "(unset)"}" — overriding.`
      }
    };
  }

  // Rule 4: pass-through mismatch — the gate's default is "kept" which is
  // advisory, so we do NOT override non-promotion gate decisions. Record
  // the divergence for audit but keep the LLM's choice.
  return {
    finalOwnerDisplayName: llmChose,
    enforcement: {
      kind: "agreement",
      llmProposedOwner: llmChose,
      finalOwner: llmChose,
      reason: `Gate outcome "${params.gateDecision.outcome}" is advisory; LLM choice "${llmChose ?? "(unset)"}" retained.`
    }
  };
}

