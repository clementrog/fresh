import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  runDetection,
  DETECTION_MANAGED_TYPES,
  LEAD_MANAGED_TYPES,
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
    stage: overrides?.stage ?? "stage-new",
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

/**
 * Build a HubSpot company object matching the shape returned by repos.listHubspotCompaniesWithLeadStatus.
 */
function makeHubspotCompany(overrides?: Partial<{
  id: string;
  name: string;
  leadStatus: string;
  companyId: string;
}>) {
  return {
    id: overrides?.id ?? "hc-1",
    companyId: overrides?.companyId ?? COMPANY_ID,
    hubspotCompanyId: overrides?.id ?? "hs-hc-1",
    name: overrides?.name ?? "Lead Corp",
    propertiesJson: overrides?.leadStatus
      ? { hs_lead_status: overrides.leadStatus }
      : { hs_lead_status: "Hunted" },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-03-10T12:00:00Z"),
  };
}

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

interface TxMock {
  salesSignal: { upsert: ReturnType<typeof vi.fn> };
  sourceCursor: { upsert: ReturnType<typeof vi.fn> };
}

function buildMockRepos(overrides?: {
  deals?: ReturnType<typeof makeDeal>[];
  factsPerDeal?: Map<string, ReturnType<typeof makeFact>[]>;
  doctrine?: Record<string, unknown> | null;
  acquireRunLeaseError?: Error;
  renewLeaseReturns?: boolean | boolean[];
  hubspotCompanies?: ReturnType<typeof makeHubspotCompany>[];
  dealsByHubspotCompany?: Map<string, ReturnType<typeof makeDeal>[]>;
  maxActivityTimestamp?: Date | null;
  activityCount?: number;
  cursorValues?: Map<string, string | null>;
  orphanCleanupResult?: { count: number; cursorsCleaned: number };
  scopeCleanupCount?: number;
}) {
  const txUpsert = vi.fn<any>().mockResolvedValue({});
  const txCursorUpsert = vi.fn<any>().mockResolvedValue({});
  const txMock: TxMock = {
    salesSignal: { upsert: txUpsert },
    sourceCursor: { upsert: txCursorUpsert },
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

  const deleteSignalsForOutOfScopeDeals = vi.fn<any>().mockResolvedValue({
    count: overrides?.scopeCleanupCount ?? 0,
  });

  // Lead detection mocks
  const listHubspotCompaniesWithLeadStatus = vi.fn<any>().mockResolvedValue(
    overrides?.hubspotCompanies ?? []
  );

  const listDealsByHubspotCompany = vi.fn<any>().mockImplementation(((id: string) => {
    return Promise.resolve(overrides?.dealsByHubspotCompany?.get(id) ?? []);
  }) as any);

  const maxActivityTimestampForDeals = vi.fn<any>().mockResolvedValue(
    overrides?.maxActivityTimestamp !== undefined ? overrides.maxActivityTimestamp : null
  );

  const countActivitiesForDealsSince = vi.fn<any>().mockResolvedValue(
    overrides?.activityCount ?? 0
  );

  const deleteLeadSignalsForCompany = vi.fn<any>().mockResolvedValue({ count: 0 });

  const deleteOrphanedLeadSignals = vi.fn<any>().mockResolvedValue(
    overrides?.orphanCleanupResult ?? { count: 0, cursorsCleaned: 0 }
  );

  const getCursor = vi.fn<any>().mockImplementation(((companyId: string, source: string) => {
    return Promise.resolve(overrides?.cursorValues?.get(source) ?? null);
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
    deleteSignalsForOutOfScopeDeals,
    listHubspotCompaniesWithLeadStatus,
    listDealsByHubspotCompany,
    maxActivityTimestampForDeals,
    countActivitiesForDealsSince,
    deleteLeadSignalsForCompany,
    deleteOrphanedLeadSignals,
    getCursor,
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
      deleteSignalsForOutOfScopeDeals,
      listHubspotCompaniesWithLeadStatus,
      listDealsByHubspotCompany,
      maxActivityTimestampForDeals,
      countActivitiesForDealsSince,
      deleteLeadSignalsForCompany,
      deleteOrphanedLeadSignals,
      getCursor,
      txUpsert,
      txCursorUpsert,
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
  // 1. Each signal rule fires correctly (consolidated per-deal)
  // -----------------------------------------------------------------------

  describe("signal rules", () => {
    it("competitor_mentioned — consolidated: one signal per deal with all competitors", async () => {
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

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.signalsCreated).toBeGreaterThanOrEqual(1);
      const competitorSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "competitor_mentioned"
      );
      // Consolidated: only ONE signal per deal, listing all competitors
      expect(competitorSignals).toHaveLength(1);
      expect(callData(competitorSignals[0]).title).toContain("Salesforce");
      expect(callData(competitorSignals[0]).title).toContain("HubSpot");
    });

    it("blocker_identified — consolidated: one signal per deal with all blockers", async () => {
      const deal = makeDeal();
      const facts = [
        makeFact({
          id: "f1",
          label: "blocker:security",
          category: "objection_mentioned",
          extractedValue: "Security review required",
        }),
        makeFact({
          id: "f2",
          label: "blocker:compliance",
          category: "objection_mentioned",
          extractedValue: "Compliance check needed",
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
      // Consolidated: one signal per deal
      expect(blockerSignals).toHaveLength(1);
      expect(callData(blockerSignals[0]).title).toContain("2 blocker(s)");
    });

    it("champion_identified — consolidated: one signal per deal with first champion in title", async () => {
      const deal = makeDeal();
      const facts = [
        makeFact({
          id: "f1",
          category: "persona_stakeholder",
          label: "champion",
          extractedValue: "Jane CTO",
        }),
        makeFact({
          id: "f2",
          category: "persona_stakeholder",
          label: "champion",
          extractedValue: "Bob VP Eng",
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
      // Consolidated: one signal per deal
      expect(champSignals).toHaveLength(1);
      expect(callData(champSignals[0]).title).toContain("Jane CTO");
    });

    it("next_step_missing — fires when recent activity exists but no next_step fact", async () => {
      const deal = makeDeal({ lastActivityDate: new Date("2026-03-10T12:00:00Z") });
      const facts = [
        makeFact({
          id: "f1",
          category: "objection_mentioned",
          label: "price",
          extractedValue: "too expensive",
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

    it("positive_momentum — fires when champion exists and no recent blockers", async () => {
      const lastActivity = new Date("2026-03-10T12:00:00Z");
      const deal = makeDeal({ lastActivityDate: lastActivity });
      const facts = [
        makeFact({
          id: "f1",
          category: "persona_stakeholder",
          label: "champion",
          extractedValue: "Jane VP Engineering",
          createdAt: new Date("2026-03-01T10:00:00Z"),
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
          createdAt: new Date("2026-03-05T10:00:00Z"),
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
          createdAt: new Date("2026-03-08T10:00:00Z"),
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
  });

  // -----------------------------------------------------------------------
  // 2. deal_going_cold fires for 7-14 day staleness
  // -----------------------------------------------------------------------

  describe("deal_going_cold", () => {
    it("fires when staleDays is between 7 and staleness threshold", async () => {
      const deal = makeDeal({ staleDays: 10 });
      const { repos, spies } = buildMockRepos({ deals: [deal] });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const coldSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_going_cold"
      );
      expect(coldSignals).toHaveLength(1);
      expect(callData(coldSignals[0]).title).toContain("10 days");
    });

    it("fires at exactly 7 days (threshold boundary)", async () => {
      const deal = makeDeal({ staleDays: 7 });
      const { repos, spies } = buildMockRepos({ deals: [deal] });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const coldSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_going_cold"
      );
      expect(coldSignals).toHaveLength(1);
    });

    it("does NOT fire below 7 days", async () => {
      const deal = makeDeal({ staleDays: 6 });
      const { repos, spies } = buildMockRepos({ deals: [deal] });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const coldSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_going_cold"
      );
      expect(coldSignals).toHaveLength(0);
    });

    it("does NOT fire at or above staleness threshold (deal_stale fires instead)", async () => {
      const deal = makeDeal({ staleDays: 21 });
      const { repos, spies } = buildMockRepos({ deals: [deal] });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const coldSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_going_cold"
      );
      expect(coldSignals).toHaveLength(0);

      const staleSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_stale"
      );
      expect(staleSignals).toHaveLength(1);
    });

    it("respects doctrine-customized staleness threshold", async () => {
      // Doctrine lowers threshold to 10, so going_cold fires for 7-9
      const deal = makeDeal({ staleDays: 8 });
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        doctrine: { stalenessThresholdDays: 10 },
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const coldSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_going_cold"
      );
      expect(coldSignals).toHaveLength(1);

      // At threshold, deal_stale fires, not going_cold
      const deal2 = makeDeal({ id: "deal-2", staleDays: 10 });
      const { repos: repos2, spies: spies2 } = buildMockRepos({
        deals: [deal2],
        doctrine: { stalenessThresholdDays: 10 },
      });

      await runDetection({ companyId: COMPANY_ID, repos: repos2, logger: mockLogger });

      const coldSignals2 = spies2.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_going_cold"
      );
      expect(coldSignals2).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Stage filtering: deals outside scope are skipped
  // -----------------------------------------------------------------------

  describe("stage filtering", () => {
    it("skips deals outside intelligence stages when stageLabels are configured", async () => {
      const inScopeDeal = makeDeal({ id: "deal-in", stage: "stage-new", staleDays: 25 });
      const outOfScopeDeal = makeDeal({ id: "deal-out", stage: "stage-closed", staleDays: 25, dealName: "Closed Deal" });

      const { repos, spies } = buildMockRepos({
        deals: [inScopeDeal, outOfScopeDeal],
        doctrine: {
          stageLabels: { "stage-new": "New", "stage-opp": "Opportunity Validated", "stage-closed": "Closed won" },
          intelligenceStages: ["New", "Opportunity Validated"],
        },
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // Only 1 deal in scope (stage-new matches "New")
      expect(result.dealsScanned).toBe(1);
      expect(result.dealsSkippedByStage).toBe(1);
    });

    it("processes all deals when stageLabels is not configured", async () => {
      const deals = [
        makeDeal({ id: "deal-1", stage: "stage-a" }),
        makeDeal({ id: "deal-2", stage: "stage-b", dealName: "Beta" }),
      ];
      const { repos } = buildMockRepos({
        deals,
        doctrine: null, // no doctrine → no stageLabels
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.dealsScanned).toBe(2);
      expect(result.dealsSkippedByStage).toBe(0);
    });

    it("passes stageLabel to applyRules — New stage gets high-confidence next_step_missing", async () => {
      const deal = makeDeal({
        stage: "stage-new",
        lastActivityDate: new Date("2026-03-10T12:00:00Z"),
      });
      const facts = [
        makeFact({
          id: "f1",
          category: "objection_mentioned",
          label: "price",
          createdAt: new Date("2026-03-05T10:00:00Z"),
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
        doctrine: {
          stageLabels: { "stage-new": "New" },
          intelligenceStages: ["New"],
        },
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const nextStepSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "next_step_missing"
      );
      expect(nextStepSignals).toHaveLength(1);
      // New stage → high confidence for next_step_missing
      expect(callData(nextStepSignals[0]).confidence).toBe("high");
    });

    it("non-New stage gets medium-confidence next_step_missing", async () => {
      const deal = makeDeal({
        stage: "stage-opp",
        lastActivityDate: new Date("2026-03-10T12:00:00Z"),
      });
      const facts = [
        makeFact({
          id: "f1",
          category: "objection_mentioned",
          label: "price",
          createdAt: new Date("2026-03-05T10:00:00Z"),
        }),
      ];
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
        doctrine: {
          stageLabels: { "stage-opp": "Opportunity Validated" },
          intelligenceStages: ["Opportunity Validated"],
        },
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      const nextStepSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "next_step_missing"
      );
      expect(nextStepSignals).toHaveLength(1);
      expect(callData(nextStepSignals[0]).confidence).toBe("medium");
    });
  });

  // -----------------------------------------------------------------------
  // 4. Scope contraction cleanup: out-of-scope signals deleted
  // -----------------------------------------------------------------------

  describe("scope contraction cleanup", () => {
    it("calls deleteSignalsForOutOfScopeDeals when stage filtering is active", async () => {
      const deal = makeDeal({ stage: "stage-new" });
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        doctrine: {
          stageLabels: { "stage-new": "New" },
          intelligenceStages: ["New"],
        },
        scopeCleanupCount: 5,
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(spies.deleteSignalsForOutOfScopeDeals).toHaveBeenCalledWith(
        COMPANY_ID,
        expect.arrayContaining(["stage-new"]),
        expect.arrayContaining(DETECTION_MANAGED_TYPES)
      );
      expect(result.staleSignalsCleaned).toBe(5);
    });

    it("does NOT call scope cleanup when no stageLabels configured", async () => {
      const deal = makeDeal();
      const { repos, spies } = buildMockRepos({
        deals: [deal],
        doctrine: null,
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(spies.deleteSignalsForOutOfScopeDeals).not.toHaveBeenCalled();
      expect(result.staleSignalsCleaned).toBe(0);
    });

    it("does NOT call scope cleanup when lease was lost", async () => {
      const deals = [makeDeal({ id: "deal-1" })];
      const { repos, spies } = buildMockRepos({
        deals,
        doctrine: {
          stageLabels: { "stage-new": "New" },
          intelligenceStages: ["New"],
        },
        renewLeaseReturns: [true, false], // lost after first deal
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(spies.deleteSignalsForOutOfScopeDeals).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 5. Missing stageLabels fallback: all deals processed
  // -----------------------------------------------------------------------

  describe("missing stageLabels fallback", () => {
    it("processes all deals when doctrine has no stageLabels", async () => {
      const deals = [
        makeDeal({ id: "deal-1", stage: "any-stage-1" }),
        makeDeal({ id: "deal-2", stage: "any-stage-2", dealName: "Beta" }),
        makeDeal({ id: "deal-3", stage: "any-stage-3", dealName: "Gamma" }),
      ];
      const { repos } = buildMockRepos({
        deals,
        doctrine: { stalenessThresholdDays: 15 }, // has doctrine but no stageLabels
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.dealsScanned).toBe(3);
      expect(result.dealsSkippedByStage).toBe(0);
    });

    it("processes all deals when stageLabels is empty object", async () => {
      const deals = [
        makeDeal({ id: "deal-1", stage: "s1" }),
        makeDeal({ id: "deal-2", stage: "s2", dealName: "Beta" }),
      ];
      const { repos } = buildMockRepos({
        deals,
        doctrine: { stageLabels: {} },
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.dealsScanned).toBe(2);
      expect(result.dealsSkippedByStage).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Lead signals
  // -----------------------------------------------------------------------

  describe("lead signals", () => {
    it("lead_engaged — fires for Hunted status with new activity", async () => {
      const activityTs = new Date("2026-03-20T12:00:00Z");
      const company = makeHubspotCompany({ id: "hc-1", leadStatus: "Hunted" });
      const dealForCompany = makeDeal({ id: "lead-deal-1", stage: "stage-new" });

      const { repos, spies } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-1", [dealForCompany]]]),
        maxActivityTimestamp: activityTs,
        activityCount: 3,
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.leadSignalsCreated).toBe(1);
      const leadUpserts = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "lead_engaged"
      );
      expect(leadUpserts).toHaveLength(1);
      expect(callData(leadUpserts[0]).title).toContain("Lead Corp");
    });

    it("lead_ready_for_deal — fires for Qualified status with no in-scope deal", async () => {
      const activityTs = new Date("2026-03-20T12:00:00Z");
      const company = makeHubspotCompany({ id: "hc-1", leadStatus: "Qualified" });
      // Deal is NOT in intelligence stage scope
      const dealForCompany = makeDeal({ id: "lead-deal-1", stage: "stage-closed" });

      const { repos, spies } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-1", [dealForCompany]]]),
        maxActivityTimestamp: activityTs,
        activityCount: 1,
        doctrine: {
          stageLabels: { "stage-new": "New" },
          intelligenceStages: ["New"],
        },
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.leadSignalsCreated).toBe(1);
      const leadUpserts = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "lead_ready_for_deal"
      );
      expect(leadUpserts).toHaveLength(1);
    });

    it("lead_ready_for_deal — does NOT fire when deal is already in scope", async () => {
      const activityTs = new Date("2026-03-20T12:00:00Z");
      const company = makeHubspotCompany({ id: "hc-1", leadStatus: "Qualified" });
      // Deal IS in intelligence stage scope
      const dealForCompany = makeDeal({ id: "lead-deal-1", stage: "stage-new" });

      const { repos, spies } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-1", [dealForCompany]]]),
        maxActivityTimestamp: activityTs,
        activityCount: 1,
        doctrine: {
          stageLabels: { "stage-new": "New" },
          intelligenceStages: ["New"],
        },
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // Qualified with deal in scope → null signal type → no signal
      expect(result.leadSignalsCreated).toBe(0);
    });

    it("lead_re_engaged — fires for Nurture status", async () => {
      const activityTs = new Date("2026-03-20T12:00:00Z");
      const company = makeHubspotCompany({ id: "hc-1", leadStatus: "Nurture" });
      const dealForCompany = makeDeal({ id: "lead-deal-1", stage: "stage-new" });

      const { repos, spies } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-1", [dealForCompany]]]),
        maxActivityTimestamp: activityTs,
        activityCount: 2,
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.leadSignalsCreated).toBe(1);
      const leadUpserts = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "lead_re_engaged"
      );
      expect(leadUpserts).toHaveLength(1);
    });

    it("lead_re_engaged — also fires for 'Mauvais timing' status", async () => {
      const activityTs = new Date("2026-03-20T12:00:00Z");
      const company = makeHubspotCompany({ id: "hc-1", leadStatus: "Mauvais timing" });
      const dealForCompany = makeDeal({ id: "lead-deal-1", stage: "stage-new" });

      const { repos, spies } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-1", [dealForCompany]]]),
        maxActivityTimestamp: activityTs,
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.leadSignalsCreated).toBe(1);
      const leadUpserts = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "lead_re_engaged"
      );
      expect(leadUpserts).toHaveLength(1);
    });

    it("no lead signal for Nouveau status", async () => {
      const activityTs = new Date("2026-03-20T12:00:00Z");
      const company = makeHubspotCompany({ id: "hc-1", leadStatus: "Nouveau" });
      const dealForCompany = makeDeal({ id: "lead-deal-1", stage: "stage-new" });

      const { repos } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-1", [dealForCompany]]]),
        maxActivityTimestamp: activityTs,
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.leadSignalsCreated).toBe(0);
    });

    it("no lead signal when company has no deals", async () => {
      const company = makeHubspotCompany({ id: "hc-1", leadStatus: "Hunted" });

      const { repos } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-1", []]]),
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.leadSignalsCreated).toBe(0);
    });

    it("updates sourceCursor after lead signal creation", async () => {
      const activityTs = new Date("2026-03-20T12:00:00Z");
      const company = makeHubspotCompany({ id: "hc-1", leadStatus: "Hunted" });
      const dealForCompany = makeDeal({ id: "lead-deal-1", stage: "stage-new" });

      const { repos, spies } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-1", [dealForCompany]]]),
        maxActivityTimestamp: activityTs,
        activityCount: 1,
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // sourceCursor.upsert should be called within the transaction
      expect(spies.txCursorUpsert).toHaveBeenCalled();
      const cursorCall = spies.txCursorUpsert.mock.calls[0][0] as any;
      expect(cursorCall.create.source).toBe("lead-detect:hc-1");
      expect(cursorCall.create.cursor).toContain("Hunted");
    });
  });

  // -----------------------------------------------------------------------
  // 7. Lead cursor prevents re-fire
  // -----------------------------------------------------------------------

  describe("lead cursor prevents re-fire", () => {
    it("does NOT fire when cursor matches current state (no new activity, same status)", async () => {
      const company = makeHubspotCompany({ id: "hc-1", leadStatus: "Hunted" });
      const dealForCompany = makeDeal({ id: "lead-deal-1", stage: "stage-new" });
      const cursorTs = new Date("2026-03-20T12:00:00Z");

      const { repos } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-1", [dealForCompany]]]),
        maxActivityTimestamp: null, // no activity after cursor
        cursorValues: new Map([
          [`lead-detect:hc-1`, `${cursorTs.toISOString()}|Hunted`],
        ]),
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // No new activity and status unchanged → no signal
      expect(result.leadSignalsCreated).toBe(0);
    });

    it("fires when status changed even without new activity", async () => {
      const company = makeHubspotCompany({ id: "hc-1", leadStatus: "Nurture" });
      const dealForCompany = makeDeal({ id: "lead-deal-1", stage: "stage-new" });
      const cursorTs = new Date("2026-03-20T12:00:00Z");

      const { repos } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-1", [dealForCompany]]]),
        maxActivityTimestamp: null, // no new activity
        cursorValues: new Map([
          [`lead-detect:hc-1`, `${cursorTs.toISOString()}|Hunted`], // was Hunted, now Nurture
        ]),
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.leadSignalsCreated).toBe(1);
    });

    it("fires when new activity exists after cursor timestamp", async () => {
      const company = makeHubspotCompany({ id: "hc-1", leadStatus: "Hunted" });
      const dealForCompany = makeDeal({ id: "lead-deal-1", stage: "stage-new" });
      const cursorTs = new Date("2026-03-20T12:00:00Z");
      const newActivityTs = new Date("2026-03-22T12:00:00Z");

      const { repos } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-1", [dealForCompany]]]),
        maxActivityTimestamp: newActivityTs,
        activityCount: 2,
        cursorValues: new Map([
          [`lead-detect:hc-1`, `${cursorTs.toISOString()}|Hunted`],
        ]),
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.leadSignalsCreated).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Lead orphan cleanup
  // -----------------------------------------------------------------------

  describe("lead orphan cleanup", () => {
    it("calls deleteOrphanedLeadSignals after processing all companies", async () => {
      const company = makeHubspotCompany({ id: "hc-1", leadStatus: "Hunted" });
      const dealForCompany = makeDeal({ id: "lead-deal-1", stage: "stage-new" });

      const { repos, spies } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-1", [dealForCompany]]]),
        maxActivityTimestamp: new Date("2026-03-20T12:00:00Z"),
        orphanCleanupResult: { count: 3, cursorsCleaned: 2 },
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(spies.deleteOrphanedLeadSignals).toHaveBeenCalledWith(
        COMPANY_ID,
        expect.arrayContaining(["hc-1"]),
        expect.arrayContaining(LEAD_MANAGED_TYPES)
      );
      expect(result.leadOrphansCleaned).toBe(3);
    });

    it("includes companies with no lead signal in processedCompanyIds (for orphan cleanup)", async () => {
      // Company with "Nouveau" status gets no signal but should still be in processedIds
      const company = makeHubspotCompany({ id: "hc-1", leadStatus: "Nouveau" });
      const dealForCompany = makeDeal({ id: "lead-deal-1", stage: "stage-new" });

      const { repos, spies } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-1", [dealForCompany]]]),
        maxActivityTimestamp: new Date("2026-03-20T12:00:00Z"),
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // hc-1 should still be in processedCompanyIds even though no signal was created
      expect(spies.deleteOrphanedLeadSignals).toHaveBeenCalledWith(
        COMPANY_ID,
        expect.arrayContaining(["hc-1"]),
        expect.any(Array)
      );
    });

    it("includes companies with errors in processedCompanyIds", async () => {
      const company = makeHubspotCompany({ id: "hc-error", leadStatus: "Hunted" });

      const { repos, spies } = buildMockRepos({
        hubspotCompanies: [company],
      });
      // listDealsByHubspotCompany will throw
      spies.listDealsByHubspotCompany.mockRejectedValue(new Error("DB error"));

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      // Even with error, company should be in processedIds
      expect(spies.deleteOrphanedLeadSignals).toHaveBeenCalledWith(
        COMPANY_ID,
        expect.arrayContaining(["hc-error"]),
        expect.any(Array)
      );
    });
  });

  // -----------------------------------------------------------------------
  // 9. Lease checkpoints
  // -----------------------------------------------------------------------

  describe("lease checkpoints", () => {
    it("calls renewLease before and after each deal", async () => {
      const deals = [
        makeDeal({ id: "deal-1" }),
        makeDeal({ id: "deal-2", dealName: "Beta Corp" }),
      ];
      const { repos, spies } = buildMockRepos({ deals });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // 2 deals x 2 checkpoints (pre + post) = 4, plus lead detection checkpoints
      expect(spies.renewLease.mock.calls.length).toBeGreaterThanOrEqual(4);
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
      const { repos, spies } = buildMockRepos({
        deals,
        renewLeaseReturns: [true, true, true, true, false],
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.dealsScanned).toBe(2);
      expect(spies.transaction).toHaveBeenCalledTimes(2);
    });

    it("does NOT finalize the run when lease is lost", async () => {
      const deals = [
        makeDeal({ id: "deal-1" }),
        makeDeal({ id: "deal-2" }),
      ];
      const { repos, spies } = buildMockRepos({
        deals,
        renewLeaseReturns: [true, false],
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(spies.finalizeSyncRun).not.toHaveBeenCalled();
    });

    it("finalizeSyncRun called with 'completed' and all result fields", async () => {
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
          dealsSkippedByStage: expect.any(Number),
          staleSignalsCleaned: expect.any(Number),
          leadSignalsCreated: expect.any(Number),
          leadOrphansCleaned: expect.any(Number),
        }),
        expect.any(Array)
      );
    });
  });

  // -----------------------------------------------------------------------
  // 10. DETECTION_MANAGED_TYPES and LEAD_MANAGED_TYPES
  // -----------------------------------------------------------------------

  describe("managed type constants", () => {
    it("DETECTION_MANAGED_TYPES has exactly 10 entries including deal_going_cold", () => {
      expect(DETECTION_MANAGED_TYPES).toHaveLength(10);
      expect(DETECTION_MANAGED_TYPES).toContain("competitor_mentioned");
      expect(DETECTION_MANAGED_TYPES).toContain("blocker_identified");
      expect(DETECTION_MANAGED_TYPES).toContain("next_step_missing");
      expect(DETECTION_MANAGED_TYPES).toContain("urgent_timeline");
      expect(DETECTION_MANAGED_TYPES).toContain("deal_stale");
      expect(DETECTION_MANAGED_TYPES).toContain("deal_going_cold");
      expect(DETECTION_MANAGED_TYPES).toContain("positive_momentum");
      expect(DETECTION_MANAGED_TYPES).toContain("negative_momentum");
      expect(DETECTION_MANAGED_TYPES).toContain("champion_identified");
      expect(DETECTION_MANAGED_TYPES).toContain("budget_surfaced");
    });

    it("LEAD_MANAGED_TYPES has exactly 3 entries", () => {
      expect(LEAD_MANAGED_TYPES).toHaveLength(3);
      expect(LEAD_MANAGED_TYPES).toContain("lead_engaged");
      expect(LEAD_MANAGED_TYPES).toContain("lead_ready_for_deal");
      expect(LEAD_MANAGED_TYPES).toContain("lead_re_engaged");
    });

    it("passes the correct managed types (10) to deleteDetectionSignalsForDeal", async () => {
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
        "deal_going_cold",
        "positive_momentum",
        "negative_momentum",
        "champion_identified",
        "budget_surfaced",
      ]));
      expect(calledTypes).toHaveLength(10);
    });
  });

  // -----------------------------------------------------------------------
  // Additional edge cases and existing test coverage
  // -----------------------------------------------------------------------

  describe("delete-and-replace", () => {
    it("deletes existing detection-managed signals before re-emission", async () => {
      const deal = makeDeal({ staleDays: 25 });
      const { repos, spies } = buildMockRepos({ deals: [deal] });
      spies.deleteDetectionSignalsForDeal.mockResolvedValue({ count: 3 });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(spies.deleteDetectionSignalsForDeal).toHaveBeenCalledWith(
        "deal-1",
        expect.arrayContaining(DETECTION_MANAGED_TYPES),
        expect.anything()
      );
      expect(result.signalsRemoved).toBe(3);
    });
  });

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

  describe("stale deal — doctrine threshold", () => {
    it("uses doctrine stalenessThresholdDays when available", async () => {
      const deal = makeDeal({ staleDays: 15 });
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
      const deal = makeDeal({ staleDays: 15 });
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
        doctrine: { stalenessThresholdDays: 30 },
      });

      // explicit param is used as initial value, then doctrine overrides it
      await runDetection({
        companyId: COMPANY_ID,
        repos,
        logger: mockLogger,
        stalenessThresholdDays: 5,
      });

      const staleSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_stale"
      );
      // doctrine { stalenessThresholdDays: 30 } overrides param 5, so 8 < 30 → no signal
      expect(staleSignals).toHaveLength(0);
    });
  });

  describe("atomicity", () => {
    it("calls transaction once per deal", async () => {
      const deals = [
        makeDeal({ id: "deal-1" }),
        makeDeal({ id: "deal-2", dealName: "Beta Corp" }),
        makeDeal({ id: "deal-3", dealName: "Gamma Inc" }),
      ];
      const { repos, spies } = buildMockRepos({ deals });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // At least 3 for deal processing (lead detection may add more)
      expect(spies.transaction.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("processes each deal within its own transaction scope", async () => {
      const deals = [
        makeDeal({ id: "deal-1", staleDays: 25 }),
        makeDeal({ id: "deal-2", staleDays: 30, dealName: "Stale Beta" }),
      ];
      const { repos, spies } = buildMockRepos({ deals });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(spies.deleteDetectionSignalsForDeal).toHaveBeenCalledTimes(2);
      expect(spies.deleteDetectionSignalsForDeal.mock.calls[0][0]).toBe("deal-1");
      expect(spies.deleteDetectionSignalsForDeal.mock.calls[1][0]).toBe("deal-2");
    });
  });

  describe("source-event-time determinism", () => {
    it("signal IDs depend on deal.lastActivityDate, not wall clock", async () => {
      const fixedDate = new Date("2026-03-10T12:00:00Z");
      const deal = makeDeal({ staleDays: 25, lastActivityDate: fixedDate });

      const { repos: repos1, spies: spies1 } = buildMockRepos({ deals: [deal] });
      const { repos: repos2, spies: spies2 } = buildMockRepos({ deals: [deal] });

      await runDetection({ companyId: COMPANY_ID, repos: repos1, logger: mockLogger });
      await runDetection({ companyId: COMPANY_ID, repos: repos2, logger: mockLogger });

      const staleSignals1 = spies1.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_stale"
      );
      const staleSignals2 = spies2.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "deal_stale"
      );

      expect(staleSignals1).toHaveLength(1);
      expect(staleSignals2).toHaveLength(1);
      expect(callData(staleSignals1[0]).id).toBe(callData(staleSignals2[0]).id);
    });

    it("momentum window is relative to lastActivityDate, not current time", async () => {
      const lastActivity = new Date("2025-06-01T12:00:00Z");
      const deal = makeDeal({ lastActivityDate: lastActivity });
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

      const positiveSignals = spies.txUpsert.mock.calls.filter(
        (c: any) => c[0].create.signalType === "positive_momentum"
      );
      expect(positiveSignals).toHaveLength(1);
    });
  });

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

      const { repos: repos1 } = buildMockRepos({
        deals: [deal],
        factsPerDeal: new Map([["deal-1", facts]]),
      });
      const { repos: repos2 } = buildMockRepos({
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

  describe("ISO-week key from source time", () => {
    it("deals with different lastActivityDate weeks produce different signal IDs", async () => {
      const dealWeek11 = makeDeal({
        id: "deal-w11",
        staleDays: 30,
        lastActivityDate: new Date("2026-03-10T12:00:00Z"),
      });
      const dealWeek12 = makeDeal({
        id: "deal-w12",
        staleDays: 30,
        lastActivityDate: new Date("2026-03-18T12:00:00Z"),
      });

      const { repos: repos1, spies: spies1 } = buildMockRepos({ deals: [dealWeek11] });
      await runDetection({ companyId: COMPANY_ID, repos: repos1, logger: mockLogger });

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
      expect(staleId1).not.toBe(staleId2);
    });

    it("same deal in same ISO-week produces same signal ID", async () => {
      const dealMonday = makeDeal({
        id: "deal-x",
        staleDays: 30,
        lastActivityDate: new Date("2026-03-09T08:00:00Z"),
      });
      const dealFriday = makeDeal({
        id: "deal-x",
        staleDays: 30,
        lastActivityDate: new Date("2026-03-13T18:00:00Z"),
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

      const expectedId = salesSignalDbId(COMPANY_ID, ["positive_momentum", "deal-m", "2026-W11"]);
      expect(callData(positiveSignal!).id).toBe(expectedId);
    });
  });

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

  describe("edge cases", () => {
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
      const expectedId = salesSignalDbId(COMPANY_ID, ["deal_stale", "deal-null-date", "unknown"]);
      expect(callData(staleSignal!).id).toBe(expectedId);
    });

    it("errors on individual deals are captured but do not abort the run", async () => {
      const deals = [
        makeDeal({ id: "deal-1" }),
        makeDeal({ id: "deal-2", dealName: "Beta" }),
      ];

      const { repos, spies } = buildMockRepos({ deals });

      let txCallCount = 0;
      spies.transaction.mockImplementation(async (fn: any) => {
        txCallCount++;
        if (txCallCount === 1) {
          throw new Error("DB timeout on deal-1");
        }
        return fn({
          salesSignal: { upsert: spies.txUpsert },
          sourceCursor: { upsert: vi.fn<any>().mockResolvedValue({}) },
        });
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result.dealsScanned).toBe(2);
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
      const facts = [
        makeFact({
          id: "f1",
          category: "sentiment",
          label: "deal_sentiment",
          extractedValue: "positive",
          createdAt: new Date("2026-01-09T10:00:00Z"),
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

    it("facts after lastActivityDate are excluded from momentum window", async () => {
      const lastActivity = new Date("2026-03-10T12:00:00Z");
      const deal = makeDeal({ lastActivityDate: lastActivity });
      const facts = [
        makeFact({
          id: "f1",
          category: "sentiment",
          label: "deal_sentiment",
          extractedValue: "negative",
          createdAt: new Date("2026-03-15T10:00:00Z"),
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

    it("DetectionResult includes all new fields", async () => {
      const { repos } = buildMockRepos({ deals: [] });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      expect(result).toHaveProperty("signalsCreated");
      expect(result).toHaveProperty("signalsRemoved");
      expect(result).toHaveProperty("dealsScanned");
      expect(result).toHaveProperty("dealsSkippedByStage");
      expect(result).toHaveProperty("staleSignalsCleaned");
      expect(result).toHaveProperty("leadSignalsCreated");
      expect(result).toHaveProperty("leadOrphansCleaned");
      expect(result).toHaveProperty("errors");
    });
  });

  // -----------------------------------------------------------------------
  // Merge-blocker targeted tests
  // -----------------------------------------------------------------------

  describe("merge blockers", () => {
    it("explicit empty intelligenceStages means no deals in scope + cleanup deletes all managed signals", async () => {
      const deals = [makeDeal({ stage: "stage-new" }), makeDeal({ id: "deal-2", stage: "stage-opp" })];
      const { repos, spies } = buildMockRepos({
        deals,
        doctrine: {
          stageLabels: { "stage-new": "New", "stage-opp": "Opportunity Validated" },
          intelligenceStages: [], // explicitly empty
        },
        scopeCleanupCount: 5,
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // No deals processed
      expect(result.dealsScanned).toBe(0);
      expect(result.dealsSkippedByStage).toBe(2);
      // Cleanup was called (empty [] passed to deleteSignalsForOutOfScopeDeals means all deals out of scope)
      expect(spies.deleteSignalsForOutOfScopeDeals).toHaveBeenCalledWith(
        COMPANY_ID, [], expect.any(Array)
      );
      expect(result.staleSignalsCleaned).toBe(5);
      // No signals created
      expect(result.signalsCreated).toBe(0);
    });

    it("lead status change from signaling to non-signaling deletes prior signal and persists cursor", async () => {
      const company = makeHubspotCompany({ id: "hc-ns", leadStatus: "Nouveau" }); // non-signaling
      const deal = makeDeal();
      const { repos, spies } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-ns", [deal]]]),
        maxActivityTimestamp: new Date("2026-03-10T12:00:00Z"),
        cursorValues: new Map([
          // Previous cursor had "Hunted" (signaling) status
          ["lead-detect:hc-ns", "2026-03-09T10:00:00.000Z|Hunted"],
        ]),
        activityCount: 0,
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // deleteLeadSignalsForCompany should be called inside the transaction
      expect(spies.deleteLeadSignalsForCompany).toHaveBeenCalled();
      // Cursor should be updated with new status "Nouveau"
      expect(spies.txCursorUpsert).toHaveBeenCalled();
      const cursorCall = spies.txCursorUpsert.mock.calls[0][0] as any;
      expect(cursorCall.create.cursor).toContain("Nouveau");
      // No new signal created (non-signaling status)
      expect(spies.txUpsert).not.toHaveBeenCalled();
      expect(result.leadSignalsCreated).toBe(0);
    });

    it("first-run backlog counting with multiple historical events reports real count", async () => {
      const company = makeHubspotCompany({ id: "hc-backlog", leadStatus: "Hunted" });
      const deal = makeDeal();
      const { repos, spies } = buildMockRepos({
        hubspotCompanies: [company],
        dealsByHubspotCompany: new Map([["hc-backlog", [deal]]]),
        maxActivityTimestamp: new Date("2026-03-15T12:00:00Z"),
        // No cursor = first run
        cursorValues: new Map(),
        activityCount: 7, // 7 historical activities
      });

      await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // countActivitiesForDealsSince should be called with epoch (new Date(0)) for first-run backlog
      expect(spies.countActivitiesForDealsSince).toHaveBeenCalledWith(
        [deal.id], new Date(0)
      );
      // Signal metadata should report real count
      expect(spies.txUpsert).toHaveBeenCalled();
      const signalCreate = (spies.txUpsert.mock.calls[0] as any)[0]?.create;
      expect(signalCreate.metadataJson.newActivityCount).toBe(7);
    });

    it("cursor-only orphan: cursor exists but no signal row — both are cleaned", async () => {
      // Test the real deleteOrphanedLeadSignals logic, not a mock return value.
      // We construct a SalesRepositoryBundle with a mocked PrismaClient that
      // returns realistic query results simulating a cursor-only orphan.

      const { SalesRepositoryBundle: RealBundle } = await import("../src/sales/db/sales-repositories.js");

      const mockPrisma = {
        // salesSignal.findMany returns NO signal rows (the signal was already deleted)
        salesSignal: {
          findMany: vi.fn<any>().mockResolvedValue([]),
          deleteMany: vi.fn<any>().mockResolvedValue({ count: 0 }),
        },
        // sourceCursor.findMany returns a cursor for company "orphan-hc" that is NOT in processedCompanyIds
        sourceCursor: {
          findMany: vi.fn<any>().mockResolvedValue([
            { source: "lead-detect:orphan-hc" },
          ]),
          deleteMany: vi.fn<any>().mockResolvedValue({ count: 1 }),
        },
      } as any;

      const bundle = new RealBundle(mockPrisma);
      const result = await bundle.deleteOrphanedLeadSignals(
        COMPANY_ID,
        [], // no companies were processed this run
        ["lead_engaged", "lead_ready_for_deal", "lead_re_engaged"]
      );

      // Signal query was made (found nothing)
      expect(mockPrisma.salesSignal.findMany).toHaveBeenCalled();
      // Cursor query was made and found the orphan
      expect(mockPrisma.sourceCursor.findMany).toHaveBeenCalledWith({
        where: { companyId: COMPANY_ID, source: { startsWith: "lead-detect:" } },
        select: { source: true },
      });
      // Cursor was deleted for orphan-hc (discovered from cursor row, not signal row)
      expect(mockPrisma.sourceCursor.deleteMany).toHaveBeenCalledWith({
        where: { companyId: COMPANY_ID, source: "lead-detect:orphan-hc" },
      });
      // No signals deleted (none existed), but cursor was cleaned
      expect(result.count).toBe(0);
      expect(result.cursorsCleaned).toBe(1);
    });

    it("default intelligenceStages uses 'Opportunity Validated' with capital V", async () => {
      const deals = [
        makeDeal({ id: "d1", stage: "s1" }),
        makeDeal({ id: "d2", stage: "s2" }),
      ];
      const { repos } = buildMockRepos({
        deals,
        doctrine: {
          stageLabels: { s1: "New", s2: "Opportunity Validated" },
          // intelligenceStages NOT set → should default to ["New", "Opportunity Validated"]
        },
      });

      const result = await runDetection({ companyId: COMPANY_ID, repos, logger: mockLogger });

      // Both deals should be in scope (matching the default with capital V)
      expect(result.dealsScanned).toBe(2);
      expect(result.dealsSkippedByStage).toBe(0);
    });
  });
});
