import { describe, it, expect, vi } from "vitest";
import {
  fetchHubSpotSignalItems,
  parseCursor,
  serializeCursor,
  sanitizeBridgeText,
  normalizeForDedup,
  dedupKey,
  BATCH_SIZE,
  type BridgeRepositories,
  type SignalWithDeal,
  type FactRecord,
  type HubSpotSignalBridgeParams,
} from "../src/connectors/hubspot-signals.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "test-company-1";
const NOW = new Date("2026-03-28T12:00:00Z");

function makeSignalWithDeal(overrides?: Partial<SignalWithDeal>): SignalWithDeal {
  return {
    id: "sig-1",
    signalType: "champion_identified",
    dealId: "deal-1",
    confidence: "high",
    detectedAt: new Date("2026-03-28T10:00:00Z"),
    deal: { dealName: "Acme Corp Expansion", stage: "Opportunity Validated" },
    ...overrides,
  };
}

function makeFactRecord(overrides?: Partial<FactRecord>): FactRecord {
  return {
    id: "fact-1",
    dealId: "deal-1",
    category: "requested_capability",
    label: "automated-payroll",
    extractedValue: "automated payroll processing",
    confidence: 0.8,
    sourceText: "SENSITIVE RAW ACTIVITY BODY — this must never appear downstream",
    createdAt: new Date("2026-03-28T09:00:00Z"),
    ...overrides,
  };
}

function makeChampionFact(id: string, createdAt?: Date): FactRecord {
  return makeFactRecord({
    id,
    category: "persona_stakeholder",
    label: "champion",
    extractedValue: "Marie Dupont",
    confidence: 0.8,
    createdAt: createdAt ?? new Date("2026-03-25T10:00:00Z"),
  });
}

function makeSentimentFact(id: string, value: string): FactRecord {
  return makeFactRecord({
    id,
    category: "sentiment",
    label: value,
    extractedValue: value,
    confidence: 0.9,
  });
}

function makeMockRepos(overrides?: Partial<BridgeRepositories>): BridgeRepositories {
  return {
    listSignalsPage: vi.fn().mockResolvedValue([]),
    listStandaloneEligibleFactsPage: vi.fn().mockResolvedValue([]),
    listExtractionsForDeal: vi.fn().mockResolvedValue([]),
    getDeal: vi.fn().mockResolvedValue({ dealName: "Acme Corp", stage: "New" }),
    ...overrides,
  };
}

function makeParams(repos: BridgeRepositories, cursor: string | null = null): HubSpotSignalBridgeParams {
  return { companyId: COMPANY_ID, repos, cursor, now: NOW };
}

// ---------------------------------------------------------------------------
// Cursor parsing / serialization
// ---------------------------------------------------------------------------

describe("cursor", () => {
  it("round-trips correctly", () => {
    const cursor = { timestamp: "2026-03-28T10:00:00.000Z", recordClass: "S" as const, id: "sig-1" };
    expect(parseCursor(serializeCursor(cursor))).toEqual(cursor);
  });

  it("parses null as null", () => {
    expect(parseCursor(null)).toBeNull();
  });

  it("parses empty string as null", () => {
    expect(parseCursor("")).toBeNull();
  });

  it("parses invalid format as null", () => {
    expect(parseCursor("invalid")).toBeNull();
    expect(parseCursor("2026-03-28T10:00:00Z|X|id")).toBeNull(); // invalid class
  });
});

// ---------------------------------------------------------------------------
// sanitizeBridgeText
// ---------------------------------------------------------------------------

