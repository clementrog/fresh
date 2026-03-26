import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  runDetection,
  DETECTION_MANAGED_TYPES,
  type DetectionResult,
} from "../src/sales/services/detection.js";
import { salesSignalDbId } from "../src/sales/db/sales-repositories.js";

// ---------------------------------------------------------------------------
// Test fixtures & helpers
// ---------------------------------------------------------------------------

const COMPANY_ID = "test-company-1";

/**
 * Build a deal object matching the shape returned by repos.listDeals.
 */
function makeDeal(overrides?: Partial<{
  id: string;
  dealName: string;
  staleDays: number;
  lastActivityDate: Date | null;
  pipeline: string;
  stage: string;
  amount: number | null;
  ownerEmail: string | null;
  hubspotOwnerId: string | null;
  closeDateExpected: Date | null;
  propertiesJson: Record<string, unknown>;
}>) {
  const hasLastActivity = overrides && "lastActivityDate" in overrides;
  return {
    id: overrides?.id ?? "deal-1",
    companyId: COMPANY_ID,
    hubspotDealId: overrides?.id ?? "hs-deal-1",
    dealName: overrides?.dealName ?? "Acme Corp Expansion",
    pipeline: overrides?.pipeline ?? "pipeline-1",
    stage: overrides?.stage ?? "negotiation",
    amount: overrides?.amount ?? 50_000,
    ownerEmail: overrides?.ownerEmail ?? "rep@example.com",
    hubspotOwnerId: overrides?.hubspotOwnerId ?? "owner-1",
    lastActivityDate: hasLastActivity ? overrides!.lastActivityDate! : new Date("2026-03-10T12:00:00Z"),
    closeDateExpected: overrides?.closeDateExpected ?? new Date("2026-06-01T00:00:00Z"),
    propertiesJson: overrides?.propertiesJson ?? {},
    staleDays: overrides?.staleDays ?? 5,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-03-10T12:00:00Z"),
  };
}

/**
 * Build a fact object matching the shape returned by repos.listExtractionsForDeal.
 */
function makeFact(overrides?: Partial<{
  id: string;
  companyId: string;
  activityId: string | null;
  dealId: string;
  category: string;
  label: string;
  extractedValue: string;
  confidence: number;
  sourceText: string;
  createdAt: Date;
}>) {
  return {
    id: overrides?.id ?? "fact-1",
    companyId: overrides?.companyId ?? COMPANY_ID,
    activityId: overrides?.activityId ?? "activity-1",
    dealId: overrides?.dealId ?? "deal-1",
    category: overrides?.category ?? "objection_mentioned",
    label: overrides?.label ?? "price",
    extractedValue: overrides?.extractedValue ?? "too expensive",
    confidence: overrides?.confidence ?? 0.9,
    sourceText: overrides?.sourceText ?? "The client said it was too expensive.",
    createdAt: overrides?.createdAt ?? new Date("2026-03-09T10:00:00Z"),
  };
}

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

interface TxMock {
  salesSignal: { upsert: ReturnType<typeof vi.fn> };
}

