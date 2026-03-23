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
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null)
    },
    editorialConfig: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null)
    }
  } as any;
}

// ── listEditorialConfigs ────────────────────────────────────────────────────

describe("listEditorialConfigs", () => {
  it("passes companyId to WHERE clause", async () => {
    const prisma = mockPrisma();
    const expected = [
      { id: "ec_1", version: 1, createdAt: new Date("2026-01-01") }
    ];
    prisma.editorialConfig.findMany.mockResolvedValue(expected);
    const queries = new AdminQueries(prisma);

    const result = await queries.listEditorialConfigs("comp_42");

    expect(prisma.editorialConfig.findMany).toHaveBeenCalledWith({
      where: { companyId: "comp_42" },
      orderBy: { version: "desc" },
      select: { id: true, version: true, createdAt: true }
    });
    expect(result).toEqual(expected);
  });
});

// ── getEditorialConfig ──────────────────────────────────────────────────────

describe("getEditorialConfig", () => {
  it("returns result from findUnique", async () => {
    const prisma = mockPrisma();
    const fullConfig = {
      id: "ec_1",
      companyId: "comp_1",
      version: 1,
      layer1CompanyLens: { doctrineMarkdown: "Test doctrine" },
      layer2ContentPhilosophy: { defaults: ["Be specific"] },
      layer3LinkedInCraft: { defaults: ["Max 250 words"] },
      createdAt: new Date("2026-01-01")
    };
    prisma.editorialConfig.findUnique.mockResolvedValue(fullConfig);
    const queries = new AdminQueries(prisma);

    const result = await queries.getEditorialConfig("ec_1");

    expect(prisma.editorialConfig.findUnique).toHaveBeenCalledWith({
      where: { id: "ec_1" }
    });
    expect(result).toEqual(fullConfig);
  });

  it("returns without error when layer1CompanyLens has no doctrineMarkdown key", async () => {
    const prisma = mockPrisma();
    const config = {
      id: "ec_2",
      companyId: "comp_1",
      version: 2,
      layer1CompanyLens: {},
      layer2ContentPhilosophy: null,
      layer3LinkedInCraft: null,
      createdAt: new Date("2026-01-01")
    };
    prisma.editorialConfig.findUnique.mockResolvedValue(config);
    const queries = new AdminQueries(prisma);

    const result = await queries.getEditorialConfig("ec_2");

    expect(result).toEqual(config);
    expect(result!.layer1CompanyLens).toEqual({});
  });
});

// ── getUser ─────────────────────────────────────────────────────────────────

describe("getUser", () => {
  it("returns result with _count.ownedOpportunities", async () => {
    const prisma = mockPrisma();
    const user = {
      id: "u_1",
      companyId: "comp_1",
      displayName: "Baptiste",
      type: "human",
      language: "fr",
      baseProfile: { toneSummary: "Warm and direct" },
      createdAt: new Date("2025-06-01"),
      updatedAt: new Date("2025-06-15"),
      _count: { ownedOpportunities: 5 }
    };
    prisma.user.findUnique.mockResolvedValue(user);
    const queries = new AdminQueries(prisma);

    const result = await queries.getUser("u_1");

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u_1" },
      include: { _count: { select: { ownedOpportunities: true } } }
    });
    expect(result).toEqual(user);
    expect(result!._count.ownedOpportunities).toBe(5);
  });

  it("returns without error when baseProfile is empty object", async () => {
    const prisma = mockPrisma();
    const user = {
      id: "u_2",
      companyId: "comp_1",
      displayName: "Empty Profile User",
      type: "editor",
      language: "en",
      baseProfile: {},
      createdAt: new Date("2025-06-01"),
      updatedAt: new Date("2025-06-15"),
      _count: { ownedOpportunities: 0 }
    };
    prisma.user.findUnique.mockResolvedValue(user);
    const queries = new AdminQueries(prisma);

    const result = await queries.getUser("u_2");

    expect(result).toEqual(user);
    expect(result!.baseProfile).toEqual({});
  });

  it("returns without error when baseProfile has toneSummary but typicalPhrases is null", async () => {
    const prisma = mockPrisma();
    const user = {
      id: "u_3",
      companyId: "comp_1",
      displayName: "Partial Profile User",
      type: "editor",
      language: "en",
      baseProfile: { toneSummary: "x", typicalPhrases: null },
      createdAt: new Date("2025-06-01"),
      updatedAt: new Date("2025-06-15"),
      _count: { ownedOpportunities: 2 }
    };
    prisma.user.findUnique.mockResolvedValue(user);
    const queries = new AdminQueries(prisma);

    const result = await queries.getUser("u_3");

    expect(result).toEqual(user);
    const profile = result!.baseProfile as Record<string, unknown>;
    expect(profile.toneSummary).toBe("x");
    expect(profile.typicalPhrases).toBeNull();
  });

  it("returns correctly when _count.ownedOpportunities is 0", async () => {
    const prisma = mockPrisma();
    const user = {
      id: "u_4",
      companyId: "comp_1",
      displayName: "New User",
      type: "human",
      language: "en",
      baseProfile: { toneSummary: "Calm" },
      createdAt: new Date("2025-06-01"),
      updatedAt: new Date("2025-06-15"),
      _count: { ownedOpportunities: 0 }
    };
    prisma.user.findUnique.mockResolvedValue(user);
    const queries = new AdminQueries(prisma);

    const result = await queries.getUser("u_4");

    expect(result!._count.ownedOpportunities).toBe(0);
  });
});

