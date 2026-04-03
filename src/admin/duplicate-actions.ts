import type { Prisma, PrismaClient } from "@prisma/client";

// ── Types ────────────────────────────────────────────────────��────────

export type ClusterDecision = "canonical" | "archive" | "keep-separate";

export interface DuplicateReviewInput {
  clusterId: string;
  decisions: Record<string, ClusterDecision>;
  reviewedBy: string;
}

export interface DuplicateReviewResult {
  archivedIds: string[];
  canonicalId: string | null;
  evidenceMerged: number;
  keepSeparateIds: string[];
}

// ── Validation ────────────────────────────────────────────────────────

export function validateDecisions(
  memberIds: string[],
  decisions: Record<string, ClusterDecision>
): string | null {
  const memberSet = new Set(memberIds);
  const decisionKeys = Object.keys(decisions);

  // Every member must have a decision
  for (const id of memberIds) {
    if (!(id in decisions)) return `Missing decision for member ${id}`;
  }

  // No decisions for non-members
  for (const id of decisionKeys) {
    if (!memberSet.has(id)) return `Decision for non-member ${id}`;
  }

  const archiveCount = decisionKeys.filter((k) => decisions[k] === "archive").length;
  const canonicalCount = decisionKeys.filter((k) => decisions[k] === "canonical").length;
  const keepSeparateCount = decisionKeys.filter((k) => decisions[k] === "keep-separate").length;

  // Either all keep-separate, or exactly one canonical
  if (keepSeparateCount === memberIds.length) return null; // all keep-separate is valid
  if (canonicalCount !== 1) return "Exactly one member must be marked canonical (unless all are keep-separate)";
  if (archiveCount === 0) return "At least one member must be archived when a canonical is chosen";

  return null;
}

// ── Execution ─────────────────────────────────────────────────────────