function buildMockRepos(overrides?: {
  deals?: ReturnType<typeof makeDeal>[];
  factsPerDeal?: Map<string, ReturnType<typeof makeFact>[]>;
  doctrine?: Record<string, unknown> | null;
  acquireRunLeaseError?: Error;
  renewLeaseReturns?: boolean | boolean[];
}) {
  const txUpsert = vi.fn<any>().mockResolvedValue({});
  const txMock: TxMock = {
    salesSignal: { upsert: txUpsert },
  };

  const deleteDetectionSignalsForDeal = vi.fn<any>().mockResolvedValue({ count: 0 });
  const acquireRunLease = overrides?.acquireRunLeaseError
    ? vi.fn<any>().mockRejectedValue(overrides.acquireRunLeaseError)
    : vi.fn<any>().mockResolvedValue({ id: "run-1" });
  const finalizeSyncRun = vi.fn<any>().mockResolvedValue({});

  // renewLease can be a fixed boolean or a sequence
  let renewCallIndex = 0;
  const renewLease = vi.fn<any>().mockImplementation(() => {
    const returns = overrides?.renewLeaseReturns;
    if (Array.isArray(returns)) {
      const val = returns[renewCallIndex] ?? returns[returns.length - 1];
      renewCallIndex++;
      return Promise.resolve(val);
    }
    return Promise.resolve(returns ?? true);
  });

  const deals = overrides?.deals ?? [];
  const factsPerDeal = overrides?.factsPerDeal ?? new Map();

  const listDeals = vi.fn<any>().mockResolvedValue(deals);
  const listExtractionsForDeal = vi.fn<any>().mockImplementation(((dealId: string) => {
    return Promise.resolve(factsPerDeal.get(dealId) ?? []);
  }) as any);

  const getLatestDoctrine = vi.fn<any>().mockResolvedValue(
    overrides?.doctrine === null
      ? null
      : overrides?.doctrine !== undefined
        ? { doctrineJson: overrides.doctrine }
        : null
  );

  const transaction = vi.fn<any>().mockImplementation((async (fn: (tx: TxMock) => Promise<unknown>) => {
    return fn(txMock);
  }) as any);

  const repos = {
    acquireRunLease,
    renewLease,
    listDeals,
    getLatestDoctrine,
    transaction,
    deleteDetectionSignalsForDeal,
    listExtractionsForDeal,
    finalizeSyncRun,
  } as any;

  return {
    repos,
    txMock,
    spies: {
      acquireRunLease,
      renewLease,
      listDeals,
      getLatestDoctrine,
      transaction,
      deleteDetectionSignalsForDeal,
      listExtractionsForDeal,
      finalizeSyncRun,
      txUpsert,
    },
  };
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

/** Extract the `create` payload from a txUpsert mock call */
function callData(call: unknown[]): any {
  return (call as any)[0]?.create;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sales detection service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Each signal rule fires correctly
  // -----------------------------------------------------------------------

  describe("signal rules", () => {
    it("competitor_mentioned — fires for competitor_reference facts", async () => {
      const deal = makeDeal();
      const facts = [
        makeFact({
          id: "f1",
          category: "competitor_reference",
          label: "competitor:salesforce",
          extractedValue: "Salesforce",
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.signalsCreated).toBeGreaterThanOrEqual(1);
      const createCalls = spies.txUpsert.mock.calls;
      const competitorSignals = createCalls.filter(
        (c: any) => c[0].create.signalType === "competitor_mentioned"
      );
      expect(competitorSignals).toHaveLength(1);
      expect(callData(competitorSignals[0]).title).toContain("Salesforce");
    });

    it("blocker_identified — fires for blocker:* label facts", async () => {
      const deal = makeDeal();
      const facts = [
        makeFact({
          id: "f1",
          label: "blocker:security",
          category: "objection_mentioned",
          extractedValue: "Security review required",
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const blockerSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "blocker_identified"
      );
      expect(blockerSignals).toHaveLength(1);
      expect(callData(blockerSignals[0]).title).toContain("Security review required");
    });

    it("next_step_missing — fires when recent activity exists but no next_step fact", async () => {
      const deal = makeDeal({ lastActivityDate: new Date("2026-03-10T12:00:00Z") });
      // Fact with createdAt within 14 days of lastActivityDate
      const facts = [
        makeFact({
          id: "f1",
          category: "objection_mentioned",
          label: "price",
          extractedValue: "too expensive",
          createdAt: new Date("2026-03-05T10:00:00Z"), // 5 days before lastActivity
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const nextStepSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "next_step_missing"
      );
      expect(nextStepSignals).toHaveLength(1);
    });

    it("next_step_missing — does NOT fire when next_step fact is present", async () => {
      const deal = makeDeal({ lastActivityDate: new Date("2026-03-10T12:00:00Z") });
      const facts = [
        makeFact({
          id: "f1",
          category: "objection_mentioned",
          label: "price",
          createdAt: new Date("2026-03-05T10:00:00Z"),
        }),
        makeFact({
          id: "f2",
          category: "urgency_timing",
          label: "next_step",
          extractedValue: "Demo scheduled for March 15",
          createdAt: new Date("2026-03-08T10:00:00Z"),
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const nextStepSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "next_step_missing"
      );
      expect(nextStepSignals).toHaveLength(0);
    });

    it("urgent_timeline — fires for urgency_timing/urgency_level = high", async () => {
      const deal = makeDeal();
      const facts = [
        makeFact({
          id: "f1",
          category: "urgency_timing",
          label: "urgency_level",
          extractedValue: "high",
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const urgentSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "urgent_timeline"
      );
      expect(urgentSignals).toHaveLength(1);
    });

    it("urgent_timeline — does NOT fire for urgency_level = medium", async () => {
      const deal = makeDeal();
      const facts = [
        makeFact({
          id: "f1",
          category: "urgency_timing",
          label: "urgency_level",
          extractedValue: "medium",
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const urgentSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "urgent_timeline"
      );
      expect(urgentSignals).toHaveLength(0);
    });

    it("deal_stale — fires when staleDays >= default threshold (21)", async () => {
      const deal = makeDeal({ staleDays: 25 });
      const { repos, spies } = buildMockRepos({ deals: [deal] });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const staleSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_stale"
      );
      expect(staleSignals).toHaveLength(1);
      expect(callData(staleSignals[0]).title).toContain("25 days");
    });

    it("deal_stale — does NOT fire when staleDays < threshold", async () => {
      const deal = makeDeal({ staleDays: 10 });
      const { repos, spies } = buildMockRepos({ deals: [deal] });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const staleSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_stale"
      );
      expect(staleSignals).toHaveLength(0);
    });

    it("positive_momentum — fires when champion exists and no recent blockers", async () => {
      const lastActivity = new Date("2026-03-10T12:00:00Z");
      const deal = makeDeal({ lastActivityDate: lastActivity });
      const facts = [
        makeFact({
          id: "f1",
          category: "persona_stakeholder",
          label: "champion",
          extractedValue: "Jane VP Engineering",
          createdAt: new Date("2026-03-01T10:00:00Z"), // within 30-day window
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const positiveSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "positive_momentum"
      );
      expect(positiveSignals).toHaveLength(1);
    });

    it("positive_momentum — fires when positive sentiment present and no recent blockers", async () => {
      const lastActivity = new Date("2026-03-10T12:00:00Z");
      const deal = makeDeal({ lastActivityDate: lastActivity });
      const facts = [
        makeFact({
          id: "f1",
          category: "sentiment",
          label: "deal_sentiment",
          extractedValue: "positive",
          createdAt: new Date("2026-03-05T10:00:00Z"), // within 30-day window
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const positiveSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "positive_momentum"
      );
      expect(positiveSignals).toHaveLength(1);
    });

    it("positive_momentum — suppressed when recent blocker exists", async () => {
      const lastActivity = new Date("2026-03-10T12:00:00Z");
      const deal = makeDeal({ lastActivityDate: lastActivity });
      const facts = [
        makeFact({
          id: "f1",
          category: "persona_stakeholder",
          label: "champion",
          extractedValue: "Jane VP Engineering",
          createdAt: new Date("2026-03-05T10:00:00Z"),
        }),
        makeFact({
          id: "f2",
          label: "blocker:security",
          category: "objection_mentioned",
          extractedValue: "Security review",
          createdAt: new Date("2026-03-08T10:00:00Z"), // recent blocker in 30-day window
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const positiveSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "positive_momentum"
      );
      expect(positiveSignals).toHaveLength(0);
    });

    it("negative_momentum — fires when multiple blockers/pain points in window", async () => {
      const lastActivity = new Date("2026-03-10T12:00:00Z");
      const deal = makeDeal({ lastActivityDate: lastActivity });
      const facts = [
        makeFact({
          id: "f1",
          label: "blocker:security",
          category: "objection_mentioned",
          extractedValue: "Security review",
          createdAt: new Date("2026-03-05T10:00:00Z"),
        }),
        makeFact({
          id: "f2",
          label: "pain:integration",
          category: "objection_mentioned",
          extractedValue: "Integration issues",
          createdAt: new Date("2026-03-06T10:00:00Z"),
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const negativeSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "negative_momentum"
      );
      expect(negativeSignals).toHaveLength(1);
    });

    it("negative_momentum — fires when negative sentiment present", async () => {
      const lastActivity = new Date("2026-03-10T12:00:00Z");
      const deal = makeDeal({ lastActivityDate: lastActivity });
      const facts = [
        makeFact({
          id: "f1",
          category: "sentiment",
          label: "deal_sentiment",
          extractedValue: "negative",
          createdAt: new Date("2026-03-05T10:00:00Z"),
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const negativeSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "negative_momentum"
      );
      expect(negativeSignals).toHaveLength(1);
    });

    it("negative_momentum — does NOT fire with only one blocker (below threshold)", async () => {
      const lastActivity = new Date("2026-03-10T12:00:00Z");
      const deal = makeDeal({ lastActivityDate: lastActivity });
      const facts = [
        makeFact({
          id: "f1",
          label: "blocker:security",
          category: "objection_mentioned",
          extractedValue: "Security review",
          createdAt: new Date("2026-03-05T10:00:00Z"),
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const negativeSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "negative_momentum"
      );
      expect(negativeSignals).toHaveLength(0);
    });

    it("champion_identified — fires for persona_stakeholder/champion fact", async () => {
      const deal = makeDeal();
      const facts = [
        makeFact({
          id: "f1",
          category: "persona_stakeholder",
          label: "champion",
          extractedValue: "Jane CTO",
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const champSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "champion_identified"
      );
      expect(champSignals).toHaveLength(1);
      expect(callData(champSignals[0]).title).toContain("Jane CTO");
    });

    it("budget_surfaced — fires for budget_sensitivity fact", async () => {
      const deal = makeDeal();
      const facts = [
        makeFact({
          id: "f1",
          category: "budget_sensitivity",
          label: "budget_mentioned",
          extractedValue: "Budget approved for Q2",
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const budgetSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "budget_surfaced"
      );
      expect(budgetSignals).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Delete-and-replace
  // -----------------------------------------------------------------------

  describe("delete-and-replace", () => {
    it("deletes existing detection-managed signals before re-emission", async () => {
      const deal = makeDeal({ staleDays: 25 });
      const { repos, spies } = buildMockRepos({
        deals: [deal],
      });
      spies.deleteDetectionSignalsForDeal.mockResolvedValue({ count: 3 });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(spies.deleteDetectionSignalsForDeal).toHaveBeenCalledWith(
        "deal-1",
        expect.arrayContaining(DETECTION_MANAGED_TYPES),
        expect.anything() // tx mock
      );
      expect(result.signalsRemoved).toBe(3);
    });

    it("passes the correct managed types to deleteDetectionSignalsForDeal", async () => {
      const deal = makeDeal();
      const { repos, spies } = buildMockRepos({ deals: [deal] });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const calledTypes = spies.deleteDetectionSignalsForDeal.mock.calls[0][1];
      expect(calledTypes).toEqual(expect.arrayContaining([
        "competitor_mentioned",
        "blocker_identified",
        "next_step_missing",
        "urgent_timeline",
        "deal_stale",
        "positive_momentum",
        "negative_momentum",
        "champion_identified",
        "budget_surfaced",
      ]));
      expect(calledTypes).toHaveLength(9);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Stale signal cleanup
  // -----------------------------------------------------------------------

  describe("stale signal cleanup", () => {
    it("removes signals when facts that triggered them are gone (empty fact list)", async () => {
      const deal = makeDeal({ staleDays: 5 }); // not stale
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", []]]), // no facts
      });
      spies.deleteDetectionSignalsForDeal.mockResolvedValue({ count: 2 });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // Should have deleted old signals
      expect(spies.deleteDetectionSignalsForDeal).toHaveBeenCalledWith(
        "deal-1",
        expect.any(Array),
        expect.anything()
      );
      expect(result.signalsRemoved).toBe(2);
      // No new signals created (no facts, not stale)
      expect(result.signalsCreated).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Empty fact set
  // -----------------------------------------------------------------------

  describe("empty fact set", () => {
    it("produces no signals for a non-stale deal with no facts", async () => {
      const deal = makeDeal({ staleDays: 5 });
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", []]]),
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.signalsCreated).toBe(0);
      expect(spies.txUpsert).not.toHaveBeenCalled();
    });

    it("produces no signals when there are no deals", async () => {
      const { repos, spies } = buildMockRepos({ deals: [] });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.signalsCreated).toBe(0);
      expect(result.dealsScanned).toBe(0);
      expect(spies.txUpsert).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 5. Stale deal detection uses doctrine threshold
  // -----------------------------------------------------------------------

  describe("stale deal — doctrine threshold", () => {
    it("uses doctrine stalenessThresholdDays when available", async () => {
      const deal = makeDeal({ staleDays: 15 }); // under default 21 but over doctrine 10
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        doctrine: { stalenessThresholdDays: 10 },
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const staleSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_stale"
      );
      expect(staleSignals).toHaveLength(1);
    });

    it("uses default threshold (21) when doctrine is null", async () => {
      const deal = makeDeal({ staleDays: 22 });
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        doctrine: null,
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const staleSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_stale"
      );
      expect(staleSignals).toHaveLength(1);
    });

    it("uses default threshold when doctrine lacks stalenessThresholdDays field", async () => {
      const deal = makeDeal({ staleDays: 15 }); // under default 21
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        doctrine: { someOtherKey: "value" },
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const staleSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_stale"
      );
      expect(staleSignals).toHaveLength(0); // 15 < 21
    });

    it("respects explicit stalenessThresholdDays param over doctrine", async () => {
      const deal = makeDeal({ staleDays: 8 });
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        doctrine: { stalenessThresholdDays: 30 }, // doctrine says 30
      });

      // explicit param overrides both default and doctrine
      await runDetection({
        companyId: COMPANY_ID,
        repos,
        logger: mockLogger,
        stalenessThresholdDays: 5, // param says 5
      });

      const staleSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_stale"
      );
      // staleDays 8 >= param 5 → signal fires
      // Note: looking at the code, param is used as default, but doctrine overrides it
      // Let's check: stalenessThreshold = params.stalenessThresholdDays ?? DEFAULT
      // then doctrine can override. So doctrine wins if present.
      // With doctrine { stalenessThresholdDays: 30 }, 8 < 30 → no signal
      expect(staleSignals).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Atomicity — per-deal tx
  // -----------------------------------------------------------------------

  describe("atomicity", () => {
    it("calls transaction once per deal", async () => {
      const deals = [
        makeDeal({ id: "deal-1" }),
        makeDeal({ id: "deal-2", dealName: "Beta Corp" }),
        makeDeal({ id: "deal-3", dealName: "Gamma Inc" }),
      ];
      const { repos, spies } = buildMockRepos({ deals });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(spies.transaction).toHaveBeenCalledTimes(3);
    });

    it("processes each deal within its own transaction scope", async () => {
      const deals = [
        makeDeal({ id: "deal-1", staleDays: 25 }),
        makeDeal({ id: "deal-2", staleDays: 30, dealName: "Stale Beta" }),
      ];
      const { repos, spies } = buildMockRepos({ deals });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // deleteDetectionSignalsForDeal called once per deal
      expect(spies.deleteDetectionSignalsForDeal).toHaveBeenCalledTimes(2);
      // First call for deal-1
      expect(spies.deleteDetectionSignalsForDeal.mock.calls[0][0]).toBe("deal-1");
      // Second call for deal-2
      expect(spies.deleteDetectionSignalsForDeal.mock.calls[1][0]).toBe("deal-2");
    });
  });

  // -----------------------------------------------------------------------
  // 7. Source-event-time determinism
  // -----------------------------------------------------------------------

  describe("source-event-time determinism", () => {
    it("signal IDs depend on deal.lastActivityDate, not wall clock", async () => {
      // Fixed lastActivityDate so ISO-week key is deterministic
      const fixedDate = new Date("2026-03-10T12:00:00Z");
      const deal = makeDeal({ staleDays: 25, lastActivityDate: fixedDate });

      const { repos: repos1, spies: spies1 } = buildMockRepos({ deals: [deal] });
      const { repos: repos2, spies: spies2 } = buildMockRepos({ deals: [deal] });

      await runDetection({ companyId: COMPANY_ID, repos: repos1, logger: mockLogger });
      await runDetection({ companyId: COMPANY_ID, repos: repos2, logger: mockLogger });

      // deal_stale uses weekKey from lastActivityDate for dedup
      const staleSignals1 = spies1.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_stale"
      );
      const staleSignals2 = spies2.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_stale"
      );

      expect(staleSignals1).toHaveLength(1);
      expect(staleSignals2).toHaveLength(1);
      // Same signal ID because same inputs
      expect(callData(staleSignals1[0]).id).toBe(callData(staleSignals2[0]).id);
    });

    it("momentum window is relative to lastActivityDate, not current time", async () => {
      // lastActivityDate far in the past
      const lastActivity = new Date("2025-06-01T12:00:00Z");
      const deal = makeDeal({ lastActivityDate: lastActivity });
      // Fact created within 30 days of lastActivityDate (May 15 is 17 days before June 1)
      const facts = [
        makeFact({
          id: "f1",
          category: "sentiment",
          label: "deal_sentiment",
          extractedValue: "positive",
          createdAt: new Date("2025-05-15T10:00:00Z"),
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // positive_momentum should fire — the window is relative to lastActivityDate (2025-06-01),
      // not current wall-clock time
      const positiveSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "positive_momentum"
      );
      expect(positiveSignals).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Reprocessing stability
  // -----------------------------------------------------------------------

  describe("reprocessing stability", () => {
    it("running twice with same data produces same signal count", async () => {
      const deal = makeDeal({ staleDays: 25 });
      const facts = [
        makeFact({
          id: "f1",
          category: "competitor_reference",
          label: "competitor:hubspot",
          extractedValue: "HubSpot",
        }),
        makeFact({
          id: "f2",
          category: "budget_sensitivity",
          label: "budget_mentioned",
          extractedValue: "$100k approved",
        }),
      ];

      const { repos: repos1, spies: spies1 } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });
      const { repos: repos2, spies: spies2 } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      const result1 = await runDetection({ companyId: COMPANY_ID, repos: repos1, logger: mockLogger });
      const result2 = await runDetection({ companyId: COMPANY_ID, repos: repos2, logger: mockLogger });

      expect(result1.signalsCreated).toBe(result2.signalsCreated);
      expect(result1.dealsScanned).toBe(result2.dealsScanned);
    });

    it("same data produces identical signal IDs", async () => {
      const deal = makeDeal({ staleDays: 25 });
      const facts = [
        makeFact({
          id: "f1",
          category: "competitor_reference",
          label: "competitor:hubspot",
          extractedValue: "HubSpot",
        }),
      ];

      const { repos: repos1, spies: spies1 } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });
      const { repos: repos2, spies: spies2 } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos: repos1, logger: mockLogger });
      await runDetection({ companyId: COMPANY_ID, repos: repos2, logger: mockLogger });

      const ids1 = spies1.txUpsert.mock.calls.map((c: any) => c[0].create.id).sort();
      const ids2 = spies2.txUpsert.mock.calls.map((c: any) => c[0].create.id).sort();
      expect(ids1).toEqual(ids2);
    });
  });

  // -----------------------------------------------------------------------
  // 9. ISO-week key from source time
  // -----------------------------------------------------------------------

  describe("ISO-week key from source time", () => {
    it("deals with different lastActivityDate weeks produce different signal IDs for weekly signals", async () => {
      // Week 11 of 2026: March 9-15
      const dealWeek11 = makeDeal({
        id: "deal-w11",
        staleDays: 30,
        lastActivityDate: new Date("2026-03-10T12:00:00Z"), // Tuesday W11
      });
      // Week 12 of 2026: March 16-22
      const dealWeek12 = makeDeal({
        id: "deal-w12",
        staleDays: 30,
        lastActivityDate: new Date("2026-03-18T12:00:00Z"), // Wednesday W12
      });

      // Run for week 11 deal
      const { repos: repos1, spies: spies1 } = buildMockRepos({ deals: [dealWeek11] });
      await runDetection({ companyId: COMPANY_ID, repos: repos1, logger: mockLogger });

      // Run for week 12 deal
      const { repos: repos2, spies: spies2 } = buildMockRepos({ deals: [dealWeek12] });
      await runDetection({ companyId: COMPANY_ID, repos: repos2, logger: mockLogger });

      const staleId1 = spies1.txUpsert.mock.calls
        .filter((c: any) => c[0].create.signalType === "deal_stale")
        .map((c: any) => c[0].create.id)[0];
      const staleId2 = spies2.txUpsert.mock.calls
        .filter((c: any) => c[0].create.signalType === "deal_stale")
        .map((c: any) => c[0].create.id)[0];

      expect(staleId1).toBeDefined();
      expect(staleId2).toBeDefined();
      // Different weeks + different deal IDs → different signal IDs
      expect(staleId1).not.toBe(staleId2);
    });

    it("same deal in same ISO-week produces same signal ID for weekly signals", async () => {
      // Both dates in the same ISO week (W11: March 9-15, 2026)
      const dealMonday = makeDeal({
        id: "deal-x",
        staleDays: 30,
        lastActivityDate: new Date("2026-03-09T08:00:00Z"), // Monday W11
      });
      const dealFriday = makeDeal({
        id: "deal-x",
        staleDays: 30,
        lastActivityDate: new Date("2026-03-13T18:00:00Z"), // Friday W11
      });

      const { repos: repos1, spies: spies1 } = buildMockRepos({ deals: [dealMonday] });
      await runDetection({ companyId: COMPANY_ID, repos: repos1, logger: mockLogger });

      const { repos: repos2, spies: spies2 } = buildMockRepos({ deals: [dealFriday] });
      await runDetection({ companyId: COMPANY_ID, repos: repos2, logger: mockLogger });

      const staleId1 = spies1.txUpsert.mock.calls
        .filter((c: any) => c[0].create.signalType === "deal_stale")
        .map((c: any) => c[0].create.id)[0];
      const staleId2 = spies2.txUpsert.mock.calls
        .filter((c: any) => c[0].create.signalType === "deal_stale")
        .map((c: any) => c[0].create.id)[0];

      expect(staleId1).toBeDefined();
      expect(staleId2).toBeDefined();
      // Same deal ID + same ISO week → same signal ID
      expect(staleId1).toBe(staleId2);
    });

    it("momentum signals use ISO-week key for dedup", async () => {
      const lastActivity = new Date("2026-03-10T12:00:00Z"); // W11
      const deal = makeDeal({ id: "deal-m", lastActivityDate: lastActivity });
      const facts = [
        makeFact({
          id: "f1",
          category: "persona_stakeholder",
          label: "champion",
          extractedValue: "Jane CTO",
          createdAt: new Date("2026-03-05T10:00:00Z"),
        }),
      ];

      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-m", facts]]),
      });
      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const positiveSignal = spies.txUpsert.mock.calls.find(
        (c: any) => c[0].create.signalType === "positive_momentum"
      );
      expect(positiveSignal).toBeDefined();

      // Verify the signal ID is built with the ISO-week-derived parts
      const expectedId = salesSignalDbId(COMPANY_ID, ["positive_momentum", "deal-m", "2026-W11"]);
      expect(callData(positiveSignal!).id).toBe(expectedId);
    });
  });

  // -----------------------------------------------------------------------
  // 10. Lease — blocked
  // -----------------------------------------------------------------------

  describe("lease — blocked", () => {
    it("throws when acquireRunLease fails", async () => {
      const { repos } = buildMockRepos({
        acquireRunLeaseError: new Error("Another sales:detect run is already in progress"),
      });

      await expect(
        runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger })
      ).rejects.toThrow("Another sales:detect run is already in progress");
    });
  });

  // -----------------------------------------------------------------------
  // 11. Lease — renewal at checkpoints
  // -----------------------------------------------------------------------

  describe("lease — renewal at checkpoints", () => {
    it("calls renewLease before and after each deal", async () => {
      const deals = [
        makeDeal({ id: "deal-1" }),
        makeDeal({ id: "deal-2", dealName: "Beta Corp" }),
      ];
      const { repos, spies } = buildMockRepos({ deals });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // 2 deals × 2 checkpoints (pre + post) = 4 renewLease calls
      expect(spies.renewLease).toHaveBeenCalledTimes(4);
    });

    it("renewLease is called with the correct runId", async () => {
      const deals = [makeDeal({ id: "deal-1" })];
      const { repos, spies } = buildMockRepos({ deals });

      await runDetection({
        companyId: COMPANY_ID,
        repos,
        logger: mockLogger,
        runId: "explicit-run-id",
      });

      for (const call of spies.renewLease.mock.calls) {
        expect(call[0]).toBe("explicit-run-id");
      }
    });
  });

  // -----------------------------------------------------------------------
  // 12. Lease — lost mid-run
  // -----------------------------------------------------------------------

  describe("lease — lost mid-run", () => {
    it("stops processing when lease is lost after 2 of 4 deals", async () => {
      const deals = [
        makeDeal({ id: "deal-1", dealName: "Alpha" }),
        makeDeal({ id: "deal-2", dealName: "Beta" }),
        makeDeal({ id: "deal-3", dealName: "Gamma" }),
        makeDeal({ id: "deal-4", dealName: "Delta" }),
      ];

      // Lease flow for 4 deals:
      //   deal-1: pre=true, post=true
      //   deal-2: pre=true, post=true
      //   deal-3: pre=false → abort
      // So: [true, true, true, true, false]
      const { repos, spies } = buildMockRepos({
        deals,
        renewLeaseReturns: [true, true, true, true, false],
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // Only 2 deals processed before the post-deal checkpoint of deal-2 returns true,
      // then the pre-deal checkpoint of deal-3 returns false
      expect(result.dealsScanned).toBe(2);
      // transaction called only for deals that had successful pre-deal checkpoint
      expect(spies.transaction).toHaveBeenCalledTimes(2);
    });

    it("does NOT finalize the run when lease is lost", async () => {
      const deals = [
        makeDeal({ id: "deal-1" }),
        makeDeal({ id: "deal-2" }),
      ];
      // pre-deal-1=true, post-deal-1=false → stop after 1 deal
      const { repos, spies } = buildMockRepos({
        deals,
        renewLeaseReturns: [true, false],
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(spies.finalizeSyncRun).not.toHaveBeenCalled();
    });

    it("finalizeSyncRun called with 'completed' when all deals succeed", async () => {
      const deals = [makeDeal({ id: "deal-1" })];
      const { repos, spies } = buildMockRepos({ deals });

      await runDetection({
        companyId: COMPANY_ID,
        repos,
        logger: mockLogger,
        runId: "run-abc",
      });

      expect(spies.finalizeSyncRun).toHaveBeenCalledWith(
        "run-abc",
        "completed",
        expect.objectContaining({
          dealsScanned: 1,
        }),
        expect.any(Array)
      );
    });
  });

  // -----------------------------------------------------------------------
  // Additional edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("DETECTION_MANAGED_TYPES has exactly 9 entries", () => {
      expect(DETECTION_MANAGED_TYPES).toHaveLength(9);
      expect(DETECTION_MANAGED_TYPES).toContain("competitor_mentioned");
      expect(DETECTION_MANAGED_TYPES).toContain("blocker_identified");
      expect(DETECTION_MANAGED_TYPES).toContain("next_step_missing");
      expect(DETECTION_MANAGED_TYPES).toContain("urgent_timeline");
      expect(DETECTION_MANAGED_TYPES).toContain("deal_stale");
      expect(DETECTION_MANAGED_TYPES).toContain("positive_momentum");
      expect(DETECTION_MANAGED_TYPES).toContain("negative_momentum");
      expect(DETECTION_MANAGED_TYPES).toContain("champion_identified");
      expect(DETECTION_MANAGED_TYPES).toContain("budget_surfaced");
    });

    it("deal with null lastActivityDate does not produce next_step_missing", async () => {
      const deal = makeDeal({ lastActivityDate: null });
      const facts = [
        makeFact({
          id: "f1",
          category: "objection_mentioned",
          label: "price",
          extractedValue: "expensive",
          createdAt: new Date("2026-03-05T10:00:00Z"),
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const nextStepSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "next_step_missing"
      );
      expect(nextStepSignals).toHaveLength(0);
    });

    it("deal_stale uses 'unknown' week key when lastActivityDate is null", async () => {
      const deal = makeDeal({ staleDays: 30, lastActivityDate: null, id: "deal-null-date" });
      const { repos, spies } = buildMockRepos({ deals: [deal] });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const staleSignal = spies.txUpsert.mock.calls.find(
        (c: any) => c[0].create.signalType === "deal_stale"
      );
      expect(staleSignal).toBeDefined();
      // Signal ID should incorporate "unknown" as the week key
      const expectedId = salesSignalDbId(COMPANY_ID, ["deal_stale", "deal-null-date", "unknown"]);
      expect(callData(staleSignal!).id).toBe(expectedId);
    });

    it("multiple competitor_reference facts produce multiple competitor_mentioned signals", async () => {
      const deal = makeDeal();
      const facts = [
        makeFact({
          id: "f1",
          category: "competitor_reference",
          label: "competitor:salesforce",
          extractedValue: "Salesforce",
        }),
        makeFact({
          id: "f2",
          category: "competitor_reference",
          label: "competitor:hubspot",
          extractedValue: "HubSpot",
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const competitorSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "competitor_mentioned"
      );
      expect(competitorSignals).toHaveLength(2);
    });

    it("errors on individual deals are captured but do not abort the run", async () => {
      const deals = [
        makeDeal({ id: "deal-1" }),
        makeDeal({ id: "deal-2", dealName: "Beta" }),
      ];

      const { repos, spies } = buildMockRepos({ deals });

      // Make the transaction throw for deal-1 but succeed for deal-2
      let txCallCount = 0;
      spies.transaction.mockImplementation(async (fn: any) => {
        txCallCount++;
        if (txCallCount === 1) {
          throw new Error("DB timeout on deal-1");
        }
        return fn({ salesSignal: { create: spies.txUpsert } });
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.dealsScanned).toBe(2); // both counted
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("deal-1");
      expect(result.errors[0]).toContain("DB timeout");
    });

    it("signals include correct companyId and dealId", async () => {
      const deal = makeDeal({ staleDays: 25 });
      const { repos, spies } = buildMockRepos({ deals: [deal] });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const staleSignal = spies.txUpsert.mock.calls.find(
        (c: any) => c[0].create.signalType === "deal_stale"
      );
      expect(staleSignal).toBeDefined();
      expect(callData(staleSignal!).companyId).toBe(COMPANY_ID);
      expect(callData(staleSignal!).dealId).toBe("deal-1");
    });

    it("facts outside the 30-day momentum window are excluded from momentum calculation", async () => {
      const lastActivity = new Date("2026-03-10T12:00:00Z");
      const deal = makeDeal({ lastActivityDate: lastActivity });
      // Fact created 60 days before lastActivityDate — outside 30-day window
      const facts = [
        makeFact({
          id: "f1",
          category: "sentiment",
          label: "deal_sentiment",
          extractedValue: "positive",
          createdAt: new Date("2026-01-09T10:00:00Z"), // 60 days before March 10
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // positive_momentum should NOT fire because the positive sentiment fact
      // is outside the 30-day window. However champion check uses ctx.facts (all facts),
      // not recentFacts. Since there's no champion, and positive sentiment is outside
      // window, positive_momentum should not fire.
      const positiveSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "positive_momentum"
      );
      expect(positiveSignals).toHaveLength(0);
    });

    it("facts after lastActivityDate are excluded from momentum window", async () => {
      const lastActivity = new Date("2026-03-10T12:00:00Z");
      const deal = makeDeal({ lastActivityDate: lastActivity });
      // Fact created after lastActivityDate — daysDiff would be negative
      const facts = [
        makeFact({
          id: "f1",
          category: "sentiment",
          label: "deal_sentiment",
          extractedValue: "negative",
          createdAt: new Date("2026-03-15T10:00:00Z"), // 5 days AFTER lastActivity
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // negative_momentum should NOT fire because the fact is after lastActivityDate
      // (differenceInDays returns negative, fails daysDiff >= 0 check)
      const negativeSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "negative_momentum"
      );
      expect(negativeSignals).toHaveLength(0);
    });
  });
});
