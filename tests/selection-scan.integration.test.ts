import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it, afterAll } from "vitest";

import { RepositoryBundle } from "../src/db/repositories.js";

// ── Skip gate ────────────────────────────────────────────────────────────────
// Probe the real database with SELECT 1.  Skips when DATABASE_URL is absent,
// empty, or points at an unreachable server.
//
// When INTEGRATION=1 is set (e.g. via `npm run test:integration`), the test
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
  describe("selection:scan editorialOwner preservation", () => {
    it("requires a reachable Postgres database", () => {
      expect.fail(
        "INTEGRATION=1 is set but Postgres is not reachable. " +
          "Ensure DATABASE_URL points to a running database."
      );
    });
  });
}

describe.skipIf(!dbReachable)("selection:scan editorialOwner preservation", () => {
  const prisma = new PrismaClient();
  const repos = new RepositoryBundle(prisma);
  const now = new Date("2026-03-30T12:00:00.000Z");

  const createdIds: Array<{ companyId: string; oppId: string; evId: string; siId: string }> = [];

  async function seedOpportunity(editorialOwner: string) {
    const suffix = randomUUID();
    const ids = {
      companyId: `company_${suffix}`,
      oppId: `opp_sel_${suffix}`,
      evId: `ev_sel_${suffix}`,
      siId: `si_sel_${suffix}`
    };
    createdIds.push(ids);

    await prisma.company.create({
      data: {
        id: ids.companyId,
        slug: `test-sel-${suffix.slice(0, 8)}`,
        name: "Selection Test Co",
        defaultTimezone: "Europe/Paris"
      }
    });

    await prisma.sourceItem.create({
      data: {
        id: ids.siId,
        companyId: ids.companyId,
        source: "notion",
        sourceItemId: `sid-${ids.siId}`,
        externalId: `ext-${ids.siId}`,
        fingerprint: `fp-${ids.siId}`,
        sourceUrl: `https://example.com/${ids.siId}`,
        title: "Source item for selection test",
        summary: "summary",
        text: "text",
        occurredAt: now,
        ingestedAt: now,
        metadataJson: {},
        rawPayloadJson: {}
      }
    });

    await prisma.evidenceReference.create({
      data: {
        id: ids.evId,
        sourceItemId: ids.siId,
        source: "notion",
        sourceUrl: `https://example.com/${ids.evId}`,
        timestamp: now,
        excerpt: "Test excerpt",
        excerptHash: `hash-${ids.evId}`,
        freshnessScore: 0.9
      }
    });

    await prisma.opportunity.create({
      data: {
        id: ids.oppId,
        companyId: ids.companyId,
        sourceFingerprint: `opp-fp-${ids.oppId}`,
        title: "Selection owner preservation test",
        angle: "angle",
        whyNow: "why",
        whatItIsAbout: "about",
        whatItIsNotAbout: "not about",
        status: "To review",
        suggestedFormat: "post",
        supportingEvidenceCount: 1,
        evidenceFreshness: 0.9,
        editorialOwner,
        notionPageFingerprint: `opp-fp-${ids.oppId}`,
        primaryEvidenceId: ids.evId,
        v1HistoryJson: []
      }
    });

    return ids;
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  afterAll(async () => {
    try {
      for (const ids of createdIds) {
        await prisma.opportunity.updateMany({
          where: { id: ids.oppId },
          data: { primaryEvidenceId: null }
        });
        await prisma.evidenceReference.deleteMany({
          where: { id: ids.evId }
        });
        await prisma.opportunity.deleteMany({
          where: { id: ids.oppId }
        });
        await prisma.sourceItem.deleteMany({
          where: { id: ids.siId }
        });
        await prisma.company.deleteMany({
          where: { id: ids.companyId }
        });
      }
    } catch {
      // Connection dead or setup never ran — nothing to clean up.
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  // ── Tests ────────────────────────────────────────────────────────────────

  it("preserves existing editorialOwner when called with undefined", async () => {
    const ids = await seedOpportunity("Original Owner");

    const result = await repos.markOpportunitySelected(ids.oppId, undefined);

    expect(result.status).toBe("Selected");
    expect(result.selectedAt).toBeInstanceOf(Date);
    expect(result.editorialOwner).toBe("Original Owner");

    const reloaded = await prisma.opportunity.findUniqueOrThrow({
      where: { id: ids.oppId }
    });
    expect(reloaded.editorialOwner).toBe("Original Owner");
    expect(reloaded.status).toBe("Selected");
  });

  it("overwrites editorialOwner when a non-empty value is provided", async () => {
    const ids = await seedOpportunity("Original Owner");

    const result = await repos.markOpportunitySelected(ids.oppId, "New Owner");

    expect(result.status).toBe("Selected");
    expect(result.editorialOwner).toBe("New Owner");

    const reloaded = await prisma.opportunity.findUniqueOrThrow({
      where: { id: ids.oppId }
    });
    expect(reloaded.editorialOwner).toBe("New Owner");
  });
});
