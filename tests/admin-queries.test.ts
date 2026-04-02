import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AdminQueries } from "../src/admin/queries.js";

// ── Mock Prisma ──────────────────────────────────────────────────────────────

function mockPrisma() {
  return {
    company: { findUnique: vi.fn() },
    sourceItem: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null)
    },
    opportunity: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null)
    },
    draft: { count: vi.fn(async () => 0) },
    syncRun: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => [])
    },
    user: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => [])
    }
  } as any;
}

// ── Disposition query shape ─────────────────────────────────────────────────

describe("disposition query shape", () => {
  it("orphaned includes evidence-path checks and DbNull-guarded NOT exclusions", async () => {
    const prisma = mockPrisma();
    const queries = new AdminQueries(prisma);

    await queries.countSourceItems("comp_1", { disposition: "orphaned" });

    const where = prisma.sourceItem.count.mock.calls[0][0].where;

    expect(where.evidenceReferences.every.opportunityId).toBeNull();
    expect(where.evidenceReferences.every.opportunityLinks).toEqual({ none: {} });
    expect(where.evidenceReferences.every.primaryForOpportunities).toEqual({ none: {} });
    expect(where.processedAt).toEqual({ not: null });

    // NOT elements are AND-guarded with DbNull existence checks
    expect(where.NOT).toHaveLength(3);
    for (const notClause of where.NOT) {
      expect(notClause.AND).toBeDefined();
      expect(notClause.AND.length).toBe(2);
    }
  });

  it("blocked uses OR with harmful and reframeable", async () => {
    const prisma = mockPrisma();
    const queries = new AdminQueries(prisma);

    await queries.countSourceItems("comp_1", { disposition: "blocked" });

    const where = prisma.sourceItem.count.mock.calls[0][0].where;

    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ metadataJson: { path: ["publishabilityRisk"], equals: "harmful" } });
    expect(where.OR[1]).toEqual({ metadataJson: { path: ["publishabilityRisk"], equals: "reframeable" } });
  });

  it("single disposition merges directly without OR wrapper", async () => {
    const prisma = mockPrisma();
    const queries = new AdminQueries(prisma);

    await queries.countSourceItems("comp_1", { disposition: "blocked" });

    const where = prisma.sourceItem.count.mock.calls[0][0].where;

    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ metadataJson: { path: ["publishabilityRisk"], equals: "harmful" } });
  });

  it("no disposition omits disposition clauses entirely", async () => {
    const prisma = mockPrisma();
    const queries = new AdminQueries(prisma);

    await queries.countSourceItems("comp_1", {});

    const where = prisma.sourceItem.count.mock.calls[0][0].where;

    expect(where.OR).toBeUndefined();
    expect(where.NOT).toBeUndefined();
    expect(where.evidenceReferences).toBeUndefined();
  });
});
