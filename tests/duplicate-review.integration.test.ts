import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it, afterAll } from "vitest";

import { AdminQueries, clusterSuppressionHash } from "../src/admin/queries.js";
import { executeDuplicateReview } from "../src/admin/duplicate-actions.js";

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
  describe("duplicate review integration", () => {
    it("requires a reachable Postgres database", () => {
      expect.fail(
        "INTEGRATION=1 is set but Postgres is not reachable. " +
          "Ensure DATABASE_URL points to a running database."
      );
    });
  });
}

describe.skipIf(!dbReachable)("duplicate review integration", () => {
  const prisma = new PrismaClient();
  const queries = new AdminQueries(prisma);
  const suffix = randomUUID();
  const now = new Date("2026-04-03T12:00:00.000Z");

  // ── IDs ─────────────────────────────────────────────────────────────

  const companyId = `company_${suffix}`;

  const si = {
    shared: `si_shared_${suffix}`,
    unique: `si_unique_${suffix}`,
    isolated: `si_isolated_${suffix}`
  };

  const opp = {
    a: `opp_a_${suffix}`,
    b: `opp_b_${suffix}`,
    c: `opp_c_${suffix}`,       // shares evidence with a+b
    isolated: `opp_iso_${suffix}` // no shared evidence
  };

  const ev = {
    a_shared: `ev_a_shared_${suffix}`,
    b_shared: `ev_b_shared_${suffix}`,
    c_shared: `ev_c_shared_${suffix}`,
    b_unique: `ev_b_unique_${suffix}`,
    iso: `ev_iso_${suffix}`
  };

  // ── Helpers ─────────────────────────────────────────────────────────

  function sourceItem(id: string) {
    return {
      id,
      companyId,
      source: "claap",
      sourceItemId: `sid-${id}`,
      externalId: `ext-${id}`,
      fingerprint: `fp-${id}`,
      sourceUrl: `https://example.com/${id}`,
      title: `Title ${id.slice(0, 20)}`,
      summary: "summary",
      text: "text",
      occurredAt: now,
      ingestedAt: now,
      metadataJson: {},
      rawPayloadJson: {},
      rawText: null,
      rawTextStored: false,
      cleanupEligible: false,
      processedAt: now,
      screeningResultJson: { decision: "retain" }
    };
  }

  function opportunity(id: string, title: string) {
    return {
      id,
      companyId,
      sourceFingerprint: `opp-fp-${id}`,
      title,
      ownerProfile: "test",
      angle: `angle for ${title}`,
      whyNow: "timely",
      whatItIsAbout: "about",
      whatItIsNotAbout: "not about",
      status: "To review",
      suggestedFormat: "post",
      supportingEvidenceCount: 1,
      evidenceFreshness: 0.9,
      notionPageFingerprint: `opp-fp-${id}`,
      v1HistoryJson: [],
      enrichmentLogJson: []
    };
  }

  function evidence(id: string, sourceItemId: string, opportunityId: string) {
    return {
      id,
      sourceItemId,
      opportunityId,
      source: "claap",
      sourceUrl: `https://example.com/${id}`,
      timestamp: now,
      excerpt: `Excerpt for ${id.slice(0, 20)}`,
      excerptHash: `hash-${id}`,
      freshnessScore: 0.9
    };
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  const allEvIds = Object.values(ev);
  const allOppIds = Object.values(opp);
  const allSiIds = Object.values(si);

  afterAll(async () => {
    try {
      await prisma.duplicateCluster.deleteMany({ where: { companyId } });
      await prisma.opportunityEvidence.deleteMany({
        where: { evidenceId: { in: allEvIds } }
      });
      await prisma.evidenceReference.deleteMany({
        where: { id: { in: allEvIds } }
      });
      await prisma.opportunity.deleteMany({
        where: { id: { in: allOppIds } }
      });
      await prisma.sourceItem.deleteMany({
        where: { id: { in: allSiIds } }
      });
      await prisma.company.deleteMany({ where: { id: companyId } });
    } catch {
      // Best-effort cleanup
    }
    await prisma.$disconnect();
  });

  // ── Seed ────────────────────────────────────────────────────────────

  it("seeds test data", async () => {
    await prisma.company.create({
      data: {
        id: companyId,
        slug: `test-dup-${suffix.slice(0, 8)}`,
        name: "Test Dup Company",
        defaultTimezone: "Europe/Paris"
      }
    });

    // Source items
    await prisma.sourceItem.createMany({
      data: [sourceItem(si.shared), sourceItem(si.unique), sourceItem(si.isolated)]
    });

    // Opportunities
    await prisma.opportunity.createMany({
      data: [
        opportunity(opp.a, "Migration paie DSN cloud"),
        opportunity(opp.b, "Migration paie DSN conformité"),
        opportunity(opp.c, "Migration DSN risques techniques"),
        opportunity(opp.isolated, "Recrutement alternants 2026")
      ]
    });

    // Evidence: a, b, c all share si.shared; b also has unique evidence
    await prisma.evidenceReference.createMany({
      data: [
        evidence(ev.a_shared, si.shared, opp.a),
        evidence(ev.b_shared, si.shared, opp.b),
        evidence(ev.c_shared, si.shared, opp.c),
        evidence(ev.b_unique, si.unique, opp.b),
        evidence(ev.iso, si.isolated, opp.isolated)
      ]
    });
  });

  // ── Detection ───────────────────────────────────────────────────────

  it("detects overlapping opportunities as a cluster", async () => {
    const detected = await queries.detectDuplicateClusters(companyId);
    expect(detected.length).toBeGreaterThanOrEqual(1);

    const cluster = detected.find(
      (c) => c.memberIds.includes(opp.a) && c.memberIds.includes(opp.b)
    );
    expect(cluster).toBeDefined();
    expect(cluster!.memberIds).toContain(opp.c);
  });

  it("does not cluster the isolated opportunity", async () => {
    const detected = await queries.detectDuplicateClusters(companyId);
    const isolatedCluster = detected.find((c) => c.memberIds.includes(opp.isolated));
    expect(isolatedCluster).toBeUndefined();
  });

  // ── Review: archive + merge ─────────────────────────────────────────

  let clusterId: string;

  it("creates a pending cluster and reviews it with archive+merge", async () => {
    const detected = await queries.detectDuplicateClusters(companyId);
    const target = detected.find((c) => c.memberIds.includes(opp.a))!;

    // Upsert as pending
    const cluster = await queries.upsertPendingCluster(
      companyId,
      target.memberIds,
      target.suppressionHash
    );
    clusterId = cluster.id;
    expect(cluster.status).toBe("pending");

    // Review: a=canonical, b=archive, c=archive
    const result = await executeDuplicateReview(prisma, {
      clusterId: cluster.id,
      decisions: {
        [opp.a]: "canonical",
        [opp.b]: "archive",
        [opp.c]: "archive"
      },
      reviewedBy: "test-admin"
    });

    expect(result.canonicalId).toBe(opp.a);
    expect(result.archivedIds).toContain(opp.b);
    expect(result.archivedIds).toContain(opp.c);
    expect(result.evidenceMerged).toBeGreaterThan(0);
  });

  it("archived opportunities have correct status and dedupFlag", async () => {
    const archived = await prisma.opportunity.findUniqueOrThrow({
      where: { id: opp.b }
    });
    expect(archived.status).toBe("Archived");
    expect(archived.dedupFlag).toContain("Tier 2 duplicate");
    expect(archived.dedupFlag).toContain(opp.a);
  });

  it("canonical has merged evidence and enrichment log", async () => {
    const canonical = await prisma.opportunity.findUniqueOrThrow({
      where: { id: opp.a },
      include: {
        evidence: { select: { id: true } },
        linkedEvidence: { select: { evidenceId: true } }
      }
    });

    // The unique evidence from b should now be linked to a
    const allEvidenceIds = [
      ...canonical.evidence.map((e) => e.id),
      ...canonical.linkedEvidence.map((le) => le.evidenceId)
    ];
    expect(allEvidenceIds).toContain(ev.b_unique);

    // Enrichment log should have a merge entry
    const log = canonical.enrichmentLogJson as Array<{ reason: string }>;
    expect(log.some((e) => e.reason === "tier2-duplicate-merge")).toBe(true);
  });

  it("cluster is marked as reviewed", async () => {
    const cluster = await prisma.duplicateCluster.findUniqueOrThrow({
      where: { id: clusterId }
    });
    expect(cluster.status).toBe("reviewed");
    expect(cluster.reviewedBy).toBe("test-admin");
    expect(cluster.reviewedAt).not.toBeNull();
  });

  // ── Suppression ─────────────────────────────────────────────────────

  it("reviewed cluster is suppressed from detection", async () => {
    const detected = await queries.detectDuplicateClusters(companyId);
    // The original cluster should not appear (b and c are now Archived,
    // so they are excluded from detection)
    const resurfaced = detected.find((c) => c.memberIds.includes(opp.a));
    expect(resurfaced).toBeUndefined();
  });

  // ── Keep-separate ───────────────────────────────────────────────────

  it("keep-separate sets dedupFlag without archiving", async () => {
    // Create a new pair for keep-separate test
    const newSuffix = randomUUID().slice(0, 8);
    const newOppX = `opp_x_${suffix}_${newSuffix}`;
    const newOppY = `opp_y_${suffix}_${newSuffix}`;
    const newEvX = `ev_x_${suffix}_${newSuffix}`;
    const newEvY = `ev_y_${suffix}_${newSuffix}`;

    await prisma.opportunity.createMany({
      data: [
        opportunity(newOppX, "Portail client adoption"),
        opportunity(newOppY, "Portail client onboarding")
      ]
    });
    await prisma.evidenceReference.createMany({
      data: [
        evidence(newEvX, si.isolated, newOppX),
        evidence(newEvY, si.isolated, newOppY)
      ]
    });

    // Create and review as keep-separate
    const sorted = [newOppX, newOppY].sort();
    const hash = clusterSuppressionHash(sorted);
    const cluster = await queries.upsertPendingCluster(companyId, sorted, hash);

    await executeDuplicateReview(prisma, {
      clusterId: cluster.id,
      decisions: {
        [newOppX]: "keep-separate",
        [newOppY]: "keep-separate"
      },
      reviewedBy: "test-admin"
    });

    const x = await prisma.opportunity.findUniqueOrThrow({ where: { id: newOppX } });
    const y = await prisma.opportunity.findUniqueOrThrow({ where: { id: newOppY } });
    expect(x.status).toBe("To review"); // not archived
    expect(y.status).toBe("To review");
    expect(x.dedupFlag).toContain("keep-separate");
    expect(y.dedupFlag).toContain("keep-separate");

    // Cleanup
    await prisma.duplicateCluster.delete({ where: { id: cluster.id } }).catch(() => {});
    await prisma.evidenceReference.deleteMany({ where: { id: { in: [newEvX, newEvY] } } });
    await prisma.opportunity.deleteMany({ where: { id: { in: [newOppX, newOppY] } } });
  });
});
