import { hashText } from "../lib/ids.js";
import type { EditorialSignal, ThemeCluster } from "../domain/types.js";

export function markObviousDuplicates(signals: EditorialSignal[]) {
  const seen = new Map<string, string>();

  return signals.map((signal) => {
    const fingerprint = hashText(
      [
        signal.title.toLowerCase(),
        signal.type,
        ...signal.sourceItemIds.sort(),
        ...signal.evidence.slice(0, 2).map((item) => item.excerptHash)
      ].join("|")
    );
    const duplicateOfSignalId = seen.get(fingerprint);
    if (!duplicateOfSignalId) {
      seen.set(fingerprint, signal.id);
      return signal;
    }

    return {
      ...signal,
      duplicateOfSignalId
    };
  });
}

export function buildThemeClusters(signals: EditorialSignal[]): ThemeCluster[] {
  const buckets = new Map<string, EditorialSignal[]>();

  for (const signal of signals) {
    const key = hashText(
      [
        signal.type,
        signal.suggestedAngle.toLowerCase(),
        signal.probableOwnerProfile ?? "unknown",
        ...signal.evidence.slice(0, 2).map((item) => item.excerptHash)
      ].join("|")
    ).slice(0, 16);
    const bucket = buckets.get(key) ?? [];
    bucket.push(signal);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()].map(([key, bucket]) => ({
    key,
    title: bucket[0]?.title ?? key,
    profileHint: bucket.find((item) => item.probableOwnerProfile)?.probableOwnerProfile,
    signalIds: bucket.map((item) => item.id),
    evidenceCount: bucket.reduce((total, item) => total + item.evidence.length, 0)
  }));
}
