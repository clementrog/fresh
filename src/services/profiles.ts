import type { ProfileBase, ProfileLearnedLayer, ProfileSnapshot } from "../domain/types.js";

export function buildDailyLearnedLayer(
  base: ProfileBase,
  recentExcerpts: string[],
  previous?: ProfileLearnedLayer
): ProfileLearnedLayer {
  const recurringPhrases = collectTopPhrases(recentExcerpts);
  return {
    profileId: base.profileId,
    recurringPhrases,
    structuralPatterns: deriveStructuralPatterns(recentExcerpts),
    evidenceExcerptIds: previous?.evidenceExcerptIds ?? [],
    lastIncrementalUpdateAt: new Date().toISOString(),
    lastWeeklyRecomputeAt: previous?.lastWeeklyRecomputeAt
  };
}

export function buildWeeklyLearnedLayer(base: ProfileBase, historicalExcerpts: string[]): ProfileLearnedLayer {
  return {
    profileId: base.profileId,
    recurringPhrases: collectTopPhrases(historicalExcerpts),
    structuralPatterns: deriveStructuralPatterns(historicalExcerpts),
    evidenceExcerptIds: [],
    lastIncrementalUpdateAt: new Date().toISOString(),
    lastWeeklyRecomputeAt: new Date().toISOString()
  };
}

export function mergeProfileSnapshot(base: ProfileBase, learned: ProfileLearnedLayer): ProfileSnapshot {
  return {
    profileId: base.profileId,
    toneSummary: base.toneSummary,
    preferredStructure: learned.structuralPatterns.join(" | ") || base.preferredStructure,
    recurringPhrases: [...new Set([...base.typicalPhrases, ...learned.recurringPhrases])],
    avoidRules: base.avoidRules,
    contentTerritories: base.contentTerritories,
    weakFitTerritories: base.weakFitTerritories,
    sampleExcerpts: base.sampleExcerpts.slice(0, 5),
    baseSource: base.sourcePath,
    learnedExcerptCount: learned.evidenceExcerptIds.length,
    weeklyRecomputedAt: learned.lastWeeklyRecomputeAt,
    notionPageId: base.notionPageId,
    notionPageFingerprint: base.notionPageFingerprint
  };
}

function collectTopPhrases(excerpts: string[]) {
  const counts = new Map<string, number>();
  for (const excerpt of excerpts) {
    const phrases = excerpt
      .split(/[.!?]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 20 && item.length < 120);
    for (const phrase of phrases) {
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([phrase]) => phrase);
}

function deriveStructuralPatterns(excerpts: string[]) {
  if (excerpts.some((excerpt) => excerpt.includes("?"))) {
    return ["Opens with a question", "Transitions into a concrete explanation"];
  }

  if (excerpts.some((excerpt) => excerpt.includes(":"))) {
    return ["Uses labeled sections", "Explains with explicit takeaways"];
  }

  return ["Starts from a concrete observation", "Moves toward a practical lesson"];
}
