import { describe, expect, it, vi } from "vitest";
import {
  salesDealDbId,
  salesContactDbId,
  salesHubspotCompanyDbId,
  salesActivityDbId,
  salesSignalDbId,
  salesExtractedFactDbId,
  salesRecommendationDbId,
  salesDoctrineDbId,
  SalesRepositoryBundle,
} from "../src/sales/db/sales-repositories.js";

describe("sales deterministic ID helpers", () => {
  it("salesDealDbId is deterministic", () => {
    const a = salesDealDbId("c1", "hs-deal-1");
    const b = salesDealDbId("c1", "hs-deal-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^sd_/);
  });

  it("salesDealDbId differs for different inputs", () => {
    const a = salesDealDbId("c1", "hs-deal-1");
    const b = salesDealDbId("c1", "hs-deal-2");
    expect(a).not.toBe(b);
  });

  it("salesContactDbId is deterministic", () => {
    const a = salesContactDbId("c1", "hs-contact-1");
    const b = salesContactDbId("c1", "hs-contact-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^sc_/);
  });

  it("salesHubspotCompanyDbId is deterministic", () => {
    const a = salesHubspotCompanyDbId("c1", "hs-co-1");
    const b = salesHubspotCompanyDbId("c1", "hs-co-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^shc_/);
  });

  it("salesActivityDbId is deterministic", () => {
    const a = salesActivityDbId("c1", "hs-eng-1");
    const b = salesActivityDbId("c1", "hs-eng-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^sa_/);
  });

  it("salesSignalDbId is deterministic", () => {
    const a = salesSignalDbId("c1", ["feature_shipped", "sso", "2026-w12"]);
    const b = salesSignalDbId("c1", ["feature_shipped", "sso", "2026-w12"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^ss_/);
  });

  it("salesExtractedFactDbId is deterministic", () => {
    const a = salesExtractedFactDbId("c1", ["act-1", "objection_mentioned", "abc123"]);
    const b = salesExtractedFactDbId("c1", ["act-1", "objection_mentioned", "abc123"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^sef_/);
  });

  it("salesRecommendationDbId is deterministic", () => {
    const a = salesRecommendationDbId("c1", "deal-1", "signal-1");
    const b = salesRecommendationDbId("c1", "deal-1", "signal-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^sr_/);
  });

  it("salesDoctrineDbId is deterministic", () => {
    const a = salesDoctrineDbId("c1", 1);
    const b = salesDoctrineDbId("c1", 1);
    expect(a).toBe(b);
    expect(a).toMatch(/^sdoc_/);
  });
});

// ---------------------------------------------------------------------------
// getExtractionStatus — scoped vs unscoped
// ---------------------------------------------------------------------------

describe("getExtractionStatus", () => {
  function buildPrisma(counters: {
    activities?: number;
    processedActivities?: number;
    deals?: number;
    facts?: number;
    signals?: number;
  }) {
    // Each count call returns the next value from the configured counters.
    // Call order in getExtractionStatus:
    //   0: totalActivities, 1: processedActivities, 2: deals, 3: facts, 4: signals
    const activityCountCalls: number[] = [
      counters.activities ?? 0,
      counters.processedActivities ?? 0,
    ];
    let activityIdx = 0;

    return {
      salesActivity: {
        count: vi.fn().mockImplementation(() => {
          return Promise.resolve(activityCountCalls[activityIdx++] ?? 0);
        }),
      },
      salesDeal: {
        count: vi.fn().mockResolvedValue(counters.deals ?? 0),
      },
      salesExtractedFact: {
        count: vi.fn().mockResolvedValue(counters.facts ?? 0),
      },
      salesSignal: {
        count: vi.fn().mockResolvedValue(counters.signals ?? 0),
      },
    } as any;
  }

  it("scopes all counters to intelligence stages when provided", async () => {
    const prisma = buildPrisma({
      activities: 100,
      processedActivities: 30,
      deals: 10,
      facts: 50,
      signals: 8,
    });
    const repos = new SalesRepositoryBundle(prisma);
    const result = await repos.getExtractionStatus("c1", ["stage-new", "stage-opp"]);

    expect(result.totalActivities).toBe(100);
    expect(result.processedActivities).toBe(30);
    expect(result.unprocessedActivities).toBe(70);
    expect(result.totalDeals).toBe(10);
    expect(result.totalFacts).toBe(50);
    expect(result.totalSignals).toBe(8);
    expect(result.processingRate).toBe(30);

    // Verify facts and signals received stage-scoped where clauses
    const factWhere = prisma.salesExtractedFact.count.mock.calls[0][0].where;
    expect(factWhere.deal).toEqual({ stage: { in: ["stage-new", "stage-opp"] } });

    const signalWhere = prisma.salesSignal.count.mock.calls[0][0].where;
    expect(signalWhere.deal).toEqual({ stage: { in: ["stage-new", "stage-opp"] } });
  });

  it("returns unscoped counters when no stage IDs provided", async () => {
    const prisma = buildPrisma({
      activities: 200,
      processedActivities: 200,
      deals: 20,
      facts: 100,
      signals: 15,
    });
    const repos = new SalesRepositoryBundle(prisma);
    const result = await repos.getExtractionStatus("c1");

    expect(result.totalActivities).toBe(200);
    expect(result.processingRate).toBe(100);

    // Facts should NOT have a deal.stage filter
    const factWhere = prisma.salesExtractedFact.count.mock.calls[0][0].where;
    expect(factWhere.deal).toBeUndefined();
  });

  it("returns unscoped counters when empty stage array provided", async () => {
    const prisma = buildPrisma({ activities: 50, processedActivities: 10 });
    const repos = new SalesRepositoryBundle(prisma);
    const result = await repos.getExtractionStatus("c1", []);

    // Empty array = unscoped
    const factWhere = prisma.salesExtractedFact.count.mock.calls[0][0].where;
    expect(factWhere.deal).toBeUndefined();
  });

  it("returns 0 processing rate when no activities exist", async () => {
    const prisma = buildPrisma({ activities: 0, processedActivities: 0 });
    const repos = new SalesRepositoryBundle(prisma);
    const result = await repos.getExtractionStatus("c1");

    expect(result.processingRate).toBe(0);
    expect(result.unprocessedActivities).toBe(0);
  });
});
