import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it, afterAll } from "vitest";

import { AdminQueries } from "../src/admin/queries.js";

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
  describe("disposition filter integration", () => {
    it("requires a reachable Postgres database", () => {
      expect.fail(
        "INTEGRATION=1 is set but Postgres is not reachable. " +
          "Ensure DATABASE_URL points to a running database."
      );
    });
  });
}

describe.skipIf(!dbReachable)("disposition filter integration", () => {
  const prisma = new PrismaClient();
  const queries = new AdminQueries(prisma);
  const suffix = randomUUID();
  const now = new Date("2026-03-20T12:00:00.000Z");

  // ── Parent record — the test creates its own company ───────────────────

  const companyId = `company_${suffix}`;

  // ── Fixture IDs ────────────────────────────────────────────────────────

  const si = {
    orphaned: `si_orphaned_${suffix}`,
    primaryLinked: `si_primary_${suffix}`,
    joinLinked: `si_join_${suffix}`,
    directLinked: `si_direct_${suffix}`,
    blocked: `si_blocked_${suffix}`,
    screenedOut: `si_screened_${suffix}`,
    noDecision: `si_nodecision_${suffix}`,
    synced: `si_synced_${suffix}`,
    unprocessed: `si_unprocessed_${suffix}`
  };

  const opp = {
    a: `opp_a_${suffix}`,
    b: `opp_b_${suffix}`
  };

  const ev = {
    orphaned: `ev_orphaned_${suffix}`,
    primary: `ev_primary_${suffix}`,
    join: `ev_join_${suffix}`,
    direct: `ev_direct_${suffix}`
  };

  // ── Helpers ────────────────────────────────────────────────────────────

  function sourceItem(
    id: string,
    overrides: {
      processedAt?: Date | null;
      notionPageId?: string | null;
      screeningResultJson?: unknown;
      metadataJson?: unknown;
    } = {}
  ) {
    return {
      id,
      companyId,
      source: "notion",
      sourceItemId: `sid-${id}`,
      externalId: `ext-${id}`,
      fingerprint: `fp-${id}`,
      sourceUrl: `https://example.com/${id}`,
      title: `Title ${id.slice(0, 20)}`,
      summary: "summary",
      text: "text",
      occurredAt: now,
      ingestedAt: now,
      metadataJson: overrides.metadataJson ?? {},
      rawPayloadJson: {},
      rawText: null,
      rawTextStored: false,
      cleanupEligible: false,
      processedAt: overrides.processedAt === undefined ? now : overrides.processedAt,
      notionPageId: overrides.notionPageId === undefined ? null : overrides.notionPageId,
      screeningResultJson: overrides.screeningResultJson ?? { decision: "retain" }
    };
  }

  function opportunity(id: string) {
    return {
      id,
      companyId,
      sourceFingerprint: `opp-fp-${id}`,
      title: `Opportunity ${id.slice(0, 20)}`,
      ownerProfile: "test",
      angle: "angle",
      whyNow: "why",
      whatItIsAbout: "about",
      whatItIsNotAbout: "not about",
      status: "To review",
      suggestedFormat: "post",
      supportingEvidenceCount: 0,
      evidenceFreshness: 0.9,
      notionPageFingerprint: `opp-fp-${id}`,
      v1HistoryJson: []
    };
  }

  function evidence(id: string, sourceItemId: string, opportunityId: string | null) {
    return {
      id,
      sourceItemId,
      companyId,
      opportunityId,
      source: "notion",
      sourceUrl: `https://example.com/${id}`,
      timestamp: now,
      excerpt: `Excerpt ${id.slice(0, 20)}`,
      excerptHash: `hash-${id}`,
      freshnessScore: 0.9
    };
  }

  // ── Cleanup ────────────────────────────────────────────────────────────
  // Best-effort: if the DB went away or setup never completed, the try
  // block silently no-ops so teardown never produces a second failure.

  const allSourceItemIds = Object.values(si);
  const allOppIds = Object.values(opp);
  const allEvIds = Object.values(ev);

  afterAll(async () => {
    try {
      await prisma.opportunityEvidence.deleteMany({
        where: { evidenceId: { in: allEvIds } }
      });
      await prisma.opportunity.updateMany({
        where: { id: { in: allOppIds } },
        data: { primaryEvidenceId: null }
      });
      await prisma.evidenceReference.deleteMany({
        where: { id: { in: allEvIds } }
      });
      await prisma.opportunity.deleteMany({
        where: { id: { in: allOppIds } }
      });
      await prisma.sourceItem.deleteMany({
        where: { id: { in: allSourceItemIds } }
      });
      await prisma.company.deleteMany({
        where: { id: companyId }
      });
    } catch {
      // Connection dead or setup never ran — nothing to clean up.
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  // ── Seed & assert ──────────────────────────────────────────────────────

  it("seeds fixtures and validates disposition filters against real DB", async () => {
    // ── Company (parent for all FK-constrained rows) ─────────────────────

    await prisma.company.create({
      data: {
        id: companyId,
        slug: `test-${suffix}`,
        name: "Integration Test Co",
        defaultTimezone: "UTC"
      }
    });

    // ── Source items ─────────────────────────────────────────────────────

    await prisma.sourceItem.createMany({
      data: [
        sourceItem(si.orphaned),
        sourceItem(si.primaryLinked),
        sourceItem(si.joinLinked),
        sourceItem(si.directLinked),
        sourceItem(si.blocked, { metadataJson: { publishabilityRisk: "harmful" } }),
        sourceItem(si.screenedOut, { processedAt: null, screeningResultJson: { decision: "skip" } }),
        // screeningResultJson exists but lacks "decision" key — must NOT be excluded by the screened-out guard
        sourceItem(si.noDecision, { screeningResultJson: { status: "done" } }),
        sourceItem(si.synced, { notionPageId: `notion-${suffix}` }),
        sourceItem(si.unprocessed, { processedAt: null })
      ]
    });

    // ── Opportunities ───────────────────────────────────────────────────

    await prisma.opportunity.createMany({
      data: [opportunity(opp.a), opportunity(opp.b)]
    });

    // ── Evidence references ─────────────────────────────────────────────

    await prisma.evidenceReference.createMany({
      data: [
        evidence(ev.orphaned, si.orphaned, null),
        evidence(ev.primary, si.primaryLinked, null),
        evidence(ev.join, si.joinLinked, null),
        evidence(ev.direct, si.directLinked, opp.b)
      ]
    });

    // Wire primaryForOpportunities: opp.a → ev.primary
    await prisma.opportunity.update({
      where: { id: opp.a },
      data: { primaryEvidenceId: ev.primary }
    });

    // Wire OpportunityEvidence join: opp.b → ev.join
    await prisma.opportunityEvidence.create({
      data: { opportunityId: opp.b, evidenceId: ev.join }
    });

    // ── Sanity: all 9 items exist ────────────────────────────────────────

    const totalCount = await queries.countSourceItems(companyId);
    expect(totalCount).toBe(allSourceItemIds.length);

    // ── orphaned ────────────────────────────────────────────────────────
    // Matches: si.orphaned (unlinked evidence), si.noDecision + si.synced (no evidence = vacuous every)
    // Rejects: primaryLinked, joinLinked, directLinked (linked), blocked (NOT), screenedOut (NOT), unprocessed

    const orphanedList = await queries.listSourceItems(companyId, { disposition: "orphaned" });
    const orphanedIds = orphanedList.map((r) => r.id);

    expect(orphanedIds).toContain(si.orphaned);
    expect(orphanedIds).toContain(si.noDecision);
    expect(orphanedIds).toContain(si.synced);
    expect(orphanedIds).not.toContain(si.primaryLinked);
    expect(orphanedIds).not.toContain(si.joinLinked);
    expect(orphanedIds).not.toContain(si.directLinked);
    expect(orphanedIds).not.toContain(si.blocked);
    expect(orphanedIds).not.toContain(si.screenedOut);
    expect(orphanedIds).not.toContain(si.unprocessed);

    const orphanedCount = await queries.countSourceItems(companyId, { disposition: "orphaned" });
    expect(orphanedCount).toBe(orphanedIds.length);

    // ── blocked ─────────────────────────────────────────────────────────

    const blockedList = await queries.listSourceItems(companyId, { disposition: "blocked" });
    const blockedIds = blockedList.map((r) => r.id);

    expect(blockedIds).toContain(si.blocked);
    expect(blockedIds).not.toContain(si.orphaned);
    expect(blockedIds).not.toContain(si.screenedOut);

    // ── screened-out ────────────────────────────────────────────────────

    const screenedList = await queries.listSourceItems(companyId, { disposition: "screened-out" });
    const screenedIds = screenedList.map((r) => r.id);

    expect(screenedIds).toContain(si.screenedOut);
    expect(screenedIds).not.toContain(si.orphaned);
    expect(screenedIds).not.toContain(si.noDecision);

    // ── getDashboardCounts — exercises disposition clauses through the ──
    // dashboard path (Object.assign spread), not the filter path.

    const counts = await queries.getDashboardCounts(companyId);

    expect(counts.orphaned).toBe(orphanedIds.length);
    expect(counts.blocked).toBe(blockedIds.length);
    expect(counts.screenedOut).toBe(screenedIds.length);
    expect(counts.sourceItems).toBe(allSourceItemIds.length);
  });
});
