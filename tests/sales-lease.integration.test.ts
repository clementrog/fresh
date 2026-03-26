import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it, afterAll } from "vitest";

import { SalesRepositoryBundle, ConcurrentRunError } from "../src/sales/db/sales-repositories.js";
import { createDeterministicId } from "../src/lib/ids.js";

// ── Skip gate ────────────────────────────────────────────────────────────────
let dbReachable = false;
if (process.env.DATABASE_URL) {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    // DB unreachable
  } finally {
    await probe.$disconnect().catch(() => {});
  }
}

const integrationRequired = process.env.INTEGRATION === "1";

if (!dbReachable && integrationRequired) {
  describe("sales lease integration", () => {
    it("requires a reachable Postgres database", () => {
      expect.fail(
        "INTEGRATION=1 is set but Postgres is not reachable. " +
          "Ensure DATABASE_URL points to a running database."
      );
    });
  });
}

describe.skipIf(!dbReachable)("sales lease integration", () => {
  const prisma = new PrismaClient();
  const repos = new SalesRepositoryBundle(prisma);
  const suffix = randomUUID();

  const companyId = `company_lease_${suffix}`;
  const companySlug = `test-lease-${suffix}`;

  // Track created run IDs for cleanup
  const createdRunIds: string[] = [];

  afterAll(async () => {
    try {
      // Clean up SyncRuns
      for (const runId of createdRunIds) {
        await prisma.syncRun.deleteMany({ where: { id: runId } }).catch(() => {});
      }
      // Clean up company
      await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
    } catch {
      // best effort
    }
    await prisma.$disconnect();
  });

  // Seed company before tests
  it("seeds test company", async () => {
    await prisma.company.create({
      data: {
        id: companyId,
        slug: companySlug,
        name: `Lease Test ${suffix}`,
        defaultTimezone: "Europe/Paris",
      },
    });
  });

  it("acquires a lease when no running run exists", async () => {
    const runId = createDeterministicId("run", [companyId, "test-acquire", Date.now().toString()]);
    createdRunIds.push(runId);

    const run = await repos.acquireRunLease({
      companyId,
      runType: "sales:extract",
      runId,
    });

    expect(run.id).toBe(runId);
    expect(run.status).toBe("running");
    expect(run.leaseExpiresAt).toBeTruthy();
    expect(new Date(run.leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now());

    // Clean up: finalize so it doesn't block other tests
    await repos.finalizeSyncRun(runId, "completed", {});
  });

  it("blocks a second lease while the first is live", async () => {
    const runId1 = createDeterministicId("run", [companyId, "test-block-1", Date.now().toString()]);
    const runId2 = createDeterministicId("run", [companyId, "test-block-2", Date.now().toString()]);
    createdRunIds.push(runId1, runId2);

    // Acquire first lease
    await repos.acquireRunLease({
      companyId,
      runType: "sales:extract",
      runId: runId1,
    });

    // Attempt second lease — should throw
    await expect(
      repos.acquireRunLease({
        companyId,
        runType: "sales:extract",
        runId: runId2,
      })
    ).rejects.toThrow(ConcurrentRunError);

    // Clean up
    await repos.finalizeSyncRun(runId1, "completed", {});
  });

  it("takes over an expired lease", async () => {
    const runId1 = createDeterministicId("run", [companyId, "test-expire-1", Date.now().toString()]);
    const runId2 = createDeterministicId("run", [companyId, "test-expire-2", (Date.now() + 1).toString()]);
    createdRunIds.push(runId1, runId2);

    // Create a run with an already-expired lease
    await prisma.syncRun.create({
      data: {
        id: runId1,
        companyId,
        runType: "sales:extract",
        status: "running",
        startedAt: new Date(Date.now() - 600_000), // 10 minutes ago
        leaseExpiresAt: new Date(Date.now() - 300_000), // expired 5 minutes ago
        countersJson: {},
        warningsJson: [],
        notionPageFingerprint: "",
      },
    });

    // Acquire new lease — should succeed and expire the old run
    const run = await repos.acquireRunLease({
      companyId,
      runType: "sales:extract",
      runId: runId2,
    });

    expect(run.id).toBe(runId2);
    expect(run.status).toBe("running");

    // Verify old run was marked failed
    const oldRun = await prisma.syncRun.findUnique({ where: { id: runId1 } });
    expect(oldRun?.status).toBe("failed");
    expect(oldRun?.notes).toContain("Lease expired");

    // Clean up
    await repos.finalizeSyncRun(runId2, "completed", {});
  });

  it("renewLease returns true when run is still running", async () => {
    const runId = createDeterministicId("run", [companyId, "test-renew", Date.now().toString()]);
    createdRunIds.push(runId);

    await repos.acquireRunLease({
      companyId,
      runType: "sales:extract",
      runId,
    });

    const result = await repos.renewLease(runId);
    expect(result).toBe(true);

    // Verify leaseExpiresAt was advanced
    const run = await prisma.syncRun.findUnique({ where: { id: runId } });
    expect(run?.leaseExpiresAt).toBeTruthy();
    expect(new Date(run!.leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now());

    await repos.finalizeSyncRun(runId, "completed", {});
  });

  it("renewLease returns false when run was taken over", async () => {
    const runId = createDeterministicId("run", [companyId, "test-renew-fail", Date.now().toString()]);
    createdRunIds.push(runId);

    await repos.acquireRunLease({
      companyId,
      runType: "sales:extract",
      runId,
    });

    // Simulate takeover: set status to "failed"
    await prisma.syncRun.update({
      where: { id: runId },
      data: { status: "failed" },
    });

    const result = await repos.renewLease(runId);
    expect(result).toBe(false);
  });

  it("allows concurrent leases for different runTypes", async () => {
    const extractRunId = createDeterministicId("run", [companyId, "test-cross-extract", Date.now().toString()]);
    const detectRunId = createDeterministicId("run", [companyId, "test-cross-detect", Date.now().toString()]);
    createdRunIds.push(extractRunId, detectRunId);

    // Acquire extract lease
    const r1 = await repos.acquireRunLease({
      companyId,
      runType: "sales:extract",
      runId: extractRunId,
    });
    expect(r1.id).toBe(extractRunId);

    // Acquire detect lease — should succeed (different runType)
    const r2 = await repos.acquireRunLease({
      companyId,
      runType: "sales:detect",
      runId: detectRunId,
    });
    expect(r2.id).toBe(detectRunId);

    // Clean up
    await repos.finalizeSyncRun(extractRunId, "completed", {});
    await repos.finalizeSyncRun(detectRunId, "completed", {});
  });

  it("atomic lease acquisition serializes concurrent starters", async () => {
    const runIdA = createDeterministicId("run", [companyId, "test-race-a", Date.now().toString()]);
    const runIdB = createDeterministicId("run", [companyId, "test-race-b", (Date.now() + 1).toString()]);
    createdRunIds.push(runIdA, runIdB);

    // Launch two acquisitions concurrently
    const results = await Promise.allSettled([
      repos.acquireRunLease({ companyId, runType: "sales:extract", runId: runIdA }),
      repos.acquireRunLease({ companyId, runType: "sales:extract", runId: runIdB }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one should succeed, one should fail
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const winner = fulfilled[0] as PromiseFulfilledResult<{ id: string }>;
    const loser = rejected[0] as PromiseRejectedResult;

    expect(loser.reason).toBeInstanceOf(ConcurrentRunError);

    // Clean up winner
    await repos.finalizeSyncRun(winner.value.id, "completed", {});
  });
});