export async function executeDuplicateReview(
  prisma: PrismaClient,
  input: DuplicateReviewInput
): Promise<DuplicateReviewResult> {
  const cluster = await prisma.duplicateCluster.findUnique({
    where: { id: input.clusterId }
  });
  if (!cluster) throw new Error(`Cluster ${input.clusterId} not found`);
  if (cluster.status === "reviewed") throw new Error(`Cluster ${input.clusterId} already reviewed`);

  const validationError = validateDecisions(cluster.memberIds, input.decisions);
  if (validationError) throw new Error(validationError);

  const canonicalId = Object.keys(input.decisions).find(
    (k) => input.decisions[k] === "canonical"
  ) ?? null;
  const archiveIds = Object.keys(input.decisions).filter(
    (k) => input.decisions[k] === "archive"
  );
  const keepSeparateIds = Object.keys(input.decisions).filter(
    (k) => input.decisions[k] === "keep-separate"
  );

  let totalEvidenceMerged = 0;
  const now = new Date().toISOString();

  await prisma.$transaction(async (tx) => {
    // Handle archive+merge decisions
    if (canonicalId && archiveIds.length > 0) {
      // Load canonical's existing evidence IDs
      const canonicalEvidence = await tx.evidenceReference.findMany({
        where: { opportunityId: canonicalId },
        select: { id: true }
      });
      const canonicalJunction = await tx.opportunityEvidence.findMany({
        where: { opportunityId: canonicalId },
        select: { evidenceId: true }
      });
      const canonicalEvidenceIds = new Set([
        ...canonicalEvidence.map((e) => e.id),
        ...canonicalJunction.map((j) => j.evidenceId)
      ]);

      for (const archivedId of archiveIds) {
        // Collect all evidence from the archived opportunity
        const directEvidence = await tx.evidenceReference.findMany({
          where: { opportunityId: archivedId },
          select: { id: true, sourceItemId: true }
        });
        const junctionEvidence = await tx.opportunityEvidence.findMany({
          where: { opportunityId: archivedId },
          include: { evidence: { select: { id: true, sourceItemId: true } } }
        });

        const allArchivedEvidence = new Map<string, { id: string; sourceItemId: string }>();
        for (const e of directEvidence) allArchivedEvidence.set(e.id, e);
        for (const je of junctionEvidence) {
          allArchivedEvidence.set(je.evidence.id, {
            id: je.evidence.id,
            sourceItemId: je.evidence.sourceItemId
          });
        }

        // Identify unique evidence to merge
        const toMerge = [...allArchivedEvidence.values()].filter(
          (e) => !canonicalEvidenceIds.has(e.id)
        );

        if (toMerge.length > 0) {
          // Re-point direct FK evidence to canonical
          const directIds = directEvidence.map((e) => e.id);
          const mergeDirectIds = toMerge.filter((e) => directIds.includes(e.id)).map((e) => e.id);
          if (mergeDirectIds.length > 0) {
            await tx.evidenceReference.updateMany({
              where: { id: { in: mergeDirectIds }, opportunityId: archivedId },
              data: { opportunityId: canonicalId }
            });
          }

          // Create junction links to canonical
          await tx.opportunityEvidence.createMany({
            data: toMerge.map((e) => ({
              opportunityId: canonicalId,
              evidenceId: e.id,
              relevanceNote: `Merged from archived duplicate ${archivedId}`
            })),
            skipDuplicates: true
          });

          // Track merged evidence in canonical's evidence set
          for (const e of toMerge) canonicalEvidenceIds.add(e.id);
        }

        totalEvidenceMerged += toMerge.length;

        // Archive the duplicate opportunity
        const archived = await tx.opportunity.findUniqueOrThrow({
          where: { id: archivedId },
          select: { enrichmentLogJson: true }
        });
        const archivedLog = Array.isArray(archived.enrichmentLogJson)
          ? (archived.enrichmentLogJson as unknown[])
          : [];
        archivedLog.push({
          createdAt: now,
          rawSourceItemId: "",
          evidenceIds: [],
          contextComment: `Archived as Tier 2 duplicate. Evidence merged to canonical ${canonicalId}.`,
          reason: "tier2-duplicate-review",
          confidence: 1.0
        });

        await tx.opportunity.update({
          where: { id: archivedId },
          data: {
            status: "Archived",
            dedupFlag: `Archived as Tier 2 duplicate of ${canonicalId}`,
            enrichmentLogJson: archivedLog as Prisma.InputJsonValue
          }
        });
      }

      // Update canonical's evidence count and enrichment log
      const canonical = await tx.opportunity.findUniqueOrThrow({
        where: { id: canonicalId },
        select: { supportingEvidenceCount: true, enrichmentLogJson: true }
      });
      const canonicalLog = Array.isArray(canonical.enrichmentLogJson)
        ? (canonical.enrichmentLogJson as unknown[])
        : [];
      if (totalEvidenceMerged > 0) {
        canonicalLog.push({
          createdAt: now,
          rawSourceItemId: "",
          evidenceIds: [],
          contextComment: `Merged ${totalEvidenceMerged} evidence item(s) from ${archiveIds.length} archived duplicate(s).`,
          reason: "tier2-duplicate-merge",
          confidence: 1.0
        });
      }

      await tx.opportunity.update({
        where: { id: canonicalId },
        data: {
          supportingEvidenceCount: canonical.supportingEvidenceCount + totalEvidenceMerged,
          enrichmentLogJson: canonicalLog as Prisma.InputJsonValue
        }
      });
    }

    // Handle keep-separate decisions
    for (const id of keepSeparateIds) {
      await tx.opportunity.update({
        where: { id },
        data: {
          dedupFlag: `Reviewed: keep-separate (cluster ${input.clusterId})`
        }
      });
    }

    // Mark cluster as reviewed
    await tx.duplicateCluster.update({
      where: { id: input.clusterId },
      data: {
        status: "reviewed",
        decisionsJson: input.decisions,
        reviewedAt: new Date(),
        reviewedBy: input.reviewedBy
      }
    });
  });

  return {
    archivedIds: archiveIds,
    canonicalId,
    evidenceMerged: totalEvidenceMerged,
    keepSeparateIds
  };
}
