// ---------------------------------------------------------------------------
// HubSpot Signal Bridge Connector
//
// Reads SalesSignal and SalesExtractedFact records from the sales DB,
// applies the signal policy to determine which facts are eligible, and
// produces NormalizedSourceItem records for the intelligence pipeline.
//
// Key invariants:
// - Facts are the only emitted evidence units (signals are policy gates)
// - Each fact produces at most one canonical item: "hubspot-fact:{fact.id}"
// - Cursor advances only after all items are durably persisted (caller's job)
// - No raw CRM text (fact.sourceText) crosses the bridge
// - Enrich-only: no create-capable metadata is emitted
// ---------------------------------------------------------------------------

import { hashParts } from "../lib/ids.js";
import type { NormalizedSourceItem } from "../domain/types.js";
import {
  classifySignal,
  classifyFact,
  type PolicySignal,
  type PolicyFact
} from "./hubspot-signal-policy.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BATCH_SIZE = 100;

const CATEGORY_LABEL_MAP: Record<string, string> = {
  persona_stakeholder: "Champion identified",
  sentiment: "Positive commercial sentiment",
  competitor_reference: "Competitor mentioned",
  budget_sensitivity: "Budget surfaced",
  urgency_timing: "Urgent timeline",
  requested_capability: "Requested capability",
};

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export interface BridgeCursor {
  timestamp: string; // ISO 8601
  recordClass: "S" | "F";
  id: string;
}

export function parseCursor(raw: string | null): BridgeCursor | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length !== 3) return null;
  const [timestamp, recordClass, id] = parts;
  if (recordClass !== "S" && recordClass !== "F") return null;
  return { timestamp, recordClass, id };
}

export function serializeCursor(cursor: BridgeCursor): string {
  return `${cursor.timestamp}|${cursor.recordClass}|${cursor.id}`;
}

// ---------------------------------------------------------------------------
// Safe-field sanitization
// ---------------------------------------------------------------------------