// ── listSourceConfigs ─────────────────────────────────────────────────────

describe("listSourceConfigs", () => {
  it("passes companyId to WHERE clause and includes disabled configs", async () => {
    const prisma = mockPrisma();
    prisma.sourceConfig = {
      findMany: vi.fn(async () => [
        { id: "sc_1", source: "claap", enabled: true, configJson: {}, createdAt: new Date(), updatedAt: new Date() },
        { id: "sc_2", source: "linear", enabled: false, configJson: {}, createdAt: new Date(), updatedAt: new Date() }
      ])
    };
    const queries = new AdminQueries(prisma);

    const result = await queries.listSourceConfigs("comp_42");

    expect(prisma.sourceConfig.findMany).toHaveBeenCalledWith({
      where: { companyId: "comp_42" },
      orderBy: { source: "asc" }
    });
    expect(result).toHaveLength(2);
    expect(result[0].enabled).toBe(true);
    expect(result[1].enabled).toBe(false);
  });
});

// ── listMarketQueries ─────────────────────────────────────────────────────

describe("listMarketQueries", () => {
  it("with enabled: 'yes' builds WHERE { enabled: true }", async () => {
    const prisma = mockPrisma();
    prisma.marketQuery = {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0)
    };
    const queries = new AdminQueries(prisma);

    await queries.listMarketQueries("comp_42", { enabled: "yes" });

    expect(prisma.marketQuery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: "comp_42", enabled: true }
      })
    );
  });

  it("with enabled: 'no' builds WHERE { enabled: false }", async () => {
    const prisma = mockPrisma();
    prisma.marketQuery = {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0)
    };
    const queries = new AdminQueries(prisma);

    await queries.listMarketQueries("comp_42", { enabled: "no" });

    expect(prisma.marketQuery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: "comp_42", enabled: false }
      })
    );
  });

  it("with no enabled filter omits the constraint", async () => {
    const prisma = mockPrisma();
    prisma.marketQuery = {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0)
    };
    const queries = new AdminQueries(prisma);

    await queries.listMarketQueries("comp_42", {});

    expect(prisma.marketQuery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: "comp_42" }
      })
    );
  });
});

// ── countMarketQueries ────────────────────────────────────────────────────

describe("countMarketQueries", () => {
  it("uses the same filter logic as list", async () => {
    const prisma = mockPrisma();
    prisma.marketQuery = {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 5)
    };
    const queries = new AdminQueries(prisma);

    const result = await queries.countMarketQueries("comp_42", { enabled: "yes" });

    expect(prisma.marketQuery.count).toHaveBeenCalledWith({
      where: { companyId: "comp_42", enabled: true }
    });
    expect(result).toBe(5);
  });

  it("with no filter omits enabled constraint", async () => {
    const prisma = mockPrisma();
    prisma.marketQuery = {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 3)
    };
    const queries = new AdminQueries(prisma);

    const result = await queries.countMarketQueries("comp_42");

    expect(prisma.marketQuery.count).toHaveBeenCalledWith({
      where: { companyId: "comp_42" }
    });
    expect(result).toBe(3);
  });
});

// ── listDraftProfileIds ─────────────────────────────────────────────────────

describe("listDraftProfileIds", () => {
  it("returns distinct profile IDs for companyId", async () => {
    const prisma = mockPrisma();
    prisma.draft.findMany = vi.fn(async () => [
      { profileId: "baptiste" },
      { profileId: "linc-corporate" }
    ]);
    const queries = new AdminQueries(prisma);

    const result = await queries.listDraftProfileIds("comp_42");

    expect(prisma.draft.findMany).toHaveBeenCalledWith({
      where: { companyId: "comp_42" },
      select: { profileId: true },
      distinct: ["profileId"],
      orderBy: { profileId: "asc" }
    });
    expect(result).toEqual(["baptiste", "linc-corporate"]);
  });
});

// ── listDrafts ──────────────────────────────────────────────────────────────

