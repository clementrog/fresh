import type { CostLedgerEntry, SyncRun, SyncRunCounters } from "../domain/types.js";
import { createId } from "../lib/ids.js";

export function createRun(runType: SyncRun["runType"], source?: SyncRun["source"]): SyncRun {
  return {
    id: createId("run"),
    runType,
    source,
    status: "running",
    startedAt: new Date().toISOString(),
    counters: emptyCounters(),
    warnings: [],
    notionPageFingerprint: `${runType}:${new Date().toISOString()}`
  };
}

export function emptyCounters(): SyncRunCounters {
  return {
    fetched: 0,
    normalized: 0,
    sensitivityBlocked: 0,
    signalsCreated: 0,
    opportunitiesCreated: 0,
    draftsCreated: 0,
    llmFallbacks: 0,
    llmValidationFailures: 0,
    notionCreates: 0,
    notionUpdates: 0
  };
}

export function addCounters(base: SyncRunCounters, delta: Partial<SyncRunCounters>) {
  return {
    fetched: base.fetched + (delta.fetched ?? 0),
    normalized: base.normalized + (delta.normalized ?? 0),
    sensitivityBlocked: base.sensitivityBlocked + (delta.sensitivityBlocked ?? 0),
    signalsCreated: base.signalsCreated + (delta.signalsCreated ?? 0),
    opportunitiesCreated: base.opportunitiesCreated + (delta.opportunitiesCreated ?? 0),
    draftsCreated: base.draftsCreated + (delta.draftsCreated ?? 0),
    llmFallbacks: base.llmFallbacks + (delta.llmFallbacks ?? 0),
    llmValidationFailures: base.llmValidationFailures + (delta.llmValidationFailures ?? 0),
    notionCreates: base.notionCreates + (delta.notionCreates ?? 0),
    notionUpdates: base.notionUpdates + (delta.notionUpdates ?? 0)
  };
}

export function finalizeRun(run: SyncRun, status: SyncRun["status"], notes?: string) {
  return {
    ...run,
    status,
    finishedAt: new Date().toISOString(),
    notes
  } satisfies SyncRun;
}

export function createCostEntry(params: Omit<CostLedgerEntry, "id" | "createdAt">): CostLedgerEntry {
  return {
    id: createId("cost"),
    createdAt: new Date().toISOString(),
    ...params
  };
}

export function buildSpikeWarnings(counters: SyncRunCounters): string[] {
  const warnings: string[] = [];
  if (counters.fetched > 250) warnings.push("High fetched volume");
  if (counters.sensitivityBlocked > 25) warnings.push("High sensitivity block count");
  if (counters.draftsCreated > 5) warnings.push("High draft count");
  if (counters.llmFallbacks > 5) warnings.push("High LLM fallback count");
  return warnings;
}
