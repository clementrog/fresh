import { getISOWeek, getISOWeekYear, differenceInDays } from "date-fns";
import type { Logger } from "pino";
import type { SalesRepositoryBundle } from "../db/sales-repositories.js";
import { salesSignalDbId } from "../db/sales-repositories.js";
import { createDeterministicId } from "../../lib/ids.js";
import type { ConfidenceLevel, SalesSignalType } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STALENESS_THRESHOLD_DAYS = 21;
const RECENT_ACTIVITY_WINDOW_DAYS = 14;
const MOMENTUM_WINDOW_DAYS = 30;
const NEGATIVE_MOMENTUM_THRESHOLD = 2; // min blockers/pain points for negative momentum

export const DETECTION_MANAGED_TYPES: SalesSignalType[] = [
  "competitor_mentioned",
  "blocker_identified",
  "next_step_missing",
  "urgent_timeline",
  "deal_stale",
  "positive_momentum",
  "negative_momentum",
  "champion_identified",
  "budget_surfaced",
];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DetectionResult {
  signalsCreated: number;
  signalsRemoved: number;
  dealsScanned: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoWeekKey(date: Date | null): string {
  if (!date) return "unknown";
  const year = getISOWeekYear(date);
  const week = getISOWeek(date);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

interface SignalDraft {
  signalType: SalesSignalType;
  title: string;
  description: string;
  confidence: ConfidenceLevel;
  dedupParts: string[];
}

// ---------------------------------------------------------------------------
// Detection rules
// ---------------------------------------------------------------------------

interface DealContext {
  dealId: string;
  dealName: string;
  staleDays: number;
  lastActivityDate: Date | null;
  facts: Array<{
    id: string;
    category: string;
    label: string;
    extractedValue: string;
    confidence: number;
    createdAt: Date;
  }>;
}

function applyRules(
  ctx: DealContext,
  stalenessThreshold: number
): SignalDraft[] {
  const signals: SignalDraft[] = [];
  const weekKey = isoWeekKey(ctx.lastActivityDate);

  // Filter facts within momentum window (relative to deal.lastActivityDate, not wall clock)
  const recentFacts = ctx.lastActivityDate
    ? ctx.facts.filter((f) => {
        const daysDiff = differenceInDays(ctx.lastActivityDate!, f.createdAt);
        return daysDiff >= 0 && daysDiff <= MOMENTUM_WINDOW_DAYS;
      })
    : ctx.facts;

  // competitor_mentioned
  for (const fact of ctx.facts) {
    if (fact.category === "competitor_reference") {
      signals.push({
        signalType: "competitor_mentioned",
        title: `Competitor mentioned: ${fact.extractedValue}`,
        description: `Competitor "${fact.extractedValue}" referenced in deal "${ctx.dealName}"`,
        confidence: "high",
        dedupParts: [ctx.dealId, fact.label],
      });
    }
  }

  // blocker_identified
  for (const fact of ctx.facts) {
    if (fact.label.startsWith("blocker:")) {
      signals.push({
        signalType: "blocker_identified",
        title: `Blocker: ${fact.extractedValue}`,
        description: `Blocker identified in deal "${ctx.dealName}": ${fact.extractedValue}`,
        confidence: "medium",
        dedupParts: [ctx.dealId, fact.label],
      });
    }
  }

  // next_step_missing
  if (ctx.lastActivityDate) {
    const hasRecentActivity = ctx.facts.length > 0 &&
      ctx.facts.some((f) => {
        const daysDiff = differenceInDays(ctx.lastActivityDate!, f.createdAt);
        return daysDiff >= 0 && daysDiff <= RECENT_ACTIVITY_WINDOW_DAYS;
      });
    const hasNextStep = ctx.facts.some(
      (f) => f.category === "urgency_timing" && f.label === "next_step"
    );
    if (hasRecentActivity && !hasNextStep) {
      signals.push({
        signalType: "next_step_missing",
        title: `No next step defined`,
        description: `Deal "${ctx.dealName}" has recent activity but no clear next step`,
        confidence: "medium",
        dedupParts: [ctx.dealId, weekKey],
      });
    }
  }

  // urgent_timeline
  for (const fact of ctx.facts) {
    if (fact.category === "urgency_timing" && fact.label === "urgency_level" && fact.extractedValue === "high") {
      signals.push({
        signalType: "urgent_timeline",
        title: `Urgent timeline`,
        description: `High urgency detected in deal "${ctx.dealName}"`,
        confidence: "high",
        dedupParts: [ctx.dealId, fact.id],
      });
    }
  }

  // deal_stale
  if (ctx.staleDays >= stalenessThreshold) {
    signals.push({
      signalType: "deal_stale",
      title: `Deal stale (${ctx.staleDays} days)`,
      description: `Deal "${ctx.dealName}" has been inactive for ${ctx.staleDays} days`,
      confidence: "high",
      dedupParts: [ctx.dealId, weekKey],
    });
  }

  // champion_identified
  for (const fact of ctx.facts) {
    if (fact.category === "persona_stakeholder" && fact.label === "champion") {
      signals.push({
        signalType: "champion_identified",
        title: `Champion: ${fact.extractedValue}`,
        description: `Champion identified in deal "${ctx.dealName}": ${fact.extractedValue}`,
        confidence: "medium",
        dedupParts: [ctx.dealId, fact.label],
      });
    }
  }

  // budget_surfaced
  const hasBudget = ctx.facts.some((f) => f.category === "budget_sensitivity");
  if (hasBudget) {
    signals.push({
      signalType: "budget_surfaced",
      title: `Budget discussed`,
      description: `Budget mentioned in deal "${ctx.dealName}"`,
      confidence: "medium",
      dedupParts: [ctx.dealId],
    });
  }

  // positive_momentum
  const hasChampion = ctx.facts.some(
    (f) => f.category === "persona_stakeholder" && f.label === "champion"
  );
  const hasPositiveSentiment = recentFacts.some(
    (f) => f.category === "sentiment" && f.extractedValue === "positive"
  );
  const hasRecentBlockers = recentFacts.some((f) => f.label.startsWith("blocker:"));
  if ((hasChampion || hasPositiveSentiment) && !hasRecentBlockers) {
    signals.push({
      signalType: "positive_momentum",
      title: `Positive momentum`,
      description: `Deal "${ctx.dealName}" shows positive signals`,
      confidence: "medium",
      dedupParts: [ctx.dealId, weekKey],
    });
  }

  // negative_momentum
  const recentBlockerCount = recentFacts.filter((f) => f.label.startsWith("blocker:")).length;
  const recentPainCount = recentFacts.filter((f) => f.label.startsWith("pain:")).length;
  const hasNegativeSentiment = recentFacts.some(
    (f) => f.category === "sentiment" && f.extractedValue === "negative"
  );
  if (
    hasNegativeSentiment ||
    recentBlockerCount + recentPainCount >= NEGATIVE_MOMENTUM_THRESHOLD
  ) {
    signals.push({
      signalType: "negative_momentum",
      title: `Negative momentum`,
      description: `Deal "${ctx.dealName}" shows concerning signals`,
      confidence: "medium",
      dedupParts: [ctx.dealId, weekKey],
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Main detection function
// ---------------------------------------------------------------------------

export async function runDetection(params: {
  companyId: string;
  repos: SalesRepositoryBundle;
  logger: Logger;
  stalenessThresholdDays?: number;
  runId?: string;
}): Promise<DetectionResult> {
  const { companyId, repos, logger } = params;

  const result: DetectionResult = {
    signalsCreated: 0,
    signalsRemoved: 0,
    dealsScanned: 0,
    errors: [],
  };

  const runId = params.runId ?? createDeterministicId("run", [companyId, "sales:detect", Date.now().toString()]);

  // 1. Acquire lease
  await repos.acquireRunLease({ companyId, runType: "sales:detect", runId });

  let leaseLost = false;

  // 2. Load doctrine for staleness threshold
  let stalenessThreshold = params.stalenessThresholdDays ?? DEFAULT_STALENESS_THRESHOLD_DAYS;
  try {
    const doctrine = await repos.getLatestDoctrine(companyId);
    if (doctrine?.doctrineJson) {
      const config = doctrine.doctrineJson as { stalenessThresholdDays?: number };
      if (typeof config.stalenessThresholdDays === "number") {
        stalenessThreshold = config.stalenessThresholdDays;
      }
    }
  } catch {
    logger.warn("Could not load doctrine — using default staleness threshold");
  }

  try {
    // 3. List all deals
    const deals = await repos.listDeals(companyId, { take: 1000 });

    // 4. Process each deal
    for (const deal of deals) {
      // PRE-DEAL checkpoint
      const preDealOk = await renewLeaseOrAbort(repos, runId);
      if (!preDealOk) {
        leaseLost = true;
        logger.warn({ runId }, "Lease lost at pre-deal checkpoint — aborting");
        break;
      }

      try {
        await repos.transaction(async (tx) => {
          // Delete existing detection-managed signals for this deal
          const deleted = await repos.deleteDetectionSignalsForDeal(
            deal.id,
            DETECTION_MANAGED_TYPES as unknown as string[],
            tx
          );
          result.signalsRemoved += deleted.count;

          // Load facts for this deal
          const facts = await repos.listExtractionsForDeal(deal.id);

          // Build context
          const ctx: DealContext = {
            dealId: deal.id,
            dealName: deal.dealName,
            staleDays: deal.staleDays,
            lastActivityDate: deal.lastActivityDate,
            facts: facts.map((f) => ({
              id: f.id,
              category: f.category,
              label: f.label,
              extractedValue: f.extractedValue,
              confidence: f.confidence,
              createdAt: f.createdAt,
            })),
          };

          // Apply rules
          const signalDrafts = applyRules(ctx, stalenessThreshold);

          // Create signals
          for (const draft of signalDrafts) {
            const signalId = salesSignalDbId(companyId, [draft.signalType, ...draft.dedupParts]);
            await tx.salesSignal.create({
              data: {
                id: signalId,
                companyId,
                signalType: draft.signalType,
                title: draft.title,
                description: draft.description,
                dealId: deal.id,
                confidence: draft.confidence,
                metadataJson: {},
                detectedAt: new Date(),
              },
            });
            result.signalsCreated++;
          }
        });

        result.dealsScanned++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Error processing deal ${deal.id}: ${errMsg}`);
        logger.error({ dealId: deal.id, error }, "Detection error for deal");
        result.dealsScanned++;
      }

      // POST-DEAL checkpoint
      const postDealOk = await renewLeaseOrAbort(repos, runId);
      if (!postDealOk) {
        leaseLost = true;
        logger.warn({ runId }, "Lease lost at post-deal checkpoint — stopping");
        break;
      }
    }

    // Finalize
    if (!leaseLost) {
      await repos.finalizeSyncRun(
        runId,
        "completed",
        {
          signalsCreated: result.signalsCreated,
          signalsRemoved: result.signalsRemoved,
          dealsScanned: result.dealsScanned,
        },
        result.errors
      );
    }
  } catch (error) {
    if (!leaseLost) {
      try {
        await repos.finalizeSyncRun(runId, "failed", {}, [],
          error instanceof Error ? error.message : "Unknown error");
      } catch {
        // Best effort
      }
    }
    throw error;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Lease helper
// ---------------------------------------------------------------------------

async function renewLeaseOrAbort(repos: SalesRepositoryBundle, runId: string): Promise<boolean> {
  try {
    return await repos.renewLease(runId);
  } catch {
    return false;
  }
}
