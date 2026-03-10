import type { ContentOpportunity, EditorialSignal, TerritoryAssignment } from "../domain/types.js";
import { createDeterministicId, hashParts } from "../lib/ids.js";

export function maybeCreateOpportunity(params: {
  signal: EditorialSignal;
  assignment: TerritoryAssignment;
  clusterConflict: boolean;
  confidenceThreshold?: number;
  evidenceRichnessThreshold?: number;
}): ContentOpportunity | null {
  const {
    signal,
    assignment,
    clusterConflict,
    confidenceThreshold = 0.75,
    evidenceRichnessThreshold = 2
  } = params;

  if (signal.sensitivity.blocked) return null;
  if (signal.duplicateOfSignalId) return null;
  if (assignment.needsRouting) return null;
  if (clusterConflict) return null;
  if (signal.confidence < confidenceThreshold) return null;
  if (signal.evidence.length < evidenceRichnessThreshold) return null;

  const primaryEvidence = signal.evidence[0];
  const sourceFingerprint = hashParts([...signal.sourceItemIds.sort(), assignment.profileId ?? "unassigned", signal.suggestedAngle]);
  return {
    id: createDeterministicId("opportunity", [sourceFingerprint]),
    sourceFingerprint,
    title: signal.title,
    ownerProfile: assignment.profileId,
    narrativePillar: assignment.territory,
    angle: signal.suggestedAngle,
    whyNow: `Fresh evidence score ${(signal.freshness * 100).toFixed(0)} with ${signal.evidence.length} supporting excerpts.`,
    whatItIsAbout: signal.summary,
    whatItIsNotAbout: "A generic thought-leadership take without direct evidence.",
    relatedSignalIds: [signal.id],
    primaryEvidence,
    supportingEvidenceCount: Math.max(0, signal.evidence.length - 1),
    evidenceFreshness: primaryEvidence.freshnessScore,
    evidenceExcerpts: signal.evidence.map((item) => item.excerpt),
    routingStatus: "Routed",
    readiness: "Opportunity only",
    status: "To review",
    suggestedFormat: suggestFormat(signal),
    v1History: [],
    notionPageFingerprint: sourceFingerprint
  };
}

export function qualifyDraftCandidate(opportunity: ContentOpportunity, clusterConflict: boolean) {
  if (opportunity.routingStatus === "Needs routing") {
    return opportunity;
  }

  if (clusterConflict || opportunity.supportingEvidenceCount < 1 || opportunity.evidenceFreshness < 0.4) {
    return opportunity;
  }

  return {
    ...opportunity,
    readiness: "Draft candidate",
    status: "Ready for V1"
  } satisfies ContentOpportunity;
}

function suggestFormat(signal: EditorialSignal) {
  if (signal.type === "quote") {
    return "Quote-led post";
  }
  if (signal.type === "market-pattern") {
    return "Short insight + explanation";
  }
  return "Narrative lesson post";
}
