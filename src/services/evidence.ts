import { createDeterministicId, hashText } from "../lib/ids.js";
import type { EvidenceReference, NormalizedSourceItem } from "../domain/types.js";

export function buildEvidenceReferences(item: NormalizedSourceItem, maxExcerpts = 3): EvidenceReference[] {
  const sourceBlocks = item.chunks && item.chunks.length > 0 ? item.chunks : splitIntoParagraphs(item.text);
  const excerpts = sourceBlocks.filter((entry) => entry.trim().length > 0).slice(0, maxExcerpts);
  const freshnessScore = computeFreshnessScore(item.occurredAt);

  return excerpts.map((excerpt, index) => ({
    id: createDeterministicId("evidence", [item.externalId, hashText(excerpt), index]),
    source: item.source,
    sourceItemId: item.externalId,
    sourceUrl: item.sourceUrl,
    timestamp: item.occurredAt,
    excerpt: excerpt.slice(0, 500),
    excerptHash: hashText(excerpt),
    speakerOrAuthor: item.speakerName ?? item.authorName,
    freshnessScore
  }));
}

function splitIntoParagraphs(text: string) {
  return text
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function computeFreshnessScore(occurredAt: string) {
  const ageMs = Date.now() - new Date(occurredAt).getTime();
  const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
  return Math.max(0, 1 - ageDays / 30);
}

export function evidenceSignature(item: Pick<EvidenceReference, "sourceItemId" | "excerptHash">) {
  return `${item.sourceItemId}:${item.excerptHash}`;
}

export function dedupeEvidenceReferences(evidence: EvidenceReference[]) {
  const unique = new Map<string, EvidenceReference>();
  for (const item of evidence) {
    const key = evidenceSignature(item);
    const existing = unique.get(key);
    if (!existing || compareEvidencePriority(item, existing) < 0) {
      unique.set(key, item);
    }
  }

  return [...unique.values()];
}

export function selectPrimaryEvidence(
  evidence: EvidenceReference[],
  preferred?: { id?: string; signature?: string } | null
) {
  if (evidence.length === 0) {
    return null;
  }

  if (preferred?.id) {
    const match = evidence.find((item) => item.id === preferred.id);
    if (match) {
      return match;
    }
  }

  if (preferred?.signature) {
    const match = evidence.find((item) => evidenceSignature(item) === preferred.signature);
    if (match) {
      return match;
    }
  }

  return [...evidence].sort(compareEvidencePriority)[0] ?? null;
}

export function scopeEvidenceReferences(scope: "opportunity" | "draft", ownerId: string, evidence: EvidenceReference[]) {
  return evidence.map((item) => ({
    ...item,
    id: createDeterministicId("evidence", [scope, ownerId, item.sourceItemId, item.excerptHash])
  }));
}

function compareEvidencePriority(left: EvidenceReference, right: EvidenceReference) {
  if (left.freshnessScore !== right.freshnessScore) {
    return right.freshnessScore - left.freshnessScore;
  }

  const leftTime = new Date(left.timestamp).getTime();
  const rightTime = new Date(right.timestamp).getTime();
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  return left.id.localeCompare(right.id);
}
