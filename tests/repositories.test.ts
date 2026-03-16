import { describe, expect, it, vi } from "vitest";

import type { EvidenceReference } from "../src/domain/types.js";
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
