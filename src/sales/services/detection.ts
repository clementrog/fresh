import { getISOWeek, getISOWeekYear, differenceInDays } from "date-fns";
import type { Logger } from "pino";
import type { SalesRepositoryBundle } from "../db/sales-repositories.js";
import { salesSignalDbId } from "../db/sales-repositories.js";
import { Prisma } from "@prisma/client";
import { createDeterministicId } from "../../lib/ids.js";
import type { ConfidenceLevel, SalesSignalType, SalesDoctrineConfig } from "../domain/types.js";

function toJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STALENESS_THRESHOLD_DAYS = 21;
const GOING_COLD_THRESHOLD_DAYS = 7;
const RECENT_ACTIVITY_WINDOW_DAYS = 14;
const MOMENTUM_WINDOW_DAYS = 30;
const NEGATIVE_MOMENTUM_THRESHOLD = 2;
const DEFAULT_INTELLIGENCE_STAGES = ["New", "Opportunity Validated"];

export const DETECTION_MANAGED_TYPES: SalesSignalType[] = [
  "competitor_mentioned",
  "blocker_identified",
  "next_step_missing",
  "urgent_timeline",
  "deal_stale",
  "deal_going_cold",
  "positive_momentum",
  "negative_momentum",
  "champion_identified",
  "budget_surfaced",
];

export const LEAD_MANAGED_TYPES: SalesSignalType[] = [
  "lead_engaged",
  "lead_ready_for_deal",
  "lead_re_engaged",
];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DetectionResult {
  signalsCreated: number;
  signalsRemoved: number;
  dealsScanned: number;
  dealsSkippedByStage: number;
  staleSignalsCleaned: number;
  leadSignalsCreated: number;
  leadOrphansCleaned: number;
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
  metadataJson?: Record<string, unknown>;
}