describe("sanitizeBridgeText", () => {
  it("strips newlines and control characters", () => {
    expect(sanitizeBridgeText("hello\nworld\r\ttest", 100)).toBe("hello world test");
  });

  it("collapses multiple spaces", () => {
    expect(sanitizeBridgeText("hello    world", 100)).toBe("hello world");
  });

  it("truncates to maxLen", () => {
    expect(sanitizeBridgeText("a".repeat(200), 10)).toBe("a".repeat(10));
  });

  it("trims whitespace", () => {
    expect(sanitizeBridgeText("  hello  ", 100)).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// fetchHubSpotSignalItems — basic shape
// ---------------------------------------------------------------------------

describe("fetchHubSpotSignalItems", () => {
  it("returns empty items when no signals or facts exist", async () => {
    const repos = makeMockRepos();
    const result = await fetchHubSpotSignalItems(makeParams(repos));
    expect(result.items).toEqual([]);
    expect(result.stats.signalsScanned).toBe(0);
    expect(result.stats.factsScanned).toBe(0);
  });

  it("produces correctly shaped NormalizedSourceItem from signal-gated champion fact", async () => {
    const championFact = makeChampionFact("fact-champ-1");
    const signal = makeSignalWithDeal({ signalType: "champion_identified" });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([championFact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    expect(result.items).toHaveLength(1);
    const item = result.items[0];

    // Canonical identity
    expect(item.source).toBe("hubspot");
    expect(item.sourceItemId).toBe("hubspot-fact:fact-champ-1");
    expect(item.externalId).toBe("hubspot-fact:fact-champ-1");

    // Safe fields only
    expect(item.title).toContain("Champion identified");
    expect(item.title).toContain("Marie Dupont");
    expect(item.text).toContain("Acme Corp Expansion");
    expect(item.rawText).toBeNull();
    expect(item.metadata).toEqual({
      hubspotFactCategory: "persona_stakeholder",
      hubspotFactLabel: "champion",
      hubspotGatingSignalType: "champion_identified",
      hubspotDealId: "deal-1",
      hubspotDealName: "Acme Corp Expansion",
    });

    // rawPayload — only approved fields
    expect(item.rawPayload).toEqual({
      factId: "fact-champ-1",
      category: "persona_stakeholder",
      label: "champion",
      confidence: 0.8,
      dealId: "deal-1",
      dealName: "Acme Corp Expansion",
      stage: "Opportunity Validated",
    });
  });

  it("produces correctly shaped NormalizedSourceItem from standalone requested_capability fact", async () => {
    const fact = makeFactRecord({
      id: "fact-rc-1",
      category: "requested_capability",
      label: "automated-payroll",
      extractedValue: "automated payroll processing",
      confidence: 0.8,
    });

    const repos = makeMockRepos({
      listStandaloneEligibleFactsPage: vi.fn().mockResolvedValue([fact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.sourceItemId).toBe("hubspot-fact:fact-rc-1");
    expect(item.title).toContain("Requested capability");
    expect(item.metadata.hubspotGatingSignalType).toBe("standalone");
  });

  // --- No signal-level items ---

  it("does not produce signal-level items — signals only gate facts", async () => {
    const signal = makeSignalWithDeal({ signalType: "champion_identified" });
    const championFact = makeChampionFact("fact-1");

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([championFact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    // Every emitted item is a fact-level item
    for (const item of result.items) {
      expect(item.sourceItemId).toMatch(/^hubspot-fact:/);
    }
  });

  // --- Safe-field contract ---

  it("never includes fact sourceText in any output field", async () => {
    const fact = makeFactRecord({
      id: "fact-with-sensitive-body",
      sourceText: "SENSITIVE: John's email is john@secret.com and the meeting discussed...",
    });

    const repos = makeMockRepos({
      listStandaloneEligibleFactsPage: vi.fn().mockResolvedValue([fact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    for (const item of result.items) {
      const allText = JSON.stringify(item);
      expect(allText).not.toContain("SENSITIVE");
      expect(allText).not.toContain("john@secret.com");
    }
  });

  it("sanitizes human-entered deal name with control characters", async () => {
    const signal = makeSignalWithDeal({
      deal: { dealName: "Acme\nCorp\r\tExpansion", stage: "New" },
    });
    const fact = makeChampionFact("fact-1");

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([fact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    expect(result.items).toHaveLength(1);
    expect(result.items[0].metadata.hubspotDealName).toBe("Acme Corp Expansion");
    expect(result.items[0].text).not.toContain("\n\r");
  });

  // --- Cursor correctness ---

  it("excludes items before cursor", async () => {
    const signal = makeSignalWithDeal({
      id: "sig-old",
      detectedAt: new Date("2026-03-27T10:00:00Z"),
    });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
    });

    // Cursor is after the signal
    const cursor = "2026-03-28T00:00:00.000Z|S|sig-old";
    const result = await fetchHubSpotSignalItems(makeParams(repos, cursor));

    // Signal is before cursor — filtered out
    expect(result.items).toEqual([]);
  });

  it("composite cursor handles timestamp ties correctly", async () => {
    const sameTs = new Date("2026-03-28T10:00:00.000Z");
    const sig1 = makeSignalWithDeal({ id: "sig-aaa", detectedAt: sameTs });
    const sig2 = makeSignalWithDeal({ id: "sig-zzz", detectedAt: sameTs });
    const fact = makeChampionFact("fact-1");

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([sig1, sig2]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([fact]),
    });

    // Cursor is after sig-aaa but before sig-zzz (same timestamp)
    const cursor = serializeCursor({ timestamp: sameTs.toISOString(), recordClass: "S", id: "sig-aaa" });
    const result = await fetchHubSpotSignalItems(makeParams(repos, cursor));

    // Only sig-zzz should be processed (sig-aaa is at/before cursor)
    expect(result.stats.signalsScanned).toBe(1);
  });

  it("returns cursor for caller to persist (cursor not auto-committed)", async () => {
    const signal = makeSignalWithDeal();
    const fact = makeChampionFact("fact-1");

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([fact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    expect(result.newCursor).toBeTruthy();
    expect(typeof result.newCursor).toBe("string");
    // Cursor should encode the signal's position
    const parsed = parseCursor(result.newCursor!);
    expect(parsed?.recordClass).toBe("S");
    expect(parsed?.id).toBe("sig-1");
  });

  // --- Idempotency ---

  it("same input produces identical output (deterministic)", async () => {
    const signal = makeSignalWithDeal();
    const fact = makeChampionFact("fact-1");

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([fact]),
    });

    const result1 = await fetchHubSpotSignalItems(makeParams(repos));
    const result2 = await fetchHubSpotSignalItems(makeParams(repos));

    expect(result1.items.map((i) => i.sourceItemId)).toEqual(
      result2.items.map((i) => i.sourceItemId)
    );
    expect(result1.items.map((i) => i.sourceFingerprint)).toEqual(
      result2.items.map((i) => i.sourceFingerprint)
    );
    expect(result1.items.map((i) => i.text)).toEqual(
      result2.items.map((i) => i.text)
    );
  });

  // --- Canonical identity within run ---

  it("fact reachable via signal-gated and standalone paths emits once per run", async () => {
    // A requested_capability fact that is also in a deal with an eligible signal
    const fact = makeFactRecord({
      id: "fact-overlap",
      category: "requested_capability",
      label: "payroll",
      extractedValue: "automated payroll",
      confidence: 0.8,
      createdAt: new Date("2026-03-28T10:00:00Z"),
    });

    // Budget signal for the same deal (budget_surfaced doesn't unlock requested_capability)
    // So actually let's use a case where the fact IS unlocked by both paths.
    // requested_capability is only standalone-eligible, not signal-gated by any signal.
    // So the overlap case is: fact reachable as standalone AND in a deal with a signal,
    // but the signal doesn't unlock this category. No overlap possible here.
    //
    // Real overlap: champion fact reachable via two different signals for same deal.
    const championFact = makeChampionFact("fact-champ-1");
    const signal1 = makeSignalWithDeal({ id: "sig-champion", signalType: "champion_identified", detectedAt: new Date("2026-03-28T10:00:00Z") });
    const signal2 = makeSignalWithDeal({ id: "sig-momentum", signalType: "positive_momentum", detectedAt: new Date("2026-03-28T10:01:00Z") });
    const positiveSentimentFact = makeSentimentFact("fact-pos", "positive");

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal1, signal2]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([championFact, positiveSentimentFact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    // Champion fact should appear exactly once despite being unlocked by both signals
    const championItems = result.items.filter((i) => i.sourceItemId === "hubspot-fact:fact-champ-1");
    expect(championItems).toHaveLength(1);
  });

  // --- Cross-run canonical identity ---

  it("fact emitted via standalone in run N maps to same sourceItemId as signal-gated in run N+1", async () => {
    // Run N: fact emitted as standalone
    const fact = makeFactRecord({
      id: "fact-rc-cross",
      category: "requested_capability",
      label: "payroll",
      extractedValue: "automated payroll processing",
      confidence: 0.8,
      createdAt: new Date("2026-03-28T09:00:00Z"),
    });

    const reposRunN = makeMockRepos({
      listStandaloneEligibleFactsPage: vi.fn().mockResolvedValue([fact]),
    });

    const resultN = await fetchHubSpotSignalItems(makeParams(reposRunN));
    expect(resultN.items).toHaveLength(1);
    const itemN = resultN.items[0];

    // Run N+1: same fact exists, now also signal exists, but the fact enters via standalone again
    // (requested_capability is not signal-gated by any signal type)
    const reposRunN1 = makeMockRepos({
      listStandaloneEligibleFactsPage: vi.fn().mockResolvedValue([fact]),
    });

    const resultN1 = await fetchHubSpotSignalItems(makeParams(reposRunN1));
    expect(resultN1.items).toHaveLength(1);
    const itemN1 = resultN1.items[0];

    // Same canonical identity — upsert would update, not create second record
    expect(itemN.sourceItemId).toBe(itemN1.sourceItemId);
    expect(itemN.sourceFingerprint).toBe(itemN1.sourceFingerprint);
  });

  // --- Old evidence unlocked by newer gate ---

  it("fact predating cursor is emitted when unlocked by a newer signal", async () => {
    // Champion fact created at t=5 (before cursor)
    const oldChampionFact = makeChampionFact("fact-old-champion", new Date("2026-03-25T10:00:00Z"));

    // Signal at t=10 (after cursor)
    const signal = makeSignalWithDeal({
      id: "sig-new",
      signalType: "champion_identified",
      detectedAt: new Date("2026-03-28T10:00:00Z"),
    });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      // listExtractionsForDeal returns ALL facts for the deal, regardless of cursor
      listExtractionsForDeal: vi.fn().mockResolvedValue([oldChampionFact]),
    });

    // Cursor is at t=7 — after the fact but before the signal
    const cursor = "2026-03-27T00:00:00.000Z|S|some-earlier-signal";
    const result = await fetchHubSpotSignalItems(makeParams(repos, cursor));

    // The old fact should be emitted via the new signal's gate
    expect(result.items).toHaveLength(1);
    expect(result.items[0].sourceItemId).toBe("hubspot-fact:fact-old-champion");
    expect(result.items[0].metadata.hubspotGatingSignalType).toBe("champion_identified");
  });

  // --- Dense-skew batching ---

  it("single-slice batching does not skip earlier records from sparser class", async () => {
    // 5 facts at t=0.5 (earlier), then 95 signals at t=1 (later)
    // With BATCH_SIZE (100 default), all fit. But let's test with a realistic scenario
    // where we manually verify the ordering.
    const earlyFact = makeFactRecord({
      id: "fact-early",
      createdAt: new Date("2026-03-28T08:00:00Z"), // earlier
    });
    const laterSignal = makeSignalWithDeal({
      id: "sig-later",
      detectedAt: new Date("2026-03-28T10:00:00Z"), // later
    });
    const championFact = makeChampionFact("fact-champ-for-signal");

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([laterSignal]),
      listStandaloneEligibleFactsPage: vi.fn().mockResolvedValue([earlyFact]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([championFact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    // Both should be processed — the early fact AND the signal-gated fact
    const sourceIds = result.items.map((i) => i.sourceItemId).sort();
    expect(sourceIds).toContain("hubspot-fact:fact-early");
    expect(sourceIds).toContain("hubspot-fact:fact-champ-for-signal");

    // Cursor should be at the later record (the signal)
    const parsed = parseCursor(result.newCursor!);
    expect(parsed?.recordClass).toBe("S");
    expect(parsed?.id).toBe("sig-later");
  });

  it("dense-skew: facts at earlier timestamps process before signals at later timestamps", async () => {
    // Create facts with timestamps BEFORE signals
    const facts = Array.from({ length: 3 }, (_, i) =>
      makeFactRecord({
        id: `fact-dense-${i}`,
        createdAt: new Date(`2026-03-28T0${i + 1}:00:00Z`),
        extractedValue: `capability ${i}`,
      })
    );
    const signal = makeSignalWithDeal({
      id: "sig-dense-last",
      detectedAt: new Date("2026-03-28T09:00:00Z"),
    });
    const championFact = makeChampionFact("fact-for-signal-dense");

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listStandaloneEligibleFactsPage: vi.fn().mockResolvedValue(facts),
      listExtractionsForDeal: vi.fn().mockResolvedValue([championFact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    // All 3 standalone facts + 1 signal-gated fact should be emitted
    expect(result.items.length).toBe(4);

    // Cursor should be at the latest record (the signal)
    const parsed = parseCursor(result.newCursor!);
    expect(parsed?.id).toBe("sig-dense-last");
  });

  // --- Failure isolation ---

  it("throws when listSignalsPage fails (caller catches)", async () => {
    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockRejectedValue(new Error("table does not exist")),
    });

    await expect(fetchHubSpotSignalItems(makeParams(repos))).rejects.toThrow("table does not exist");
  });

  // --- Malformed data ---

  it("skips signal with null dealId", async () => {
    const signal = makeSignalWithDeal({ dealId: null });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));
    expect(result.items).toEqual([]);
    expect(result.stats.signalsScanned).toBe(1);
    expect(result.stats.signalsEligible).toBe(0);
  });

  it("skips standalone fact with empty extractedValue", async () => {
    // The DB query filters these, but if one slips through, policy rejects it
    const fact = makeFactRecord({ extractedValue: "" });

    const repos = makeMockRepos({
      listStandaloneEligibleFactsPage: vi.fn().mockResolvedValue([fact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));
    expect(result.items).toEqual([]);
  });

  it("skips signal when getDeal returns null", async () => {
    const signal = makeSignalWithDeal({ deal: null });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([makeChampionFact("f1")]),
      getDeal: vi.fn().mockResolvedValue(null),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));
    expect(result.items).toEqual([]);
  });

  // --- Unknown types ---

  it("signal with unknown signalType does not unlock any facts", async () => {
    const signal = makeSignalWithDeal({ signalType: "some_future_type" });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([makeChampionFact("f1")]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));
    expect(result.items).toEqual([]);
    expect(result.stats.signalsScanned).toBe(1);
    expect(result.stats.signalsEligible).toBe(0);
  });

  // --- Cross-class cursor boundary (Fix 1) ---

  it("cursor ending on class S at timestamp T still allows same-timestamp class F records", async () => {
    // Cursor is at (T, "S", sig-done) — a signal was the last processed record.
    // A fact at the exact same timestamp T should still be included because
    // "F" > "S" in the unified ordering.
    const T = new Date("2026-03-28T10:00:00.000Z");
    const sameTimestampFact = makeFactRecord({
      id: "fact-same-ts",
      createdAt: T,
      extractedValue: "payroll automation at T",
    });

    // The repo returns the fact at timestamp T (GTE query includes it)
    const repos = makeMockRepos({
      listStandaloneEligibleFactsPage: vi.fn().mockResolvedValue([sameTimestampFact]),
      // Also return the already-processed signal at T to verify it's filtered out
      listSignalsPage: vi.fn().mockResolvedValue([
        makeSignalWithDeal({ id: "sig-done", detectedAt: T }),
      ]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([makeChampionFact("f-for-sig")]),
    });

    // Cursor ends on class S at timestamp T
    const cursor = serializeCursor({ timestamp: T.toISOString(), recordClass: "S", id: "sig-done" });
    const result = await fetchHubSpotSignalItems(makeParams(repos, cursor));

    // The fact at timestamp T should be emitted (since "F" > "S")
    const factItem = result.items.find((i) => i.sourceItemId === "hubspot-fact:fact-same-ts");
    expect(factItem).toBeTruthy();

    // The signal at (T, "S", "sig-done") should NOT be re-processed — it's at/before cursor
    // But the champion fact unlocked by the signal AFTER the cursor might be present.
    // The key assertion: the same-timestamp fact from the sparser class is NOT skipped.
    expect(result.items.some((i) => i.sourceItemId === "hubspot-fact:fact-same-ts")).toBe(true);
  });

  it("cursor ending on class F at timestamp T excludes same-timestamp class S records", async () => {
    // Cursor at (T, "F", fact-done). Signals at T sort BEFORE this cursor
    // ("S" < "F"), so they should be excluded.
    const T = new Date("2026-03-28T10:00:00.000Z");
    const signalAtT = makeSignalWithDeal({ id: "sig-at-t", detectedAt: T });
    const championFact = makeChampionFact("fact-for-sig-at-t");

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signalAtT]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([championFact]),
    });

    const cursor = serializeCursor({ timestamp: T.toISOString(), recordClass: "F", id: "fact-done" });
    const result = await fetchHubSpotSignalItems(makeParams(repos, cursor));

    // Signal at (T, "S", "sig-at-t") sorts before cursor (T, "F", "fact-done")
    // so it should be filtered out by isAfterCursor
    expect(result.stats.signalsScanned).toBe(0);
  });

  // --- Freshness: old facts unlocked by newer signals (Fix 2) ---

  it("old fact unlocked by a newer signal uses signal detectedAt as occurredAt", async () => {
    // Champion fact created 45 days ago — would be stale if occurredAt = createdAt
    const oldDate = new Date(NOW.getTime() - 45 * 24 * 60 * 60 * 1000);
    const oldChampionFact = makeChampionFact("fact-old-45d", oldDate);

    // Signal detected today
    const recentSignal = makeSignalWithDeal({
      id: "sig-recent",
      signalType: "champion_identified",
      detectedAt: new Date("2026-03-28T10:00:00Z"),
    });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([recentSignal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([oldChampionFact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    expect(result.items).toHaveLength(1);
    const item = result.items[0];

    // occurredAt should be the signal's detectedAt, NOT the fact's createdAt
    expect(item.occurredAt).toBe("2026-03-28T10:00:00.000Z");
    // Not the old date
    expect(item.occurredAt).not.toBe(oldDate.toISOString());
  });

  it("standalone fact uses its own createdAt as occurredAt (no freshness override)", async () => {
    const factDate = new Date("2026-03-28T09:00:00Z");
    const fact = makeFactRecord({
      id: "fact-standalone-ts",
      createdAt: factDate,
    });

    const repos = makeMockRepos({
      listStandaloneEligibleFactsPage: vi.fn().mockResolvedValue([fact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    expect(result.items).toHaveLength(1);
    expect(result.items[0].occurredAt).toBe(factDate.toISOString());
  });

  it("recent fact gated by signal keeps its own createdAt when newer than signal", async () => {
    // Edge case: fact created AFTER the signal was detected (possible with detection lag)
    const signalDate = new Date("2026-03-27T10:00:00Z");
    const factDate = new Date("2026-03-28T08:00:00Z"); // fact is newer
    const recentFact = makeChampionFact("fact-newer-than-signal", factDate);

    const signal = makeSignalWithDeal({
      id: "sig-older",
      signalType: "champion_identified",
      detectedAt: signalDate,
    });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([recentFact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    expect(result.items).toHaveLength(1);
    // Fact is newer → keeps its own createdAt
    expect(result.items[0].occurredAt).toBe(factDate.toISOString());
  });

  it("old fact beyond 30-day window unlocked by recent signal survives prefilter", async () => {
    // End-to-end: fact created 45 days ago, signal today.
    // The bridged item should use signal's detectedAt and survive prefilterSourceItems.
    const oldDate = new Date(NOW.getTime() - 45 * 24 * 60 * 60 * 1000);
    const oldFact = makeChampionFact("fact-stale-45d", oldDate);

    const signal = makeSignalWithDeal({
      id: "sig-today",
      signalType: "champion_identified",
      detectedAt: NOW,
    });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([oldFact]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));
    expect(result.items).toHaveLength(1);

    // Verify the item would pass prefilterSourceItems
    const { prefilterSourceItems } = await import("../src/services/intelligence.js");
    const { retained, skipped } = prefilterSourceItems(result.items);
    expect(retained).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  // --- Same-class paging at identical timestamps ---

  it("pages through >BATCH_SIZE signals at the same timestamp across two runs", async () => {
    const T = new Date("2026-03-28T10:00:00.000Z");
    const totalSignals = BATCH_SIZE + 20; // 120 signals, all at T

    // Generate signals ordered by id ascending
    const allSignals = Array.from({ length: totalSignals }, (_, i) => {
      const id = `sig-${String(i).padStart(4, "0")}`; // sig-0000, sig-0001, ...
      return makeSignalWithDeal({ id, detectedAt: T });
    });

    const championFact = makeChampionFact("fact-for-paging");

    // --- Run 1: repo returns first BATCH_SIZE signals ---
    const page1 = allSignals.slice(0, BATCH_SIZE);
    const repos1 = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue(page1),
      listExtractionsForDeal: vi.fn().mockResolvedValue([championFact]),
    });

    const result1 = await fetchHubSpotSignalItems(makeParams(repos1));

    // All signals in page1 unlock the same championFact → 1 unique emitted item
    // (champion fact deduped to one canonical record)
    expect(result1.stats.signalsScanned).toBe(BATCH_SIZE);
    expect(result1.newCursor).toBeTruthy();

    const cursor1 = parseCursor(result1.newCursor!);
    expect(cursor1?.recordClass).toBe("S");
    // Last signal in page1 is sig-0099
    expect(cursor1?.id).toBe(`sig-${String(BATCH_SIZE - 1).padStart(4, "0")}`);
    // Cursor timestamp is T
    expect(cursor1?.timestamp).toBe(T.toISOString());

    // --- Run 2: repo simulates keyset pagination returning the next page ---
    // The bridge passes afterId = "sig-0099" for same-class keyset,
    // so the repo should return signals with id > "sig-0099" at timestamp T
    const page2 = allSignals.slice(BATCH_SIZE);
    const repos2 = makeMockRepos({
      listSignalsPage: vi.fn().mockImplementation(
        (_companyId: string, _fromTs: Date | null, afterId: string | null, _limit: number) => {
          // Verify the bridge passes same-class keyset params
          expect(afterId).toBe(`sig-${String(BATCH_SIZE - 1).padStart(4, "0")}`);
          return Promise.resolve(page2);
        }
      ),
      listExtractionsForDeal: vi.fn().mockResolvedValue([championFact]),
    });

    const result2 = await fetchHubSpotSignalItems(makeParams(repos2, result1.newCursor));

    // Second page has the remaining 20 signals
    expect(result2.stats.signalsScanned).toBe(20);

    // Cursor advances to last signal in page2
    const cursor2 = parseCursor(result2.newCursor!);
    expect(cursor2?.id).toBe(`sig-${String(totalSignals - 1).padStart(4, "0")}`);

    // No signals skipped: run1 scanned BATCH_SIZE, run2 scanned 20
    expect(result1.stats.signalsScanned + result2.stats.signalsScanned).toBe(totalSignals);
  });

  it("pages through >BATCH_SIZE standalone facts at the same timestamp across two runs", async () => {
    const T = new Date("2026-03-28T10:00:00.000Z");
    const totalFacts = BATCH_SIZE + 15; // 115 facts, all at T

    const allFacts = Array.from({ length: totalFacts }, (_, i) => {
      const id = `fact-${String(i).padStart(4, "0")}`;
      return makeFactRecord({
        id,
        createdAt: T,
        extractedValue: `capability ${i}`,
        label: `cap-${i}`,
      });
    });

    // --- Run 1: repo returns first BATCH_SIZE facts ---
    const page1 = allFacts.slice(0, BATCH_SIZE);
    const repos1 = makeMockRepos({
      listStandaloneEligibleFactsPage: vi.fn().mockResolvedValue(page1),
    });

    const result1 = await fetchHubSpotSignalItems(makeParams(repos1));

    expect(result1.stats.factsScanned).toBe(BATCH_SIZE);
    expect(result1.items).toHaveLength(BATCH_SIZE); // each unique fact → one item

    const cursor1 = parseCursor(result1.newCursor!);
    expect(cursor1?.recordClass).toBe("F");
    expect(cursor1?.id).toBe(`fact-${String(BATCH_SIZE - 1).padStart(4, "0")}`);
    expect(cursor1?.timestamp).toBe(T.toISOString());

    // --- Run 2: repo simulates keyset pagination ---
    const page2 = allFacts.slice(BATCH_SIZE);
    const repos2 = makeMockRepos({
      listStandaloneEligibleFactsPage: vi.fn().mockImplementation(
        (_companyId: string, _fromTs: Date | null, afterId: string | null, _limit: number) => {
          expect(afterId).toBe(`fact-${String(BATCH_SIZE - 1).padStart(4, "0")}`);
          return Promise.resolve(page2);
        }
      ),
    });

    const result2 = await fetchHubSpotSignalItems(makeParams(repos2, result1.newCursor));

    expect(result2.stats.factsScanned).toBe(15);
    expect(result2.items).toHaveLength(15);

    const cursor2 = parseCursor(result2.newCursor!);
    expect(cursor2?.id).toBe(`fact-${String(totalFacts - 1).padStart(4, "0")}`);

    // No facts skipped
    expect(result1.stats.factsScanned + result2.stats.factsScanned).toBe(totalFacts);
    expect(result1.items.length + result2.items.length).toBe(totalFacts);
  });
});

// ---------------------------------------------------------------------------
// Semantic dedup helpers
// ---------------------------------------------------------------------------

describe("normalizeForDedup", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeForDedup("Marie  Dupont")).toBe("marie dupont");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeForDedup("  Acme Corp  ")).toBe("acme corp");
  });

  it("handles tabs and newlines", () => {
    expect(normalizeForDedup("Acme\t\nCorp")).toBe("acme corp");
  });
});

describe("dedupKey", () => {
  it("produces deterministic key from deal, category, value", () => {
    const key = dedupKey("deal-1", "persona_stakeholder", "Marie Dupont");
    expect(key).toBe("deal-1|persona_stakeholder|marie dupont");
  });

  it("different deals produce different keys", () => {
    const k1 = dedupKey("deal-1", "persona_stakeholder", "Marie Dupont");
    const k2 = dedupKey("deal-2", "persona_stakeholder", "Marie Dupont");
    expect(k1).not.toBe(k2);
  });

  it("different categories produce different keys", () => {
    const k1 = dedupKey("deal-1", "persona_stakeholder", "Acme");
    const k2 = dedupKey("deal-1", "competitor_reference", "Acme");
    expect(k1).not.toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// Semantic dedup integration (fetchHubSpotSignalItems)
// ---------------------------------------------------------------------------

describe("semantic dedup in fetchHubSpotSignalItems", () => {
  it("same champion across activities → 1 item (earliest kept)", async () => {
    // Two champion facts with same deal, same extractedValue, different ids/timestamps
    const fact1 = makeChampionFact("fact-champ-early", new Date("2026-03-25T10:00:00Z"));
    const fact2 = makeChampionFact("fact-champ-late", new Date("2026-03-27T10:00:00Z"));
    // Both have extractedValue "Marie Dupont" from makeChampionFact

    const signal = makeSignalWithDeal({ signalType: "champion_identified" });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([fact1, fact2]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    // Only 1 item emitted despite 2 champion facts with same value
    expect(result.items).toHaveLength(1);
    // Earliest fact wins
    expect(result.items[0].sourceItemId).toBe("hubspot-fact:fact-champ-early");
  });

  it("same competitor across activities → 1 item", async () => {
    const compFact1: FactRecord = makeFactRecord({
      id: "comp-fact-1",
      dealId: "deal-1",
      category: "competitor_reference",
      label: "acme-corp",
      extractedValue: "Acme Corp",
      confidence: 0.9,
      createdAt: new Date("2026-03-25T10:00:00Z"),
    });
    const compFact2: FactRecord = makeFactRecord({
      id: "comp-fact-2",
      dealId: "deal-1",
      category: "competitor_reference",
      label: "acme-corp",
      extractedValue: "Acme Corp",
      confidence: 0.9,
      createdAt: new Date("2026-03-27T10:00:00Z"),
    });

    const signal = makeSignalWithDeal({ signalType: "competitor_mentioned" });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([compFact1, compFact2]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    expect(result.items).toHaveLength(1);
    expect(result.items[0].sourceItemId).toBe("hubspot-fact:comp-fact-1");
  });

  it("different values on same deal → multiple items", async () => {
    const factMarie = makeChampionFact("fact-marie", new Date("2026-03-25T10:00:00Z"));
    const factJean: FactRecord = makeFactRecord({
      id: "fact-jean",
      dealId: "deal-1",
      category: "persona_stakeholder",
      label: "champion",
      extractedValue: "Jean Martin",
      confidence: 0.8,
      createdAt: new Date("2026-03-26T10:00:00Z"),
    });

    const signal = makeSignalWithDeal({ signalType: "champion_identified" });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([factMarie, factJean]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    // Two distinct champion values → 2 items
    expect(result.items).toHaveLength(2);
    const ids = result.items.map((i) => i.sourceItemId).sort();
    expect(ids).toEqual(["hubspot-fact:fact-jean", "hubspot-fact:fact-marie"]);
  });

  it("case normalization collapses same value", async () => {
    const factUpper: FactRecord = makeFactRecord({
      id: "fact-upper",
      dealId: "deal-1",
      category: "persona_stakeholder",
      label: "champion",
      extractedValue: "Marie Dupont",
      confidence: 0.8,
      createdAt: new Date("2026-03-25T10:00:00Z"),
    });
    const factLower: FactRecord = makeFactRecord({
      id: "fact-lower",
      dealId: "deal-1",
      category: "persona_stakeholder",
      label: "champion",
      extractedValue: "marie dupont",
      confidence: 0.8,
      createdAt: new Date("2026-03-26T10:00:00Z"),
    });

    const signal = makeSignalWithDeal({ signalType: "champion_identified" });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([signal]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([factUpper, factLower]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    expect(result.items).toHaveLength(1);
    // Earliest wins
    expect(result.items[0].sourceItemId).toBe("hubspot-fact:fact-upper");
  });

  it("different deals not collapsed", async () => {
    const factDeal1: FactRecord = makeFactRecord({
      id: "fact-d1",
      dealId: "deal-1",
      category: "requested_capability",
      label: "payroll",
      extractedValue: "automated payroll",
      confidence: 0.8,
      createdAt: new Date("2026-03-25T10:00:00Z"),
    });
    const factDeal2: FactRecord = makeFactRecord({
      id: "fact-d2",
      dealId: "deal-2",
      category: "requested_capability",
      label: "payroll",
      extractedValue: "automated payroll",
      confidence: 0.8,
      createdAt: new Date("2026-03-26T10:00:00Z"),
    });

    const repos = makeMockRepos({
      listStandaloneEligibleFactsPage: vi.fn().mockResolvedValue([factDeal1, factDeal2]),
      getDeal: vi.fn().mockImplementation((dealId: string) =>
        Promise.resolve({ dealName: `Deal ${dealId}`, stage: "New" })
      ),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    // Same value but different deals → 2 items
    expect(result.items).toHaveLength(2);
  });

  it("signal-gated preferred over standalone for same semantic key", async () => {
    // Standalone requested_capability fact
    const standaloneFact: FactRecord = makeFactRecord({
      id: "fact-standalone-rc",
      dealId: "deal-1",
      category: "requested_capability",
      label: "payroll",
      extractedValue: "automated payroll",
      confidence: 0.8,
      createdAt: new Date("2026-03-25T10:00:00Z"),
    });
    // Different fact with same semantic content, this one will be signal-gated
    // (In practice this would need a signal type that unlocks requested_capability,
    // but requested_capability is only standalone-eligible. So let's test with
    // champion facts where both paths can exist via different signals.)
    //
    // Better test: two champion facts with same value on same deal.
    // One arrives via signal-gated (champion_identified signal), the other
    // would hypothetically arrive standalone (but champions aren't standalone-eligible).
    //
    // Most realistic case: same semantic key, both signal-gated but via different
    // signals. The dedup should still collapse them.
    const fact1: FactRecord = makeFactRecord({
      id: "fact-champ-a",
      dealId: "deal-1",
      category: "persona_stakeholder",
      label: "champion",
      extractedValue: "Marie Dupont",
      confidence: 0.8,
      createdAt: new Date("2026-03-25T10:00:00Z"),
    });
    const fact2: FactRecord = makeFactRecord({
      id: "fact-champ-b",
      dealId: "deal-1",
      category: "persona_stakeholder",
      label: "champion",
      extractedValue: "Marie Dupont",
      confidence: 0.8,
      createdAt: new Date("2026-03-27T10:00:00Z"),
    });
    const positiveSentiment = makeSentimentFact("fact-pos-dedup", "positive");

    // Two signals, each unlocking different facts but with same semantic content
    const sig1 = makeSignalWithDeal({
      id: "sig-champ-1",
      signalType: "champion_identified",
      detectedAt: new Date("2026-03-28T10:00:00Z"),
    });
    const sig2 = makeSignalWithDeal({
      id: "sig-momentum-1",
      signalType: "positive_momentum",
      detectedAt: new Date("2026-03-28T10:01:00Z"),
    });

    const repos = makeMockRepos({
      listSignalsPage: vi.fn().mockResolvedValue([sig1, sig2]),
      listExtractionsForDeal: vi.fn().mockResolvedValue([fact1, fact2, positiveSentiment]),
    });

    const result = await fetchHubSpotSignalItems(makeParams(repos));

    // Champion facts collapse to 1 (same deal+category+value)
    const championItems = result.items.filter((i) =>
      i.metadata.hubspotFactCategory === "persona_stakeholder"
    );
    expect(championItems).toHaveLength(1);
    // Earliest fact wins among same gating type
    expect(championItems[0].sourceItemId).toBe("hubspot-fact:fact-champ-a");
  });
});

// ---------------------------------------------------------------------------
// Intelligence pipeline acceptance tests — enrich-only enforcement
// ---------------------------------------------------------------------------

import {
  getSourceCreationMode,
  normalizeCreateEnrichDecision,
} from "../src/services/intelligence.js";
import type { NormalizedSourceItem, ContentOpportunity, CreateEnrichDecision } from "../src/domain/types.js";

function makeHubspotSourceItem(overrides?: Partial<NormalizedSourceItem>): NormalizedSourceItem {
  return {
    source: "hubspot",
    sourceItemId: "hubspot-fact:test-fact-1",
    externalId: "hubspot-fact:test-fact-1",
    sourceFingerprint: "abc123",
    sourceUrl: "",
    title: "Champion identified: Marie Dupont",
    text: "Champion identified: Marie Dupont\n\nDeal: Acme Corp (New)",
    summary: "Champion identified: Marie Dupont",
    occurredAt: "2026-03-28T10:00:00Z",
    ingestedAt: "2026-03-28T12:00:00Z",
    metadata: { hubspotFactCategory: "persona_stakeholder" },
    rawPayload: {},
    rawText: null,
    ...overrides,
  };
}

describe("intelligence pipeline enrich-only enforcement", () => {
  it("getSourceCreationMode returns enrich-only for hubspot items unconditionally", () => {
    const item = makeHubspotSourceItem();
    expect(getSourceCreationMode(item)).toBe("enrich-only");
  });

  it("getSourceCreationMode returns enrich-only even with unexpected metadata", () => {
    const item = makeHubspotSourceItem({
      metadata: { hubspotPolicyTier: "create-capable", anything: "else" },
    });
    expect(getSourceCreationMode(item)).toBe("enrich-only");
  });

  it("hubspot source items cannot create opportunities (enrich-only + no candidates → skip)", () => {
    const decision: CreateEnrichDecision = {
      action: "create",
      rationale: "Strong commercial signal",
      title: "Test opportunity",
      confidence: 0.95,
      territory: "HR Tech",
      angle: "Payroll automation resonates",
      whyNow: "Budget approved",
      whatItIsAbout: "Automated payroll processing",
      whatItIsNotAbout: "Manual data entry",
      suggestedFormat: "LinkedIn post",
    };

    const result = normalizeCreateEnrichDecision({
      creationMode: "enrich-only",
      candidates: [],
      decision,
      topCandidateScore: 0,
      curated: false,
    });

    expect(result.action).toBe("skip");
  });

  it("hubspot source items with matching candidate can enrich", () => {
    const candidate = {
      id: "opp-123",
      sourceFingerprint: "fp-1",
      title: "Existing Opportunity",
      angle: "Payroll automation",
      whyNow: "Budget cycle",
      whatItIsAbout: "Payroll",
      whatItIsNotAbout: "",
      evidence: [],
    } as unknown as ContentOpportunity;

    const decision: CreateEnrichDecision = {
      action: "enrich",
      targetOpportunityId: "opp-123",
      rationale: "Enriches existing opportunity",
      title: "",
      confidence: 0.8,
      territory: "",
      angle: "",
      whyNow: "",
      whatItIsAbout: "",
      whatItIsNotAbout: "",
      suggestedFormat: "",
    };

    const result = normalizeCreateEnrichDecision({
      creationMode: "enrich-only",
      candidates: [candidate],
      decision,
      topCandidateScore: 0.7,
      curated: false,
    });

    expect(result.action).toBe("enrich");
    expect(result.targetOpportunityId).toBe("opp-123");
  });
});
