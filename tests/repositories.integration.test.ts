import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it, afterAll } from "vitest";

// ── Skip gate ────────────────────────────────────────────────────────────────
// Probe the real database with SELECT 1.  Skips when DATABASE_URL is absent,
// empty, or points at an unreachable server.
//
// When INTEGRATION=1 is set (e.g. via `pnpm run test:integration`), the test
// MUST run — a hard-failing sentinel replaces the silent skip so an operator
// is never left wondering whether the Postgres path was actually exercised.

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
  describe("repository DB integrity", () => {
    it("requires a reachable Postgres database", () => {
      expect.fail(
        "INTEGRATION=1 is set but Postgres is not reachable. " +
          "Ensure DATABASE_URL points to a running database."
      );
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-03-10T12:00:00.000Z");

function makeCompany(id: string, suffix: string) {
  return { id, slug: `test-${suffix}`, name: "Repo Integration Co", defaultTimezone: "UTC" };
}

function makeSourceItem(id: string, companyId: string, fingerprint: string) {
  return {
    id,
    companyId,
    source: "notion",
    sourceItemId: `sid-${id}`,
    externalId: `ext-${id}`,
    fingerprint,
    sourceUrl: `https://example.com/${id}`,
    title: `Title ${id.slice(0, 20)}`,
    summary: "summary",
    text: "text",
    occurredAt: NOW,
    ingestedAt: NOW,
    metadataJson: {},
    rawPayloadJson: {},
    rawText: null,
    rawTextStored: false,
    cleanupEligible: false
  };
}

function makeEvidence(id: string, sourceItemId: string) {
  return {
    id,
    sourceItemId,
    source: "notion",
    sourceUrl: `https://example.com/${id}`,
    timestamp: NOW,
    excerpt: `Excerpt ${id.slice(0, 20)}`,
    excerptHash: `hash-${id}`,
    freshnessScore: 0.9
  };
}

describe.skipIf(!dbReachable)("repository DB integrity", () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it("rejects duplicate fingerprints within the same company", async () => {
    const suffix = randomUUID();
    const companyId = `company_fp_${suffix}`;
    const siA = `si_fp_a_${suffix}`;
    const siB = `si_fp_b_${suffix}`;
    const sharedFingerprint = `fp-dup-${suffix}`;

    try {
      await prisma.company.create({ data: makeCompany(companyId, suffix) });
      await prisma.sourceItem.create({ data: makeSourceItem(siA, companyId, sharedFingerprint) });

      await expect(
        prisma.sourceItem.create({ data: makeSourceItem(siB, companyId, sharedFingerprint) })
      ).rejects.toThrow();
    } finally {
      try {
        await prisma.sourceItem.deleteMany({ where: { id: { in: [siA, siB] } } });
        await prisma.company.deleteMany({ where: { id: companyId } });
      } catch {
        // Best-effort cleanup.
      }
    }
  });

  it("cascades evidence deletion when a source item is removed", async () => {
    const suffix = randomUUID();
    const companyId = `company_casc_${suffix}`;
    const siId = `si_casc_${suffix}`;
    const evId = `ev_casc_${suffix}`;

    try {
      await prisma.company.create({ data: makeCompany(companyId, suffix) });
      await prisma.sourceItem.create({ data: makeSourceItem(siId, companyId, `fp-casc-${suffix}`) });
      await prisma.evidenceReference.create({ data: makeEvidence(evId, siId) });

      const before = await prisma.evidenceReference.findUnique({ where: { id: evId } });
      expect(before).not.toBeNull();

      await prisma.sourceItem.delete({ where: { id: siId } });

      const after = await prisma.evidenceReference.findUnique({ where: { id: evId } });
      expect(after).toBeNull();
    } finally {
      try {
        await prisma.evidenceReference.deleteMany({ where: { id: evId } });
        await prisma.sourceItem.deleteMany({ where: { id: siId } });
        await prisma.company.deleteMany({ where: { id: companyId } });
      } catch {
        // Best-effort cleanup.
      }
    }
  });
});
