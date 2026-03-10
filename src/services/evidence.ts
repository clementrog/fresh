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
