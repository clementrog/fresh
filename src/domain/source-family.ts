import type { NormalizedSourceItem } from "./types.js";

/**
 * Source family classification — a coarse "leverage" label for the origin
 * of a signal. Used by routing and evaluation to reason about first-party
 * proof vs synthesized market opinion.
 *
 *  - first-party-work:   internal company work (Linear, GitHub, Claap internal
 *                        retros, non-insight Notion pages, product/support
 *                        execution evidence)
 *  - field-proof:        prospect/customer evidence (HubSpot signals, Claap
 *                        sales/prospect calls)
 *  - synthesized-market: synthesized market insight with no direct first-party
 *                        origin (Notion market-insights pages, market-research
 *                        articles, market-findings files)
 *  - other:              anything else
 *
 * The classification is coarse on purpose — routing rules only need to know
 * whether a signal has first-party weight or is an assembled opinion about
 * the market.
 */
export type SourceFamily =
  | "first-party-work"
  | "field-proof"
  | "synthesized-market"
  | "other";

export function getSourceFamily(item: NormalizedSourceItem): SourceFamily {
  switch (item.source) {
    case "linear":
    case "github":
      return "first-party-work";

    case "claap": {
      // Claap sales/prospect calls are field-proof; internal retros, product
      // discussions, and signal cards are first-party-work.
      const routingDecision = typeof item.metadata?.routingDecision === "string"
        ? item.metadata.routingDecision
        : undefined;
      if (routingDecision === "prospect_call" || routingDecision === "sales_call") {
        return "field-proof";
      }
      const signalKind = typeof item.metadata?.signalKind === "string"
        ? item.metadata.signalKind
        : undefined;
      if (signalKind === "sales-call" || signalKind === "prospect-call") {
        return "field-proof";
      }
      return "first-party-work";
    }

    case "hubspot":
      return "field-proof";

    case "notion": {
      // Notion market-insight pages are synthesized opinion about the market.
      // Everything else coming through Notion (product specs, runbooks, meeting
      // notes, team docs) is internal first-party work.
      const notionKind = typeof item.metadata?.notionKind === "string"
        ? item.metadata.notionKind
        : undefined;
      return notionKind === "market-insight"
        ? "synthesized-market"
        : "first-party-work";
    }

    case "market-research":
    case "market-findings":
      return "synthesized-market";

    default:
      return "other";
  }
}

/** True if the family represents a signal with direct internal proof weight. */
export function isFirstPartyFamily(family: SourceFamily): boolean {
  return family === "first-party-work" || family === "field-proof";
}
