import type { ContentOpportunity, EditorialSignal, TerritoryAssignment } from "../domain/types.js";
import { createDeterministicId, hashParts } from "../lib/ids.js";
import { evidenceSignature, scopeEvidenceReferences, selectPrimaryEvidence } from "./evidence.js";

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

  const sourceFingerprint = hashParts([...signal.sourceItemIds.sort(), assignment.profileId ?? "unassigned", signal.suggestedAngle]);
  const evidence = scopeEvidenceReferences("opportunity", sourceFingerprint, signal.evidence);
  const primaryEvidence = selectPrimaryEvidence(evidence, {
    signature: signal.evidence[0] ? evidenceSignature(signal.evidence[0]) : undefined
  });
  if (!primaryEvidence) {
    return null;
  }

  return {
    id: createDeterministicId("opportunity", [sourceFingerprint]),
    sourceFingerprint,
    title: signal.title,
    ownerProfile: assignment.profileId,
    narrativePillar: assignment.territory,
    angle: signal.suggestedAngle,
    whyNow: `Fresh evidence score ${(signal.freshness * 100).toFixed(0)} with ${signal.evidence.length} supporting excerpts.`,
    whatItIsAbout: signal.summary,
    whatItIsNotAbout: describeWhatItIsNotAbout(signal),
    relatedSignalIds: [signal.id],
    evidence,
    primaryEvidence,
    supportingEvidenceCount: Math.max(0, evidence.length - 1),
    evidenceFreshness: primaryEvidence.freshnessScore,
    evidenceExcerpts: evidence.map((item) => item.excerpt),
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

function describeWhatItIsNotAbout(signal: EditorialSignal) {
  switch (signal.type) {
    case "objection":
    case "adoption-blocker":
      return "A generic sales pep talk or a feature list without real field objections.";
    case "friction":
    case "process-lesson":
      return "A vague complaint about operations without concrete proof from the field.";
    case "market-pattern":
    case "decision-rationale":
    case "tradeoff":
      return "A broad trend comment that lacks a sharp point of view or real evidence.";
    case "user-language":
    case "quote":
      return "An isolated quote with no editorial lesson behind it.";
    default:
      return "A generic thought-leadership take without direct evidence.";
  }
}
