import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it, afterAll } from "vitest";

import { RepositoryBundle } from "../src/db/repositories.js";

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
  describe("GTM operator-edit persistence", () => {
    it("requires a reachable Postgres database", () => {
      expect.fail(
        "INTEGRATION=1 is set but Postgres is not reachable. " +
          "Ensure DATABASE_URL points to a running database."
      );
    });
  });
}

describe.skipIf(!dbReachable)("GTM operator-edit persistence", () => {
  const prisma = new PrismaClient();
  const repos = new RepositoryBundle(prisma);
  const suffix = randomUUID();
  const now = new Date("2026-03-30T12:00:00.000Z");

  const companyId = `company_gtm_${suffix}`;
  const oppId = `opp_gtm_${suffix}`;
  const siId = `si_gtm_${suffix}`;
  const evId = `ev_gtm_${suffix}`;

  afterAll(async () => {
    try {
      await prisma.opportunity.updateMany({
        where: { id: oppId },
        data: { primaryEvidenceId: null }
      });
      await prisma.evidenceReference.deleteMany({
        where: { id: evId }
      });
      await prisma.opportunity.deleteMany({
        where: { id: oppId }
      });
      await prisma.sourceItem.deleteMany({
        where: { id: siId }
      });
      await prisma.company.deleteMany({
        where: { id: companyId }
      });
    } catch {
      // Connection dead or setup never ran
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  it("empty string clears a stored GTM field; undefined preserves existing DB value", async () => {
    // ── Seed ─────────────────────────────────────────────────────────────

    await prisma.company.create({
      data: {
        id: companyId,
        slug: `gtm-test-${suffix}`,
        name: "GTM Integration Test Co",
        defaultTimezone: "UTC"
      }
    });

    await prisma.sourceItem.create({
      data: {
        id: siId,
        companyId,
        source: "notion",
        sourceItemId: `sid-${siId}`,
        externalId: `ext-${siId}`,
        fingerprint: `fp-${siId}`,
        sourceUrl: "https://example.com/gtm",
        title: "GTM test source",
        summary: "summary",
        text: "text",
        occurredAt: now,
        ingestedAt: now,
        metadataJson: {},
        rawPayloadJson: {},
        processedAt: now,
        screeningResultJson: { decision: "retain" }
      }
    });

    await prisma.opportunity.create({
      data: {
        id: oppId,
        companyId,
        sourceFingerprint: `opp-fp-${oppId}`,
        title: "GTM test opportunity",
        angle: "test angle",
        whyNow: "test why",
        whatItIsAbout: "test about",
        whatItIsNotAbout: "test not",
        status: "To review",
        suggestedFormat: "post",
        supportingEvidenceCount: 0,
        evidenceFreshness: 0.9,
        notionPageFingerprint: `npf-${oppId}`,
        targetSegment: "production-manager",
        editorialPillar: "proof",
        awarenessTarget: "problem-aware",
        buyerFriction: "Calculation opacity blocks trust",
        contentMotion: "demand-capture"
      }
    });

    await prisma.evidenceReference.create({
      data: {
        id: evId,
        sourceItemId: siId,
        companyId,
        opportunityId: oppId,
        source: "notion",
        sourceUrl: "https://example.com/ev",
        timestamp: now,
        excerpt: "GTM test excerpt",
        excerptHash: `hash-${evId}`,
        freshnessScore: 0.9
      }
    });

    // ── Verify seed ──────────────────────────────────────────────────────

    const seeded = await prisma.opportunity.findUnique({ where: { id: oppId } });
    expect(seeded!.targetSegment).toBe("production-manager");
    expect(seeded!.editorialPillar).toBe("proof");
    expect(seeded!.awarenessTarget).toBe("problem-aware");
    expect(seeded!.buyerFriction).toBe("Calculation opacity blocks trust");
    expect(seeded!.contentMotion).toBe("demand-capture");

    // ── Act 1: "" clears stored fields via updateOpportunityEditableFields

    await repos.updateOpportunityEditableFields({
      opportunityId: oppId,
      title: "GTM test opportunity",
      angle: "test angle",
      whyNow: "test why",
      whatItIsAbout: "test about",
      whatItIsNotAbout: "test not",
      editorialNotes: "",
      // "" = explicit clear (operator cleared the select in Notion)
      targetSegment: "",
      editorialPillar: "",
      // undefined = absent (unsupported value or field not in edit request)
      awarenessTarget: undefined,
      buyerFriction: undefined,
      contentMotion: undefined
    });

    const afterClear = await prisma.opportunity.findUnique({ where: { id: oppId } });
    // Cleared fields written as ""
    expect(afterClear!.targetSegment).toBe("");
    expect(afterClear!.editorialPillar).toBe("");
    // undefined fields preserved — conditional spread skipped the write
    expect(afterClear!.awarenessTarget).toBe("problem-aware");
    expect(afterClear!.buyerFriction).toBe("Calculation opacity blocks trust");
    expect(afterClear!.contentMotion).toBe("demand-capture");

    // ── Act 2: valid value overwrites via updateOpportunityEditableFields

    await repos.updateOpportunityEditableFields({
      opportunityId: oppId,
      title: "GTM test opportunity",
      angle: "test angle",
      whyNow: "test why",
      whatItIsAbout: "test about",
      whatItIsNotAbout: "test not",
      editorialNotes: "",
      targetSegment: "cabinet-owner",
      contentMotion: "trust"
    });

    const afterOverwrite = await prisma.opportunity.findUnique({ where: { id: oppId } });
    expect(afterOverwrite!.targetSegment).toBe("cabinet-owner");
    expect(afterOverwrite!.contentMotion).toBe("trust");
    // Previously cleared field stays cleared (not magically restored)
    expect(afterOverwrite!.editorialPillar).toBe("");
    // Omitted fields still preserved
    expect(afterOverwrite!.awarenessTarget).toBe("problem-aware");
    expect(afterOverwrite!.buyerFriction).toBe("Calculation opacity blocks trust");
  });
});
