import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

const hasDatabase = Boolean(process.env.DATABASE_URL) && !String(process.env.DATABASE_URL).includes("localhost:5432");

describe.skipIf(!hasDatabase)("repository DB integrity", () => {
  const prisma = new PrismaClient();

  it("rejects assigning a primary evidence row owned by another opportunity", async () => {
    const suffix = randomUUID();
    const sourceItemIds = [`source_item_a_${suffix}`, `source_item_b_${suffix}`];
    const opportunityIds = [`opp_a_${suffix}`, `opp_b_${suffix}`];
    const evidenceIds = [`evidence_a_${suffix}`, `evidence_b_${suffix}`];
    const now = new Date("2026-03-10T12:00:00.000Z");

    await prisma.sourceItem.createMany({
      data: [
        {
          id: sourceItemIds[0],
          companyId: "test-company-id",
          source: "notion",
          sourceItemId: `slack-a-${suffix}`,
          externalId: `slack:${suffix}:a`,
          fingerprint: `source-fp-a-${suffix}`,
          sourceUrl: "https://example.com/a",
          title: "A",
          summary: "A",
          text: "A",
          occurredAt: now,
          ingestedAt: now,
          metadataJson: {},
          rawPayloadJson: {},
          rawText: null,
          rawTextStored: false,
          cleanupEligible: false
        },
        {
          id: sourceItemIds[1],
          companyId: "test-company-id",
          source: "notion",
          sourceItemId: `slack-b-${suffix}`,
          externalId: `slack:${suffix}:b`,
          fingerprint: `source-fp-b-${suffix}`,
          sourceUrl: "https://example.com/b",
          title: "B",
          summary: "B",
          text: "B",
          occurredAt: now,
          ingestedAt: now,
          metadataJson: {},
          rawPayloadJson: {},
          rawText: null,
          rawTextStored: false,
          cleanupEligible: false
        }
      ]
    });

    await prisma.opportunity.createMany({
      data: [
        {
          id: opportunityIds[0],
          companyId: "test-company-id",
          sourceFingerprint: `opp-fp-a-${suffix}`,
          title: "Opportunity A",
          ownerProfile: "quentin",
          narrativePillar: "sales",
          angle: "Angle A",
          whyNow: "Why now A",
          whatItIsAbout: "About A",
          whatItIsNotAbout: "Not about A",
          routingStatus: "Routed",
          readiness: "Draft candidate",
          status: "Ready for V1",
          suggestedFormat: "Narrative lesson post",
          supportingEvidenceCount: 0,
          evidenceFreshness: 0.9,
          v1HistoryJson: [],
          notionPageFingerprint: `opp-fp-a-${suffix}`
        },
        {
          id: opportunityIds[1],
          companyId: "test-company-id",
          sourceFingerprint: `opp-fp-b-${suffix}`,
          title: "Opportunity B",
          ownerProfile: "quentin",
          narrativePillar: "sales",
          angle: "Angle B",
          whyNow: "Why now B",
          whatItIsAbout: "About B",
          whatItIsNotAbout: "Not about B",
          routingStatus: "Routed",
          readiness: "Draft candidate",
          status: "Ready for V1",
          suggestedFormat: "Narrative lesson post",
          supportingEvidenceCount: 0,
          evidenceFreshness: 0.9,
          v1HistoryJson: [],
          notionPageFingerprint: `opp-fp-b-${suffix}`
        }
      ]
    });

    await prisma.evidenceReference.createMany({
      data: [
        {
          id: evidenceIds[0],
          opportunityId: opportunityIds[0],
          sourceItemId: sourceItemIds[0],
          source: "notion",
          sourceUrl: "https://example.com/a",
          timestamp: now,
          excerpt: "Proof A",
          excerptHash: `hash-a-${suffix}`,
          freshnessScore: 0.9
        },
        {
          id: evidenceIds[1],
          opportunityId: opportunityIds[1],
          sourceItemId: sourceItemIds[1],
          source: "notion",
          sourceUrl: "https://example.com/b",
          timestamp: now,
          excerpt: "Proof B",
          excerptHash: `hash-b-${suffix}`,
          freshnessScore: 0.9
        }
      ]
    });

    await expect(
      prisma.opportunity.update({
        where: { id: opportunityIds[0] },
        data: {
          primaryEvidenceId: evidenceIds[1]
        }
      })
    ).rejects.toThrow();

    await prisma.opportunity.deleteMany({
      where: {
        id: {
          in: opportunityIds
        }
      }
    });
    await prisma.sourceItem.deleteMany({
      where: {
        id: {
          in: sourceItemIds
        }
      }
    });
  });
});