export function sanitizeBridgeText(input: string, maxLen: number): string {
  return input
    .replace(/[\n\r\t]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// Unified record for single-slice batching
// ---------------------------------------------------------------------------

interface UnifiedRecord {
  timestamp: Date;
  recordClass: "S" | "F";
  id: string;
  signal?: SignalWithDeal;
  fact?: FactRecord;
}

/** Minimal signal shape from the DB (with deal context). */
export interface SignalWithDeal {
  id: string;
  signalType: string;
  dealId: string | null;
  confidence: string;
  detectedAt: Date;
  deal?: { dealName: string; stage: string } | null;
}

/** Minimal fact shape from the DB. */
export interface FactRecord {
  id: string;
  dealId: string;
  category: string;
  label: string;
  extractedValue: string;
  confidence: number;
  sourceText: string; // present in DB but NEVER crosses the bridge
  createdAt: Date;
}

/** Deal context for fact composition. */
interface DealContext {
  dealId: string;
  dealName: string;
  stage: string;
}

// ---------------------------------------------------------------------------
// Repository interface (decoupled from Prisma for testability)
// ---------------------------------------------------------------------------

export interface BridgeRepositories {
  /**
   * Load signals ordered ascending by (detectedAt, id).
   *
   * Two modes driven by whether `afterId` is provided:
   *
   * - **Same-class keyset** (`afterId` non-null): cursor ended on a signal,
   *   so we need `(detectedAt > T) OR (detectedAt = T AND id > afterId)`.
   *   This is correct keyset pagination that advances past same-timestamp
   *   records even when there are more than BATCH_SIZE of them.
   *
   * - **Cross-class GTE** (`afterId` null, `fromTimestamp` non-null): cursor
   *   ended on a fact, so all signals at T may still be unseen (signals sort
   *   before facts). Use `detectedAt >= T`.
   */
  listSignalsPage(
    companyId: string,
    fromTimestamp: Date | null,
    afterId: string | null,
    limit: number
  ): Promise<SignalWithDeal[]>;

  /**
   * Load standalone-eligible facts ordered ascending by (createdAt, id).
   *
   * Same two modes as listSignalsPage:
   * - `afterId` non-null → keyset: `(createdAt > T) OR (createdAt = T AND id > afterId)`
   * - `afterId` null → GTE: `createdAt >= T`
   */
  listStandaloneEligibleFactsPage(
    companyId: string,
    fromTimestamp: Date | null,
    afterId: string | null,
    limit: number
  ): Promise<FactRecord[]>;

  listExtractionsForDeal(dealId: string): Promise<FactRecord[]>;

  getDeal(dealId: string): Promise<{ dealName: string; stage: string } | null>;
}

// ---------------------------------------------------------------------------
// Bridge params & result
// ---------------------------------------------------------------------------

export interface HubSpotSignalBridgeParams {
  companyId: string;
  repos: BridgeRepositories;
  cursor: string | null;
  now: Date;
}

export interface BridgeStats {
  signalsScanned: number;
  signalsEligible: number;
  factsScanned: number;
  factsEligible: number;
  factsEmitted: number;
  dropped: number;
}

export interface HubSpotSignalBridgeResult {
  items: NormalizedSourceItem[];
  newCursor: string | null;
  stats: BridgeStats;
}

// ---------------------------------------------------------------------------
// Comparison for unified ordering: (timestamp, recordClass, id) ASC
//
// Signals ("S") sort BEFORE facts ("F") at the same timestamp.
// We use an explicit rank map because the ASCII values of "S" and "F"
// have the opposite natural order (F=70 < S=83).
// ---------------------------------------------------------------------------

const RECORD_CLASS_RANK: Record<string, number> = { S: 0, F: 1 };

function classRank(rc: string): number {
  return RECORD_CLASS_RANK[rc] ?? 99;
}

function compareUnified(a: UnifiedRecord, b: UnifiedRecord): number {
  const ta = a.timestamp.getTime();
  const tb = b.timestamp.getTime();
  if (ta !== tb) return ta - tb;
  const ra = classRank(a.recordClass);
  const rb = classRank(b.recordClass);
  if (ra !== rb) return ra - rb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isAfterCursor(rec: UnifiedRecord, cursor: BridgeCursor): boolean {
  const recTs = rec.timestamp.toISOString();
  if (recTs > cursor.timestamp) return true;
  if (recTs < cursor.timestamp) return false;
  const recRank = classRank(rec.recordClass);
  const cursorRank = classRank(cursor.recordClass);
  if (recRank > cursorRank) return true;
  if (recRank < cursorRank) return false;
  return rec.id > cursor.id;
}

// ---------------------------------------------------------------------------
// Compose a NormalizedSourceItem from an eligible fact
// ---------------------------------------------------------------------------

function composeBridgedItem(
  fact: PolicyFact & { createdAt: Date },
  dealContext: DealContext,
  gatingSignalType: string,
  companyId: string,
  now: Date,
  gatingSignalDetectedAt?: Date
): NormalizedSourceItem | null {
  const sourceItemId = `hubspot-fact:${fact.id}`;
  const categoryLabel = CATEGORY_LABEL_MAP[fact.category] ?? fact.category;
  const sanitizedValue = sanitizeBridgeText(fact.extractedValue, 150);
  const sanitizedDealName = sanitizeBridgeText(dealContext.dealName, 100);

  const title = sanitizeBridgeText(`${categoryLabel}: ${sanitizedValue}`, 200);
  const text = [
    title,
    "",
    `Deal: ${sanitizedDealName} (${dealContext.stage})`,
    `Category: ${fact.category}`,
    `Confidence: ${fact.confidence}`,
  ].join("\n").slice(0, 1500);

  if (text.trim().length < 20) return null;

  // For signal-gated facts, use the gating signal's detectedAt as occurredAt
  // when it is newer than the fact's own createdAt. This prevents old facts
  // unlocked by a recent signal from being dropped by the 30-day freshness
  // window in prefilterSourceItems().
  const occurredAt = gatingSignalDetectedAt && gatingSignalDetectedAt > fact.createdAt
    ? gatingSignalDetectedAt
    : fact.createdAt;

  return {
    source: "hubspot",
    sourceItemId,
    externalId: sourceItemId,
    sourceFingerprint: hashParts(["hubspot", sourceItemId]),
    sourceUrl: "",
    title,
    text,
    summary: title.slice(0, 300),
    occurredAt: occurredAt.toISOString(),
    ingestedAt: now.toISOString(),
    metadata: {
      hubspotFactCategory: fact.category,
      hubspotFactLabel: fact.label,
      hubspotGatingSignalType: gatingSignalType,
      hubspotDealId: dealContext.dealId,
      hubspotDealName: sanitizedDealName,
    },
    rawPayload: {
      factId: fact.id,
      category: fact.category,
      label: fact.label,
      confidence: fact.confidence,
      dealId: dealContext.dealId,
      dealName: sanitizedDealName,
      stage: dealContext.stage,
    },
    rawText: null,
  };
}

// ---------------------------------------------------------------------------
// Main bridge function
// ---------------------------------------------------------------------------

export async function fetchHubSpotSignalItems(
  params: HubSpotSignalBridgeParams
): Promise<HubSpotSignalBridgeResult> {
  const cursor = parseCursor(params.cursor);
  const stats: BridgeStats = {
    signalsScanned: 0,
    signalsEligible: 0,
    factsScanned: 0,
    factsEligible: 0,
    factsEmitted: 0,
    dropped: 0,
  };

  // 1-2. Load signals and standalone-eligible facts.
  //
  // Each query uses one of two modes depending on whether the cursor ended
  // on the same record class:
  //
  // - Same-class: keyset pagination (timestamp, id) > (cursorTs, cursorId)
  //   Correctly pages through >BATCH_SIZE records at the same timestamp.
  //
  // - Cross-class: GTE on timestamp (timestamp >= cursorTs)
  //   Ensures records from the other class at the cursor's timestamp are
  //   not skipped (signals sort before facts in the unified order).
  //   isAfterCursor does precise post-filtering for these.
  const cursorTs = cursor ? new Date(cursor.timestamp) : null;

  // Same-class gets afterId for keyset; cross-class gets null for GTE
  const signalAfterId = cursor?.recordClass === "S" ? cursor.id : null;
  const factAfterId = cursor?.recordClass === "F" ? cursor.id : null;

  const [signals, standaloneFacts] = await Promise.all([
    params.repos.listSignalsPage(
      params.companyId,
      cursorTs,
      signalAfterId,
      BATCH_SIZE
    ),
    params.repos.listStandaloneEligibleFactsPage(
      params.companyId,
      cursorTs,
      factAfterId,
      BATCH_SIZE
    ),
  ]);

  // 3. Merge into unified records
  const unified: UnifiedRecord[] = [
    ...signals.map((s): UnifiedRecord => ({
      timestamp: s.detectedAt,
      recordClass: "S",
      id: s.id,
      signal: s,
    })),
    ...standaloneFacts.map((f): UnifiedRecord => ({
      timestamp: f.createdAt,
      recordClass: "F",
      id: f.id,
      fact: f,
    })),
  ];

  // Filter out any records that don't strictly exceed the cursor
  // (handles the case where DB query returns boundary records)
  const filtered = cursor
    ? unified.filter((r) => isAfterCursor(r, cursor))
    : unified;

  // Sort ascending and take single slice
  filtered.sort(compareUnified);
  const slice = filtered.slice(0, BATCH_SIZE);

  if (slice.length === 0) {
    return { items: [], newCursor: params.cursor, stats };
  }

  // 4-5. Process the slice: signals unlock facts, standalone facts self-qualify
  // Map: factId → { fact (with createdAt), dealContext, gatingSignalType, gatingSignalDetectedAt }
  const eligibleFacts = new Map<string, {
    fact: PolicyFact & { createdAt: Date };
    dealContext: DealContext;
    gatingSignalType: string;
    gatingSignalDetectedAt?: Date;
  }>();

  for (const rec of slice) {
    if (rec.signal) {
      stats.signalsScanned++;
      const sig = rec.signal;

      if (!sig.dealId) continue;

      // Load ALL facts for this deal (not cursor-scoped — this is how old
      // evidence predating the cursor becomes reachable via newer gates)
      const dealFacts = await params.repos.listExtractionsForDeal(sig.dealId);

      const policySignal: PolicySignal = {
        id: sig.id,
        signalType: sig.signalType,
        dealId: sig.dealId,
        confidence: sig.confidence,
      };
      const policyFacts: PolicyFact[] = dealFacts.map((f) => ({
        id: f.id,
        category: f.category,
        label: f.label,
        extractedValue: f.extractedValue,
        confidence: f.confidence,
      }));

      const classification = classifySignal(policySignal, policyFacts);
      if (!classification.eligible) continue;

      stats.signalsEligible++;

      // Resolve deal context
      let dealContext: DealContext;
      if (sig.deal) {
        dealContext = { dealId: sig.dealId, dealName: sig.deal.dealName, stage: sig.deal.stage };
      } else {
        const deal = await params.repos.getDeal(sig.dealId);
        if (!deal) continue;
        dealContext = { dealId: sig.dealId, dealName: deal.dealName, stage: deal.stage };
      }

      // Add unlocked facts to the map (signal-gated takes priority)
      for (const factId of classification.unlockedFactIds) {
        const factRecord = dealFacts.find((f) => f.id === factId);
        if (!factRecord) continue;
        // Signal-gated always overwrites standalone if both exist
        eligibleFacts.set(factId, {
          fact: {
            id: factRecord.id,
            category: factRecord.category,
            label: factRecord.label,
            extractedValue: factRecord.extractedValue,
            confidence: factRecord.confidence,
            createdAt: factRecord.createdAt,
          },
          dealContext,
          gatingSignalType: sig.signalType,
          gatingSignalDetectedAt: sig.detectedAt,
        });
      }
    } else if (rec.fact) {
      stats.factsScanned++;
      const f = rec.fact;

      const policyFact: PolicyFact = {
        id: f.id,
        category: f.category,
        label: f.label,
        extractedValue: f.extractedValue,
        confidence: f.confidence,
      };

      if (classifyFact(policyFact) !== "enrich-eligible") continue;

      stats.factsEligible++;

      // Only add if not already signal-gated (signal takes priority)
      if (eligibleFacts.has(f.id)) continue;

      const deal = await params.repos.getDeal(f.dealId);
      if (!deal) continue;

      eligibleFacts.set(f.id, {
        fact: {
          id: f.id,
          category: f.category,
          label: f.label,
          extractedValue: f.extractedValue,
          confidence: f.confidence,
          createdAt: f.createdAt,
        },
        dealContext: { dealId: f.dealId, dealName: deal.dealName, stage: deal.stage },
        gatingSignalType: "standalone",
        // No gatingSignalDetectedAt for standalone — uses fact.createdAt
      });
    }
  }

  // 6-7. Compose NormalizedSourceItem for each unique eligible fact
  const items: NormalizedSourceItem[] = [];
  for (const entry of eligibleFacts.values()) {
    const item = composeBridgedItem(
      entry.fact,
      entry.dealContext,
      entry.gatingSignalType,
      params.companyId,
      params.now,
      entry.gatingSignalDetectedAt
    );
    if (item) {
      items.push(item);
      stats.factsEmitted++;
    } else {
      stats.dropped++;
    }
  }

  // 8. Compute newCursor from the last record in the input slice
  const lastRecord = slice[slice.length - 1];
  const newCursor = serializeCursor({
    timestamp: lastRecord.timestamp.toISOString(),
    recordClass: lastRecord.recordClass,
    id: lastRecord.id,
  });

  return { items, newCursor, stats };
}
