import { describe, expect, it, vi, beforeEach } from "vitest";

import { SalesApp } from "../src/sales/app.js";
import { runSalesCommand } from "../src/sales/cli.js";
import type { AppEnv } from "../src/config/env.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FACT_PREFIX = "hubspot-fact:";

function buildEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    DATABASE_URL: "postgresql://localhost/test",
    HUBSPOT_ACCESS_TOKEN: "pat-test-123",
    HUBSPOT_PORTAL_ID: "12345",
    SALES_LLM_PROVIDER: "anthropic",
    SALES_LLM_MODEL: "claude-sonnet-4-6",
    ANTHROPIC_API_KEY: "sk-ant-test",
    OPENAI_API_KEY: "",
    ...overrides,
  } as AppEnv;
}

/** Builds a mock Prisma client for runCleanupOrphans tests. */
function buildCleanupPrisma(opts: {
  hubspotItems?: Array<{ id: string; sourceItemId: string }>;
  existingFactIds?: string[];
  evidenceCount?: number;
  signalCount?: number;
  /** When set, the tx re-validation returns these fact IDs as existing (simulates race). */
  txExistingFactIds?: string[];
  /** When set, the tx re-fetch returns these items (simulates items disappearing). */
  txCandidateItems?: Array<{ id: string; sourceItemId: string }>;
  deleteCount?: number;
}) {
  const hubspotItems = opts.hubspotItems ?? [];
  const existingFactIds = opts.existingFactIds ?? [];
  const evidenceCount = opts.evidenceCount ?? 0;
  const signalCount = opts.signalCount ?? 0;
  const deleteCount = opts.deleteCount;

  // Compute expected orphan count for default deleteMany behavior
  const orphanIds = hubspotItems
    .filter((item) => {
      const factId = item.sourceItemId.slice(FACT_PREFIX.length);
      return !factId || !existingFactIds.includes(factId);
    })
    .map((item) => item.id);

  const sourceItemFindMany = vi.fn().mockResolvedValue(hubspotItems);
  const factFindMany = vi.fn().mockResolvedValue(
    existingFactIds.map((id) => ({ id })),
  );
  const evidenceRefCount = vi.fn().mockResolvedValue(evidenceCount);
  const salesSignalCount = vi.fn().mockResolvedValue(signalCount);
  const sourceItemDeleteMany = vi.fn().mockResolvedValue({
    count: deleteCount ?? orphanIds.length,
  });

  // Transaction mock: builds a tx-scoped prisma that may differ from scan-phase
  const txExistingFactIds = opts.txExistingFactIds ?? existingFactIds;
  const txCandidateItems = opts.txCandidateItems; // undefined = same as scan

  const txSourceItemFindMany = vi.fn().mockImplementation(
    (args: { where: { id: { in: string[] } } }) => {
      if (txCandidateItems !== undefined) {
        // Return only items from txCandidateItems whose id is in the query
        const queryIds = new Set(args.where.id.in);
        return Promise.resolve(txCandidateItems.filter((i) => queryIds.has(i.id)));
      }
      // Default: return matching items from original hubspotItems
      const queryIds = new Set(args.where.id.in);
      return Promise.resolve(hubspotItems.filter((i) => queryIds.has(i.id)));
    },
  );
  const txFactFindMany = vi.fn().mockResolvedValue(
    txExistingFactIds.map((id) => ({ id })),
  );
  const txEvidenceRefCount = vi.fn().mockResolvedValue(evidenceCount);
  const txSalesSignalCount = vi.fn().mockResolvedValue(signalCount);
  const txSourceItemDeleteMany = vi.fn().mockImplementation(
    (args: { where: { id: { in: string[] } } }) =>
      Promise.resolve({ count: deleteCount ?? args.where.id.in.length }),
  );

  const txPrisma = {
    sourceItem: { findMany: txSourceItemFindMany, deleteMany: txSourceItemDeleteMany },
    salesExtractedFact: { findMany: txFactFindMany },
    evidenceReference: { count: txEvidenceRefCount },
    salesSignal: { count: txSalesSignalCount },
  };

  const $transaction = vi.fn().mockImplementation((fn: (tx: any) => Promise<any>) => fn(txPrisma));

  const prisma = {
    sourceItem: { findMany: sourceItemFindMany, deleteMany: sourceItemDeleteMany },
    salesExtractedFact: { findMany: factFindMany },
    evidenceReference: { count: evidenceRefCount },
    salesSignal: { count: salesSignalCount },
    $transaction,
  } as any;

  return {
    prisma,
    mocks: {
      sourceItemFindMany,
      factFindMany,
      evidenceRefCount,
      salesSignalCount,
      sourceItemDeleteMany,
      $transaction,
      tx: {
        sourceItemFindMany: txSourceItemFindMany,
        factFindMany: txFactFindMany,
        evidenceRefCount: txEvidenceRefCount,
        salesSignalCount: txSalesSignalCount,
        sourceItemDeleteMany: txSourceItemDeleteMany,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// SalesApp.runCleanupOrphans — Core orphan detection
// ---------------------------------------------------------------------------

describe("SalesApp.runCleanupOrphans", () => {
  it("keeps valid items when backing fact exists", async () => {
    const { prisma } = buildCleanupPrisma({
      hubspotItems: [{ id: "si-1", sourceItemId: "hubspot-fact:fact-1" }],
      existingFactIds: ["fact-1"],
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: false });

    expect(result.scanned).toBe(1);
    expect(result.orphaned).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it("identifies item as orphan when backing fact is missing", async () => {
    const { prisma } = buildCleanupPrisma({
      hubspotItems: [{ id: "si-1", sourceItemId: "hubspot-fact:fact-gone" }],
      existingFactIds: [],
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: false });

    expect(result.scanned).toBe(1);
    expect(result.orphaned).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.dryRun).toBe(true);
  });

  it("returns zeros on empty state without querying facts", async () => {
    const { prisma, mocks } = buildCleanupPrisma({ hubspotItems: [] });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: false });

    expect(result).toEqual({
      scanned: 0, orphaned: 0, deleted: 0, dryRun: true,
      cascadeEvidenceReferences: 0, nulledSignalLinks: 0,
    });
    expect(mocks.factFindMany).not.toHaveBeenCalled();
  });

  it("treats malformed sourceItemId (empty suffix) as orphan", async () => {
    const { prisma } = buildCleanupPrisma({
      hubspotItems: [{ id: "si-bad", sourceItemId: "hubspot-fact:" }],
      existingFactIds: [],
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: false });

    expect(result.orphaned).toBe(1);
  });

  it("correctly separates valid and orphaned in mixed set", async () => {
    const { prisma } = buildCleanupPrisma({
      hubspotItems: [
        { id: "si-1", sourceItemId: "hubspot-fact:fact-ok-1" },
        { id: "si-2", sourceItemId: "hubspot-fact:fact-ok-2" },
        { id: "si-3", sourceItemId: "hubspot-fact:fact-gone" },
      ],
      existingFactIds: ["fact-ok-1", "fact-ok-2"],
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: false });

    expect(result.scanned).toBe(3);
    expect(result.orphaned).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scoping and isolation
// ---------------------------------------------------------------------------

describe("SalesApp.runCleanupOrphans — scoping", () => {
  it("passes companyId in the SourceItem query where clause", async () => {
    const { prisma, mocks } = buildCleanupPrisma({ hubspotItems: [] });
    const app = new SalesApp(prisma, buildEnv());
    await app.runCleanupOrphans("company-xyz", { commit: false });

    expect(mocks.sourceItemFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ companyId: "company-xyz" }),
      }),
    );
  });

  it("only queries source=hubspot with startsWith filter", async () => {
    const { prisma, mocks } = buildCleanupPrisma({ hubspotItems: [] });
    const app = new SalesApp(prisma, buildEnv());
    await app.runCleanupOrphans("c1", { commit: false });

    expect(mocks.sourceItemFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: "hubspot",
          sourceItemId: { startsWith: "hubspot-fact:" },
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Blast-radius reporting
// ---------------------------------------------------------------------------

describe("SalesApp.runCleanupOrphans — blast radius", () => {
  it("reports dependent row counts for orphans", async () => {
    const { prisma } = buildCleanupPrisma({
      hubspotItems: [{ id: "si-1", sourceItemId: "hubspot-fact:gone" }],
      existingFactIds: [],
      evidenceCount: 3,
      signalCount: 2,
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: false });

    expect(result.cascadeEvidenceReferences).toBe(3);
    expect(result.nulledSignalLinks).toBe(2);
  });

  it("reports zero dependents when orphan has none", async () => {
    const { prisma } = buildCleanupPrisma({
      hubspotItems: [{ id: "si-1", sourceItemId: "hubspot-fact:gone" }],
      existingFactIds: [],
      evidenceCount: 0,
      signalCount: 0,
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: false });

    expect(result.cascadeEvidenceReferences).toBe(0);
    expect(result.nulledSignalLinks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dry-run vs commit
// ---------------------------------------------------------------------------

describe("SalesApp.runCleanupOrphans — dry-run vs commit", () => {
  it("dry-run does not call $transaction", async () => {
    const { prisma, mocks } = buildCleanupPrisma({
      hubspotItems: [{ id: "si-1", sourceItemId: "hubspot-fact:gone" }],
      existingFactIds: [],
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: false });

    expect(result.dryRun).toBe(true);
    expect(result.deleted).toBe(0);
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });

  it("commit mode calls $transaction and deletes orphans", async () => {
    const { prisma, mocks } = buildCleanupPrisma({
      hubspotItems: [
        { id: "si-1", sourceItemId: "hubspot-fact:gone-1" },
        { id: "si-2", sourceItemId: "hubspot-fact:gone-2" },
      ],
      existingFactIds: [],
      deleteCount: 2,
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: true });

    expect(result.dryRun).toBe(false);
    expect(result.deleted).toBe(2);
    expect(mocks.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.tx.sourceItemDeleteMany).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Race safety (re-validation in transaction)
// ---------------------------------------------------------------------------

describe("SalesApp.runCleanupOrphans — race safety", () => {
  it("preserves candidate when fact reappears before commit", async () => {
    // Scan phase: fact-1 is missing → si-1 is an orphan candidate
    // Tx phase: fact-1 now exists → si-1 should NOT be deleted
    const { prisma } = buildCleanupPrisma({
      hubspotItems: [{ id: "si-1", sourceItemId: "hubspot-fact:fact-1" }],
      existingFactIds: [],           // scan: fact missing
      txExistingFactIds: ["fact-1"], // tx: fact reappeared
      deleteCount: 0,
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: true });

    expect(result.orphaned).toBe(0);  // tx re-validation: no longer orphaned
    expect(result.deleted).toBe(0);   // nothing to delete
  });

  it("handles SourceItem disappearing before commit without crashing", async () => {
    // Scan phase: si-1 exists and is orphaned
    // Tx phase: si-1 no longer exists (deleted by another process)
    const { prisma } = buildCleanupPrisma({
      hubspotItems: [{ id: "si-1", sourceItemId: "hubspot-fact:gone" }],
      existingFactIds: [],
      txCandidateItems: [],  // tx re-fetch returns nothing
      deleteCount: 0,
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: true });

    expect(result.orphaned).toBe(0);  // tx re-validation: item gone
    expect(result.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("SalesApp.runCleanupOrphans — idempotency", () => {
  it("second commit run deletes zero when orphans are already gone", async () => {
    // Simulate: after first run deleted orphans, second run sees no HubSpot items
    const { prisma } = buildCleanupPrisma({ hubspotItems: [] });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: true });

    expect(result.orphaned).toBe(0);
    expect(result.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Safety threshold
// ---------------------------------------------------------------------------

describe("SalesApp.runCleanupOrphans — safety threshold", () => {
  it("throws when orphan count exceeds threshold without --force", async () => {
    const items = Array.from({ length: 501 }, (_, i) => ({
      id: `si-${i}`,
      sourceItemId: `hubspot-fact:gone-${i}`,
    }));
    const { prisma } = buildCleanupPrisma({
      hubspotItems: items,
      existingFactIds: [],
    });
    const app = new SalesApp(prisma, buildEnv());

    await expect(
      app.runCleanupOrphans("c1", { commit: true }),
    ).rejects.toThrow(/safety threshold/);
  });

  it("proceeds when orphan count exceeds threshold with --force", async () => {
    const items = Array.from({ length: 501 }, (_, i) => ({
      id: `si-${i}`,
      sourceItemId: `hubspot-fact:gone-${i}`,
    }));
    const { prisma } = buildCleanupPrisma({
      hubspotItems: items,
      existingFactIds: [],
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: true, force: true });

    expect(result.deleted).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

describe("SalesApp.runCleanupOrphans — batching", () => {
  it("processes large orphan sets in batches of 200", async () => {
    const items = Array.from({ length: 450 }, (_, i) => ({
      id: `si-${i}`,
      sourceItemId: `hubspot-fact:gone-${i}`,
    }));
    const { prisma, mocks } = buildCleanupPrisma({
      hubspotItems: items,
      existingFactIds: [],
      deleteCount: 150, // per-batch count
    });
    const app = new SalesApp(prisma, buildEnv());
    await app.runCleanupOrphans("c1", { commit: true, force: true });

    // Pass 1 (re-validate): 3 batches of findMany
    expect(mocks.tx.sourceItemFindMany).toHaveBeenCalledTimes(3);
    // Pass 3 (delete): 3 batches of deleteMany
    expect(mocks.tx.sourceItemDeleteMany).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Blast-radius accuracy (commit vs dry-run)
// ---------------------------------------------------------------------------

describe("SalesApp.runCleanupOrphans — blast-radius accuracy", () => {
  it("commit-mode orphaned count and blast-radius reflect re-validated set", async () => {
    // Scan: 3 orphan candidates (fact-1, fact-2, fact-3 all missing)
    // Tx: fact-1 reappears → only si-2, si-3 are confirmed orphans
    const { prisma, mocks } = buildCleanupPrisma({
      hubspotItems: [
        { id: "si-1", sourceItemId: "hubspot-fact:fact-1" },
        { id: "si-2", sourceItemId: "hubspot-fact:fact-2" },
        { id: "si-3", sourceItemId: "hubspot-fact:fact-3" },
      ],
      existingFactIds: [],
      txExistingFactIds: ["fact-1"],  // fact-1 reappears in tx
      evidenceCount: 4,
      signalCount: 1,
      deleteCount: 2,
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: true });

    // orphaned reflects post-revalidation count, not scan estimate
    expect(result.orphaned).toBe(2);
    expect(result.deleted).toBe(2);

    // Tx evidence count was called with only the 2 still-orphaned IDs
    const txEvidenceArgs = mocks.tx.evidenceRefCount.mock.calls[0][0];
    expect(txEvidenceArgs.where.sourceItemId.in).toEqual(
      expect.arrayContaining(["si-2", "si-3"]),
    );
    expect(txEvidenceArgs.where.sourceItemId.in).not.toContain("si-1");

    // Reported blast-radius counts come from tx, not scan
    expect(result.cascadeEvidenceReferences).toBe(4);
    expect(result.nulledSignalLinks).toBe(1);
  });

  it("dry-run orphaned count is scan-phase estimate and blast-radius uses main prisma", async () => {
    const { prisma, mocks } = buildCleanupPrisma({
      hubspotItems: [
        { id: "si-1", sourceItemId: "hubspot-fact:gone-1" },
        { id: "si-2", sourceItemId: "hubspot-fact:gone-2" },
      ],
      existingFactIds: [],
      evidenceCount: 7,
      signalCount: 3,
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runCleanupOrphans("c1", { commit: false });

    // Dry-run orphaned is the scan-phase count (best estimate)
    expect(result.orphaned).toBe(2);
    expect(result.cascadeEvidenceReferences).toBe(7);
    expect(result.nulledSignalLinks).toBe(3);
    expect(result.dryRun).toBe(true);
    // No transaction involved
    expect(mocks.$transaction).not.toHaveBeenCalled();
    // Scan-phase counts queried on main prisma, not tx
    expect(mocks.evidenceRefCount).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

describe("sales:cleanup-orphans CLI", () => {
  function buildCliMocks(overrides?: { argv?: string[] }) {
    const cleanupResult = {
      scanned: 10, orphaned: 2, deleted: 0, dryRun: true,
      cascadeEvidenceReferences: 1, nulledSignalLinks: 0,
    };
    const mockApp = {
      runCleanupOrphans: vi.fn().mockResolvedValue(cleanupResult),
    } as any;
    const mockPrisma = {
      company: {
        findUnique: vi.fn().mockResolvedValue({ id: "c1", name: "Test Co", slug: "default" }),
      },
    } as any;
    const logged: Array<{ obj: unknown; msg?: string }> = [];
    const mockLogger = {
      info: vi.fn().mockImplementation((obj: unknown, msg?: string) => {
        logged.push({ obj, msg });
      }),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any;
    const exitFn = vi.fn();

    // Temporarily replace process.argv
    const originalArgv = process.argv;
    process.argv = overrides?.argv ?? ["node", "cli.ts", "sales:cleanup-orphans"];

    return {
      mockApp,
      mockPrisma,
      mockLogger,
      logged,
      exitFn,
      cleanupResult,
      restore: () => { process.argv = originalArgv; },
    };
  }

  it("calls runCleanupOrphans with commit=false by default", async () => {
    const ctx = buildCliMocks();
    try {
      await runSalesCommand({
        command: "sales:cleanup-orphans",
        app: ctx.mockApp,
        prisma: ctx.mockPrisma,
        env: {} as any,
        logger: ctx.mockLogger,
        exit: ctx.exitFn,
      });

      expect(ctx.mockApp.runCleanupOrphans).toHaveBeenCalledWith("c1", { commit: false, force: false });
    } finally {
      ctx.restore();
    }
  });

  it("calls runCleanupOrphans with commit=true when --commit is passed", async () => {
    const ctx = buildCliMocks({
      argv: ["node", "cli.ts", "sales:cleanup-orphans", "--commit"],
    });
    ctx.cleanupResult.dryRun = false;
    ctx.cleanupResult.deleted = 2;
    ctx.mockApp.runCleanupOrphans.mockResolvedValue({ ...ctx.cleanupResult });
    try {
      await runSalesCommand({
        command: "sales:cleanup-orphans",
        app: ctx.mockApp,
        prisma: ctx.mockPrisma,
        env: {} as any,
        logger: ctx.mockLogger,
        exit: ctx.exitFn,
      });

      expect(ctx.mockApp.runCleanupOrphans).toHaveBeenCalledWith("c1", { commit: true, force: false });
    } finally {
      ctx.restore();
    }
  });

  it("calls runCleanupOrphans with force=true when --commit --force", async () => {
    const ctx = buildCliMocks({
      argv: ["node", "cli.ts", "sales:cleanup-orphans", "--commit", "--force"],
    });
    ctx.cleanupResult.dryRun = false;
    ctx.mockApp.runCleanupOrphans.mockResolvedValue({ ...ctx.cleanupResult });
    try {
      await runSalesCommand({
        command: "sales:cleanup-orphans",
        app: ctx.mockApp,
        prisma: ctx.mockPrisma,
        env: {} as any,
        logger: ctx.mockLogger,
        exit: ctx.exitFn,
      });

      expect(ctx.mockApp.runCleanupOrphans).toHaveBeenCalledWith("c1", { commit: true, force: true });
    } finally {
      ctx.restore();
    }
  });

  it("rejects --force without --commit", async () => {
    const ctx = buildCliMocks({
      argv: ["node", "cli.ts", "sales:cleanup-orphans", "--force"],
    });
    try {
      await runSalesCommand({
        command: "sales:cleanup-orphans",
        app: ctx.mockApp,
        prisma: ctx.mockPrisma,
        env: {} as any,
        logger: ctx.mockLogger,
        exit: ctx.exitFn,
      });

      expect(ctx.mockLogger.error).toHaveBeenCalledWith("--force requires --commit");
      expect(ctx.exitFn).toHaveBeenCalledWith(1);
      expect(ctx.mockApp.runCleanupOrphans).not.toHaveBeenCalled();
    } finally {
      ctx.restore();
    }
  });

  it("dry-run labels blast-radius as estimates in log output", async () => {
    const ctx = buildCliMocks();
    try {
      await runSalesCommand({
        command: "sales:cleanup-orphans",
        app: ctx.mockApp,
        prisma: ctx.mockPrisma,
        env: {} as any,
        logger: ctx.mockLogger,
        exit: ctx.exitFn,
      });

      const resultLog = ctx.logged.find(
        (l) => typeof l.msg === "string" && l.msg.includes("Dry-run completed"),
      );
      expect(resultLog).toBeDefined();
      // Message indicates counts are estimates
      expect(resultLog!.msg).toContain("counts are estimates");
      const obj = resultLog!.obj as Record<string, unknown>;
      // Field names prefixed with "estimated"
      expect(obj).toHaveProperty("estimatedCascadeEvidenceReferences", 1);
      expect(obj).toHaveProperty("estimatedNulledSignalLinks", 0);
      // Non-estimated names must NOT appear
      expect(obj).not.toHaveProperty("cascadeEvidenceReferences");
      expect(obj).not.toHaveProperty("nulledSignalLinks");
      // deleted is omitted in dry-run
      expect(obj).not.toHaveProperty("deleted");
    } finally {
      ctx.restore();
    }
  });

  it("commit-mode logs exact blast-radius (not estimated)", async () => {
    const ctx = buildCliMocks({
      argv: ["node", "cli.ts", "sales:cleanup-orphans", "--commit"],
    });
    const commitResult = {
      scanned: 10, orphaned: 2, deleted: 2, dryRun: false,
      cascadeEvidenceReferences: 3, nulledSignalLinks: 1,
    };
    ctx.mockApp.runCleanupOrphans.mockResolvedValue(commitResult);
    try {
      await runSalesCommand({
        command: "sales:cleanup-orphans",
        app: ctx.mockApp,
        prisma: ctx.mockPrisma,
        env: {} as any,
        logger: ctx.mockLogger,
        exit: ctx.exitFn,
      });

      const resultLog = ctx.logged.find(
        (l) => typeof l.msg === "string" && l.msg.includes("Cleanup completed"),
      );
      expect(resultLog).toBeDefined();
      const obj = resultLog!.obj as Record<string, unknown>;
      // Exact field names (not estimated)
      expect(obj).toHaveProperty("cascadeEvidenceReferences", 3);
      expect(obj).toHaveProperty("nulledSignalLinks", 1);
      expect(obj).toHaveProperty("deleted", 2);
      expect(obj).toHaveProperty("orphaned", 2);
      // Estimated names must NOT appear
      expect(obj).not.toHaveProperty("estimatedCascadeEvidenceReferences");
      expect(obj).not.toHaveProperty("estimatedNulledSignalLinks");
    } finally {
      ctx.restore();
    }
  });
});