function buildIntelligenceStageIds(
  stageLabels: Record<string, string> | undefined,
  intelligenceStages: string[]
): Set<string> | null {
  if (!stageLabels || Object.keys(stageLabels).length === 0) return null;
  const ids = new Set<string>();
  for (const [id, label] of Object.entries(stageLabels)) {
    if (intelligenceStages.includes(label)) {
      ids.add(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Deal detection rules (consolidated)
// ---------------------------------------------------------------------------

interface DealContext {
  dealId: string;
  dealName: string;
  staleDays: number;
  lastActivityDate: Date | null;
  stageLabel: string | null;
  facts: Array<{
    id: string;
    category: string;
    label: string;
    extractedValue: string;
    confidence: number;
    createdAt: Date;
  }>;
}

function applyRules(ctx: DealContext, stalenessThreshold: number): SignalDraft[] {
  const signals: SignalDraft[] = [];
  const weekKey = isoWeekKey(ctx.lastActivityDate);
  const isNew = ctx.stageLabel === "New";

  // Filter facts within momentum window
  const recentFacts = ctx.lastActivityDate
    ? ctx.facts.filter((f) => {
        const daysDiff = differenceInDays(ctx.lastActivityDate!, f.createdAt);
        return daysDiff >= 0 && daysDiff <= MOMENTUM_WINDOW_DAYS;
      })
    : ctx.facts;

  // --- Consolidated: competitor_mentioned (one per deal) ---
  const competitors = ctx.facts
    .filter((f) => f.category === "competitor_reference")
    .map((f) => f.extractedValue);
  if (competitors.length > 0) {
    const unique = [...new Set(competitors)];
    signals.push({
      signalType: "competitor_mentioned",
      title: `Competitors: ${unique.join(", ")}`,
      description: `${unique.length} competitor(s) referenced in deal "${ctx.dealName}": ${unique.join(", ")}`,
      confidence: "high",
      dedupParts: [ctx.dealId, weekKey],
    });
  }

  // --- Consolidated: blocker_identified (one per deal) ---
  const blockers = ctx.facts
    .filter((f) => f.label.startsWith("blocker:"))
    .map((f) => f.extractedValue);
  if (blockers.length > 0) {
    signals.push({
      signalType: "blocker_identified",
      title: `${blockers.length} blocker(s) identified`,
      description: `Blockers in deal "${ctx.dealName}": ${blockers.join("; ")}`,
      confidence: "medium",
      dedupParts: [ctx.dealId, weekKey],
    });
  }

  // --- next_step_missing ---
  if (ctx.lastActivityDate) {
    const hasRecentFacts = ctx.facts.some((f) => {
      const daysDiff = differenceInDays(ctx.lastActivityDate!, f.createdAt);
      return daysDiff >= 0 && daysDiff <= RECENT_ACTIVITY_WINDOW_DAYS;
    });
    const hasNextStep = ctx.facts.some(
      (f) => f.category === "urgency_timing" && f.label === "next_step"
    );
    if (hasRecentFacts && !hasNextStep) {
      signals.push({
        signalType: "next_step_missing",
        title: "No next step defined",
        description: `Deal "${ctx.dealName}" has recent activity but no clear next step`,
        confidence: isNew ? "high" : "medium",
        dedupParts: [ctx.dealId, weekKey],
      });
    }
  }

  // --- urgent_timeline ---
  const hasHighUrgency = ctx.facts.some(
    (f) => f.category === "urgency_timing" && f.label === "urgency_level" && f.extractedValue === "high"
  );
  if (hasHighUrgency) {
    signals.push({
      signalType: "urgent_timeline",
      title: "Urgent timeline",
      description: `High urgency detected in deal "${ctx.dealName}"`,
      confidence: "high",
      dedupParts: [ctx.dealId, weekKey],
    });
  }

  // --- deal_going_cold (7–staleness threshold) ---
  if (ctx.staleDays >= GOING_COLD_THRESHOLD_DAYS && ctx.staleDays < stalenessThreshold) {
    signals.push({
      signalType: "deal_going_cold",
      title: `Deal cooling (${ctx.staleDays} days)`,
      description: `Deal "${ctx.dealName}" has had no activity for ${ctx.staleDays} days`,
      confidence: "medium",
      dedupParts: [ctx.dealId, weekKey],
    });
  }

  // --- deal_stale (staleness threshold+) ---
  if (ctx.staleDays >= stalenessThreshold) {
    signals.push({
      signalType: "deal_stale",
      title: `Deal stale (${ctx.staleDays} days)`,
      description: `Deal "${ctx.dealName}" has been inactive for ${ctx.staleDays} days`,
      confidence: "high",
      dedupParts: [ctx.dealId, weekKey],
    });
  }

  // --- Consolidated: champion_identified (one per deal) ---
  const champions = ctx.facts
    .filter((f) => f.category === "persona_stakeholder" && f.label === "champion")
    .map((f) => f.extractedValue);
  if (champions.length > 0) {
    signals.push({
      signalType: "champion_identified",
      title: `Champion: ${champions[0]}`,
      description: `Champion identified in deal "${ctx.dealName}": ${champions.join(", ")}`,
      confidence: "medium",
      dedupParts: [ctx.dealId, weekKey],
    });
  }

  // --- budget_surfaced (one per deal) ---
  const hasBudget = ctx.facts.some((f) => f.category === "budget_sensitivity");
  if (hasBudget) {
    signals.push({
      signalType: "budget_surfaced",
      title: "Budget discussed",
      description: `Budget mentioned in deal "${ctx.dealName}"`,
      confidence: "medium",
      dedupParts: [ctx.dealId, weekKey],
    });
  }

  // --- positive_momentum ---
  const hasChampion = champions.length > 0;
  const hasPositiveSentiment = recentFacts.some(
    (f) => f.category === "sentiment" && f.extractedValue === "positive"
  );
  const hasRecentBlockers = recentFacts.some((f) => f.label.startsWith("blocker:"));
  if ((hasChampion || hasPositiveSentiment) && !hasRecentBlockers) {
    signals.push({
      signalType: "positive_momentum",
      title: "Positive momentum",
      description: `Deal "${ctx.dealName}" shows positive signals`,
      confidence: "medium",
      dedupParts: [ctx.dealId, weekKey],
    });
  }

  // --- negative_momentum ---
  const recentBlockerCount = recentFacts.filter((f) => f.label.startsWith("blocker:")).length;
  const recentPainCount = recentFacts.filter((f) => f.label.startsWith("pain:")).length;
  const hasNegativeSentiment = recentFacts.some(
    (f) => f.category === "sentiment" && f.extractedValue === "negative"
  );
  if (hasNegativeSentiment || recentBlockerCount + recentPainCount >= NEGATIVE_MOMENTUM_THRESHOLD) {
    signals.push({
      signalType: "negative_momentum",
      title: "Negative momentum",
      description: `Deal "${ctx.dealName}" shows concerning signals`,
      confidence: "medium",
      dedupParts: [ctx.dealId, weekKey],
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Lead cursor helpers
// ---------------------------------------------------------------------------

function parseLeadCursor(raw: string | null): { timestamp: Date | null; status: string | null } {
  if (!raw) return { timestamp: null, status: null };
  const sep = raw.indexOf("|");
  if (sep === -1) return { timestamp: new Date(raw), status: null };
  return {
    timestamp: new Date(raw.slice(0, sep)),
    status: raw.slice(sep + 1) || null,
  };
}

function encodeLeadCursor(timestamp: Date | null, status: string): string {
  const ts = timestamp ? timestamp.toISOString() : "";
  return `${ts}|${status}`;
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
    dealsSkippedByStage: 0,
    staleSignalsCleaned: 0,
    leadSignalsCreated: 0,
    leadOrphansCleaned: 0,
    errors: [],
  };

  const runId = params.runId ?? createDeterministicId("run", [companyId, "sales:detect", Date.now().toString()]);

  // 1. Acquire lease
  await repos.acquireRunLease({ companyId, runType: "sales:detect", runId });
  let leaseLost = false;

  // 2. Load doctrine
  let stalenessThreshold = params.stalenessThresholdDays ?? DEFAULT_STALENESS_THRESHOLD_DAYS;
  let stageLabels: Record<string, string> | undefined;
  let intelligenceStages = DEFAULT_INTELLIGENCE_STAGES;

  try {
    const doctrine = await repos.getLatestDoctrine(companyId);
    if (doctrine?.doctrineJson) {
      const config = doctrine.doctrineJson as unknown as SalesDoctrineConfig;
      if (typeof config.stalenessThresholdDays === "number") {
        stalenessThreshold = config.stalenessThresholdDays;
      }
      stageLabels = config.stageLabels;
      if (Array.isArray(config.intelligenceStages) && config.intelligenceStages.length > 0) {
        intelligenceStages = config.intelligenceStages;
      }
    }
  } catch {
    logger.warn("Could not load doctrine — using defaults");
  }

  // Build stage filter
  const intelligenceStageIds = buildIntelligenceStageIds(stageLabels, intelligenceStages);
  if (!intelligenceStageIds) {
    logger.warn("No stage labels configured — run sales:resolve-stages. Processing all deals.");
  }

  try {
    // 3. List all deals
    const allDeals = await repos.listDeals(companyId, { take: 1000 });

    // Filter by stage
    const inScopeDeals = intelligenceStageIds
      ? allDeals.filter((d) => intelligenceStageIds.has(d.stage))
      : allDeals;
    result.dealsSkippedByStage = allDeals.length - inScopeDeals.length;

    if (intelligenceStageIds) {
      logger.info({
        total: allDeals.length,
        inScope: inScopeDeals.length,
        skipped: result.dealsSkippedByStage,
        stages: intelligenceStages,
      }, "Filtered deals by intelligence stages");
    }

    // 4. Process in-scope deals
    for (const deal of inScopeDeals) {
      const preDealOk = await renewLeaseOrAbort(repos, runId);
      if (!preDealOk) { leaseLost = true; break; }

      const stageLabel = stageLabels?.[deal.stage] ?? null;

      try {
        await repos.transaction(async (tx) => {
          const deleted = await repos.deleteDetectionSignalsForDeal(
            deal.id,
            DETECTION_MANAGED_TYPES as unknown as string[],
            tx
          );
          result.signalsRemoved += deleted.count;

          const facts = await repos.listExtractionsForDeal(deal.id);
          const ctx: DealContext = {
            dealId: deal.id,
            dealName: deal.dealName,
            staleDays: deal.staleDays,
            lastActivityDate: deal.lastActivityDate,
            stageLabel,
            facts: facts.map((f) => ({
              id: f.id, category: f.category, label: f.label,
              extractedValue: f.extractedValue, confidence: f.confidence,
              createdAt: f.createdAt,
            })),
          };

          const signalDrafts = applyRules(ctx, stalenessThreshold);
          const seen = new Set<string>();

          for (const draft of signalDrafts) {
            const signalId = salesSignalDbId(companyId, [draft.signalType, ...draft.dedupParts]);
            if (seen.has(signalId)) continue;
            seen.add(signalId);

            await tx.salesSignal.upsert({
              where: { id: signalId },
              create: {
                id: signalId, companyId, signalType: draft.signalType,
                title: draft.title, description: draft.description,
                dealId: deal.id, confidence: draft.confidence,
                metadataJson: toJson(draft.metadataJson ?? {}), detectedAt: new Date(),
              },
              update: {},
            });
            result.signalsCreated++;
          }
        });
        result.dealsScanned++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Error processing deal ${deal.id}: ${errMsg}`);
        logger.error({ dealId: deal.id, err: error }, "Detection error for deal");
        result.dealsScanned++;
      }

      const postDealOk = await renewLeaseOrAbort(repos, runId);
      if (!postDealOk) { leaseLost = true; break; }
    }

    // 5. Scope-contraction cleanup
    if (!leaseLost && intelligenceStageIds && intelligenceStageIds.size > 0) {
      try {
        const cleaned = await repos.deleteSignalsForOutOfScopeDeals(
          companyId,
          [...intelligenceStageIds],
          DETECTION_MANAGED_TYPES as unknown as string[]
        );
        result.staleSignalsCleaned = cleaned.count;
        if (cleaned.count > 0) {
          logger.info({ cleaned: cleaned.count }, "Cleaned stale signals from out-of-scope deals");
        }
      } catch (error) {
        logger.error({ err: error }, "Failed to clean out-of-scope signals");
      }
    }

    // 6. Lead detection
    if (!leaseLost) {
      await detectLeadSignals({
        companyId, repos, logger, runId, result,
        intelligenceStageIds, stageLabels,
      });
    }

    // 7. Finalize
    if (!leaseLost) {
      await repos.finalizeSyncRun(runId, "completed", {
        signalsCreated: result.signalsCreated,
        signalsRemoved: result.signalsRemoved,
        dealsScanned: result.dealsScanned,
        dealsSkippedByStage: result.dealsSkippedByStage,
        staleSignalsCleaned: result.staleSignalsCleaned,
        leadSignalsCreated: result.leadSignalsCreated,
        leadOrphansCleaned: result.leadOrphansCleaned,
      }, result.errors);
    }
  } catch (error) {
    if (!leaseLost) {
      try {
        await repos.finalizeSyncRun(runId, "failed", {}, [],
          error instanceof Error ? error.message : "Unknown error");
      } catch { /* best effort */ }
    }
    throw error;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Lead detection
// ---------------------------------------------------------------------------

async function detectLeadSignals(params: {
  companyId: string;
  repos: SalesRepositoryBundle;
  logger: Logger;
  runId: string;
  result: DetectionResult;
  intelligenceStageIds: Set<string> | null;
  stageLabels: Record<string, string> | undefined;
}): Promise<void> {
  const { companyId, repos, logger, runId, result, intelligenceStageIds, stageLabels } = params;

  const companies = await repos.listHubspotCompaniesWithLeadStatus(companyId);
  const processedCompanyIds: string[] = [];

  for (const company of companies) {
    const leaseOk = await renewLeaseOrAbort(repos, runId);
    if (!leaseOk) return;

    const props = company.propertiesJson as Record<string, unknown> | null;
    const leadStatus = (props?.hs_lead_status as string) || null;
    if (!leadStatus) continue;

    try {
      const cursorKey = `lead-detect:${company.id}`;
      const rawCursor = await repos.getCursor(companyId, cursorKey);
      const cursor = parseLeadCursor(rawCursor);

      // Get deals for this company
      const deals = await repos.listDealsByHubspotCompany(company.id);
      if (deals.length === 0) {
        processedCompanyIds.push(company.id);
        continue; // No deals → no activity data → skip
      }

      const dealIds = deals.map((d) => d.id);

      // Check for new activity since cursor
      const maxTimestamp = cursor.timestamp
        ? await repos.maxActivityTimestampForDeals(dealIds, cursor.timestamp)
        : await repos.maxActivityTimestampForDeals(dealIds);

      const hasNewActivity = !!maxTimestamp && (!cursor.timestamp || maxTimestamp > cursor.timestamp);
      const statusChanged = cursor.status !== null && cursor.status !== leadStatus;

      if (!hasNewActivity && !statusChanged) {
        // No action needed — existing signals persist
        processedCompanyIds.push(company.id);
        continue;
      }

      // Determine signal type
      const signalType = resolveLeadSignalType(leadStatus, deals, intelligenceStageIds);
      if (!signalType) {
        processedCompanyIds.push(company.id);
        continue;
      }

      // Count new activities for metadata
      let newActivityCount = 0;
      if (hasNewActivity && cursor.timestamp) {
        newActivityCount = await repos.countActivitiesForDealsSince(dealIds, cursor.timestamp);
      } else if (hasNewActivity) {
        newActivityCount = 1; // First run, at least one activity exists
      }

      const weekKey = isoWeekKey(maxTimestamp ?? cursor.timestamp);
      const signalId = salesSignalDbId(companyId, [signalType, company.id, weekKey]);

      // Atomic: delete old + create new + update cursor
      await repos.transaction(async (tx) => {
        // Delete existing lead signals for this company (handles status change)
        await repos.deleteLeadSignalsForCompany(
          company.id,
          LEAD_MANAGED_TYPES as unknown as string[],
          tx
        );

        // Create new signal
        await tx.salesSignal.upsert({
          where: { id: signalId },
          create: {
            id: signalId,
            companyId,
            signalType,
            title: formatLeadSignalTitle(signalType, company.name, leadStatus),
            description: formatLeadSignalDescription(signalType, company.name, leadStatus, newActivityCount),
            dealId: null,
            confidence: "medium",
            metadataJson: toJson({
              hubspotCompanyId: company.id,
              hubspotCompanyName: company.name,
              leadStatus,
              newActivityCount,
              newestActivityDate: maxTimestamp?.toISOString() ?? null,
            }),
            detectedAt: new Date(),
          },
          update: {},
        });

        // Update cursor (timestamp + status)
        const newTimestamp = hasNewActivity && maxTimestamp ? maxTimestamp : cursor.timestamp;
        const cursorValue = encodeLeadCursor(newTimestamp, leadStatus);
        const cursorId = createDeterministicId("cur", [companyId, cursorKey]);
        await tx.sourceCursor.upsert({
          where: { companyId_source: { companyId, source: cursorKey } },
          create: { id: cursorId, companyId, source: cursorKey, cursor: cursorValue },
          update: { cursor: cursorValue },
        });
      });

      result.leadSignalsCreated++;
      processedCompanyIds.push(company.id);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(`Lead detection error for company ${company.id}: ${errMsg}`);
      logger.error({ companyId: company.id, err: error }, "Lead detection error");
      processedCompanyIds.push(company.id); // Still count as processed to avoid orphan cleanup
    }
  }

  // Orphan cleanup
  try {
    const orphanResult = await repos.deleteOrphanedLeadSignals(
      companyId,
      processedCompanyIds,
      LEAD_MANAGED_TYPES as unknown as string[]
    );
    result.leadOrphansCleaned = orphanResult.count;
    if (orphanResult.count > 0) {
      logger.info({ cleaned: orphanResult.count, cursors: orphanResult.cursorsCleaned },
        "Cleaned orphaned lead signals");
    }
  } catch (error) {
    logger.error({ err: error }, "Failed to clean orphaned lead signals");
  }
}

function resolveLeadSignalType(
  leadStatus: string,
  deals: Array<{ stage: string }>,
  intelligenceStageIds: Set<string> | null
): SalesSignalType | null {
  const statusLower = leadStatus.toLowerCase();

  if (statusLower === "hunted") return "lead_engaged";

  if (statusLower === "qualified") {
    // Check if any deal is in a New+ stage
    const hasNewPlusDeal = intelligenceStageIds
      ? deals.some((d) => intelligenceStageIds.has(d.stage))
      : false;
    return hasNewPlusDeal ? null : "lead_ready_for_deal"; // Only fire if no deal in scope yet
  }

  if (statusLower === "nurture" || statusLower === "mauvais timing") return "lead_re_engaged";

  return null; // "Nouveau", "Hot", others → no lead signal
}

function formatLeadSignalTitle(signalType: SalesSignalType, companyName: string, _leadStatus: string): string {
  switch (signalType) {
    case "lead_engaged": return `Lead engaged: ${companyName}`;
    case "lead_ready_for_deal": return `Ready for deal: ${companyName}`;
    case "lead_re_engaged": return `Lead re-engaged: ${companyName}`;
    default: return `Lead signal: ${companyName}`;
  }
}

function formatLeadSignalDescription(
  signalType: SalesSignalType,
  companyName: string,
  leadStatus: string,
  activityCount: number
): string {
  const activityNote = activityCount > 0 ? ` (${activityCount} new activity/ies)` : "";
  switch (signalType) {
    case "lead_engaged":
      return `Company "${companyName}" (status: ${leadStatus}) shows engagement${activityNote}`;
    case "lead_ready_for_deal":
      return `Company "${companyName}" (status: ${leadStatus}) is qualified with activity but no deal in pipeline${activityNote}`;
    case "lead_re_engaged":
      return `Company "${companyName}" (status: ${leadStatus}) shows renewed engagement${activityNote}`;
    default:
      return `Lead signal for "${companyName}" (status: ${leadStatus})${activityNote}`;
  }
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