describe("listDrafts", () => {
  it("passes companyId to WHERE clause", async () => {
    const prisma = mockPrisma();
    prisma.draft.findMany = vi.fn(async () => []);
    const queries = new AdminQueries(prisma);

    await queries.listDrafts("comp_42");

    expect(prisma.draft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: "comp_42" }
      })
    );
  });

  it("respects profileId filter", async () => {
    const prisma = mockPrisma();
    prisma.draft.findMany = vi.fn(async () => []);
    const queries = new AdminQueries(prisma);

    await queries.listDrafts("comp_42", { profileId: "baptiste" });

    expect(prisma.draft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: "comp_42", profileId: "baptiste" }
      })
    );
  });

  it("respects q filter on proposedTitle", async () => {
    const prisma = mockPrisma();
    prisma.draft.findMany = vi.fn(async () => []);
    const queries = new AdminQueries(prisma);

    await queries.listDrafts("comp_42", { q: "leadership" });

    expect(prisma.draft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          companyId: "comp_42",
          proposedTitle: { contains: "leadership", mode: "insensitive" }
        }
      })
    );
  });
});

// ── countDrafts ─────────────────────────────────────────────────────────────

describe("countDrafts", () => {
  it("uses same filter logic as listDrafts", async () => {
    const prisma = mockPrisma();
    prisma.draft.count = vi.fn(async () => 7);
    const queries = new AdminQueries(prisma);

    const result = await queries.countDrafts("comp_42", { profileId: "baptiste" });

    expect(prisma.draft.count).toHaveBeenCalledWith({
      where: { companyId: "comp_42", profileId: "baptiste" }
    });
    expect(result).toBe(7);
  });

  it("with no filter omits profileId and q constraints", async () => {
    const prisma = mockPrisma();
    prisma.draft.count = vi.fn(async () => 12);
    const queries = new AdminQueries(prisma);

    const result = await queries.countDrafts("comp_42");

    expect(prisma.draft.count).toHaveBeenCalledWith({
      where: { companyId: "comp_42" }
    });
    expect(result).toBe(12);
  });
});

// ── getDraft ────────────────────────────────────────────────────────────────

describe("getDraft", () => {
  it("returns result with opportunity and evidence includes", async () => {
    const prisma = mockPrisma();
    const draft = {
      id: "d_1",
      companyId: "comp_1",
      proposedTitle: "Test Draft",
      opportunity: { id: "opp_1", title: "Test Opportunity", status: "To review" },
      evidence: []
    };
    prisma.draft.findUnique = vi.fn(async () => draft);
    const queries = new AdminQueries(prisma);

    const result = await queries.getDraft("d_1");

    expect(prisma.draft.findUnique).toHaveBeenCalledWith({
      where: { id: "d_1" },
      include: {
        opportunity: { select: { id: true, title: true, status: true } },
        evidence: {
          select: {
            id: true,
            source: true,
            excerpt: true,
            timestamp: true,
            speakerOrAuthor: true,
            sourceUrl: true
          }
        }
      }
    });
    expect(result).toEqual(draft);
    expect(result!.opportunity.title).toBe("Test Opportunity");
  });

  it("returns null for unknown id", async () => {
    const prisma = mockPrisma();
    prisma.draft.findUnique = vi.fn(async () => null);
    const queries = new AdminQueries(prisma);

    const result = await queries.getDraft("nonexistent");

    expect(result).toBeNull();
  });
});

// ── getRun ──────────────────────────────────────────────────────────────────

describe("getRun", () => {
  it("returns result with costEntries include", async () => {
    const prisma = mockPrisma();
    const run = {
      id: "run_1",
      companyId: "comp_1",
      runType: "ingest:run",
      costEntries: [
        { id: "ce_1", step: "screening", model: "gpt-4", estimatedCostUsd: 0.0045 }
      ]
    };
    prisma.syncRun.findUnique = vi.fn(async () => run);
    const queries = new AdminQueries(prisma);

    const result = await queries.getRun("run_1");

    expect(prisma.syncRun.findUnique).toHaveBeenCalledWith({
      where: { id: "run_1" },
      include: {
        costEntries: { orderBy: { createdAt: "asc" } }
      }
    });
    expect(result).toEqual(run);
    expect(result!.costEntries).toHaveLength(1);
  });

  it("returns null for unknown id", async () => {
    const prisma = mockPrisma();
    prisma.syncRun.findUnique = vi.fn(async () => null);
    const queries = new AdminQueries(prisma);

    const result = await queries.getRun("nonexistent");

    expect(result).toBeNull();
  });

  it("handles empty costEntries", async () => {
    const prisma = mockPrisma();
    const run = {
      id: "run_2",
      companyId: "comp_1",
      runType: "ingest:run",
      costEntries: []
    };
    prisma.syncRun.findUnique = vi.fn(async () => run);
    const queries = new AdminQueries(prisma);

    const result = await queries.getRun("run_2");

    expect(result!.costEntries).toEqual([]);
  });
});
