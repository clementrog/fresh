import { describe, expect, it, vi } from "vitest";

import type { EvidenceReference, ScreeningResult } from "../src/domain/types.js";
import { RepositoryBundle, validateOpportunityPrimaryEvidence } from "../src/db/repositories.js";

describe("repository evidence validation", () => {
  it("rejects a primary evidence id that does not belong to the opportunity evidence set", () => {
    const evidence: EvidenceReference[] = [
      {
        id: "evidence_1",
        source: "notion",
        sourceItemId: "source-1",
        sourceUrl: "https://example.com",
        timestamp: new Date().toISOString(),
        excerpt: "Proof",
        excerptHash: "hash-1",
        freshnessScore: 0.9
      }
    ];

    expect(() => validateOpportunityPrimaryEvidence(evidence, "evidence_2")).toThrow(
      "Primary evidence id must reference an evidence row owned by the opportunity."
    );
  });
});

describe("market research repository helpers", () => {
  it("lists active market queries in priority order", async () => {
    const prisma = {
      marketQuery: {
        findMany: vi.fn(async () => ([
          {
            id: "mq-2",
            companyId: "company-1",
            query: "Second",
            enabled: true,
            priority: 2,
            createdAt: new Date("2026-03-14T09:00:00.000Z"),
            updatedAt: new Date("2026-03-14T09:00:00.000Z")
          },
          {
            id: "mq-1",
            companyId: "company-1",
            query: "First",
            enabled: true,
            priority: 1,
            createdAt: new Date("2026-03-14T08:00:00.000Z"),
            updatedAt: new Date("2026-03-14T08:00:00.000Z")
          }
        ]))
      }
    } as any;

    const repositories = new RepositoryBundle(prisma);
    const queries = await repositories.listActiveMarketQueries("company-1");

    expect(prisma.marketQuery.findMany).toHaveBeenCalledWith({
      where: {
        companyId: "company-1",
        enabled: true
      },
      orderBy: [
        { priority: "asc" },
        { createdAt: "asc" }
      ]
    });
    expect(queries.map((query) => query.id)).toEqual(["mq-2", "mq-1"]);
    expect(queries[0]?.createdAt).toBe("2026-03-14T09:00:00.000Z");
  });

  it("saveScreeningResults reports missing rows instead of throwing", async () => {
    const prisma = {
      sourceItem: {
        updateMany: vi.fn(async () => ({ count: 0 }))
      }
    } as any;

    const repositories = new RepositoryBundle(prisma);
    const result: ScreeningResult = {
      decision: "skip",
      rationale: "test",
      createOrEnrich: "unknown",
      relevanceScore: 0.5,
      sensitivityFlag: false,
      sensitivityCategories: []
    };

    const { missingIds } = await repositories.saveScreeningResults([
      { id: "si_nonexistent", result }
    ]);

    expect(missingIds).toEqual(["si_nonexistent"]);
    expect(prisma.sourceItem.updateMany).toHaveBeenCalledWith({
      where: { id: "si_nonexistent" },
      data: { screeningResultJson: expect.any(Object) }
    });
  });

  it("saveScreeningResults returns empty missingIds when all rows exist", async () => {
    const prisma = {
      sourceItem: {
        updateMany: vi.fn(async () => ({ count: 1 }))
      }
    } as any;

    const repositories = new RepositoryBundle(prisma);
    const result: ScreeningResult = {
      decision: "retain",
      rationale: "relevant",
      createOrEnrich: "create",
      relevanceScore: 0.8,
      sensitivityFlag: false,
      sensitivityCategories: []
    };

    const { missingIds } = await repositories.saveScreeningResults([
      { id: "si_exists", result }
    ]);

    expect(missingIds).toEqual([]);
  });

  it("saveScreeningResults handles mixed batch where one row exists and one is missing", async () => {
    const updateMany = vi.fn(async (args: { where: { id: string } }) =>
      args.where.id === "si_exists" ? { count: 1 } : { count: 0 }
    );
    const prisma = { sourceItem: { updateMany } } as any;

    const repositories = new RepositoryBundle(prisma);
    const retain: ScreeningResult = {
      decision: "retain", rationale: "good", createOrEnrich: "create",
      relevanceScore: 0.8, sensitivityFlag: false, sensitivityCategories: []
    };
    const skip: ScreeningResult = {
      decision: "skip", rationale: "noise", createOrEnrich: "unknown",
      relevanceScore: 0.1, sensitivityFlag: false, sensitivityCategories: []
    };

    const { missingIds } = await repositories.saveScreeningResults([
      { id: "si_exists", result: retain },
      { id: "si_gone", result: skip }
    ]);

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(missingIds).toEqual(["si_gone"]);
  });

  it("looks up source items by company, source, and source item id", async () => {
    const prisma = {
      sourceItem: {
        findUnique: vi.fn(async () => ({
          id: "si-1",
          fingerprint: "fp-1"
        }))
      }
    } as any;

    const repositories = new RepositoryBundle(prisma);
    const row = await repositories.findSourceItemBySourceKey({
      companyId: "company-1",
      source: "market-research",
      sourceItemId: "market-query:mq-1:set:abc"
    });

    expect(prisma.sourceItem.findUnique).toHaveBeenCalledWith({
      where: {
        companyId_source_sourceItemId: {
          companyId: "company-1",
          source: "market-research",
          sourceItemId: "market-query:mq-1:set:abc"
        }
      }
    });
    expect(row).toEqual({
      id: "si-1",
      fingerprint: "fp-1"
    });
  });
});
