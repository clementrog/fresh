import type { PrismaClient } from "@prisma/client";
import { Client } from "@hubspot/api-client";
import type { AppEnv } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { LlmClient } from "../services/llm.js";
import { SalesRepositoryBundle } from "./db/sales-repositories.js";
import { createHubSpotApiAdapter, HubSpotSyncService, runPreflight, fetchPipelineStageMap } from "./connectors/hubspot.js";
import type { SyncResult, PreflightResult } from "./connectors/hubspot.js";
import type { SalesDoctrineConfig } from "./domain/types.js";
import { runExtraction } from "./services/extraction.js";
import type { ExtractionResult } from "./services/extraction.js";
import { runDetection } from "./services/detection.js";
import type { DetectionResult } from "./services/detection.js";

export interface ConfigCheckResult {
  ok: boolean;
  details: Record<string, string>;
}

/**
 * Pipeline status counters returned by `sales:status`.
 *
 * When doctrine defines intelligence stages (stageLabels + intelligenceStages),
 * **all counters are scoped to in-scope deals only**: activities linked to those
 * deals, facts extracted from those activities, and signals generated for those
 * deals.  This matches the scope that `sales:extract` and `sales:detect` operate
 * on, so the reported processing rate reflects the actual extraction backlog.
 *
 * When no doctrine or stageLabels are configured, counters fall back to
 * whole-company (unscoped) totals.
 */
export interface StatusResult {
  totalActivities: number;
  processedActivities: number;
  unprocessedActivities: number;
  /** Percentage (0–100) of in-scope activities that have been extracted. */
  processingRate: number;
  totalDeals: number;
  /** Facts attached to in-scope deals (not whole-company). */
  totalFacts: number;
  /** Signals attached to in-scope deals (not whole-company). */
  totalSignals: number;
}

export interface DiagnosticsResult {
  /** In-scope buckets (scoped to intelligence-stage deals) */
  nullBody: number;
  cleaned: number;
  exhaustedOrphan: number;
  retryPending: number;
  pendingFirstAttempt: number;
  permanentlyUnreachable: number;
  actionable: number;
  /** Out-of-scope: activities with no deal (company-wide, cannot be stage-scoped) */
  noDeal: number;
  /** Adjusted coverage (unvalidated — requires operator spot-check of excluded items) */
  adjustedTotal: number;
  adjustedProcessingRate: number;
}

export interface CleanupOrphansResult {
  /** Total HubSpot fact-backed SourceItems found for this company. */
  scanned: number;
  /** Items whose backing SalesExtractedFact no longer exists. */
  orphaned: number;
  /** Items actually deleted (0 in dry-run). */
  deleted: number;
  dryRun: boolean;
  /** EvidenceReference rows that would be / were CASCADE deleted. */
  cascadeEvidenceReferences: number;
  /** SalesSignal rows that would have / had sourceItemId SET NULL. */
  nulledSignalLinks: number;
}

/**
 * SalesApp — top-level orchestrator for Fresh Sales.
 *
 * `checkConfig()` validates that the env/config prerequisites for Sales are
 * present and minimally valid. It does NOT call external services (HubSpot API,
 * LLM providers).
 *
 * `runSync()` pulls CRM data from HubSpot into the Sales tables. It validates
 * only what sync needs (HUBSPOT_ACCESS_TOKEN) — it does NOT require LLM keys.
 */
export class SalesApp {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: AppEnv
  ) {}

  async checkConfig(): Promise<ConfigCheckResult> {
    const details: Record<string, string> = {};

    // 1. Database connectivity
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      details.database = "ok";
    } catch {
      details.database = "unreachable";
      return { ok: false, details };
    }

    // 2. Verify Sales tables exist (SalesDeal as canary)
    try {
      await this.prisma.$queryRaw`SELECT 1 FROM "SalesDeal" LIMIT 0`;
      details.schema = "ok";
    } catch {
      details.schema = "Sales tables missing — run prisma migrate deploy";
      return { ok: false, details };
    }

    // 3. HubSpot token present (not validated against API — that is preflight)
    if (!this.env.HUBSPOT_ACCESS_TOKEN) {
      details.hubspot = "HUBSPOT_ACCESS_TOKEN not set";
      return { ok: false, details };
    }
    details.hubspot = "token present (not validated — use sales:preflight)";

    // 4. LLM API key present for configured provider
    const llmProvider = this.env.SALES_LLM_PROVIDER ?? "anthropic";
    const keyPresent = llmProvider === "anthropic"
      ? !!this.env.ANTHROPIC_API_KEY
      : !!this.env.OPENAI_API_KEY;
    if (!keyPresent) {
      details.llm = `${llmProvider} API key not set`;
      return { ok: false, details };
    }
    details.llm = `${llmProvider} key present`;

    return { ok: true, details };
  }

  async runPreflight(companyId: string): Promise<PreflightResult> {
    if (!this.env.HUBSPOT_ACCESS_TOKEN) {
      return {
        ok: false,
        verified: false,
        checks: [{
          name: "auth",
          status: "fail",
          message: "HUBSPOT_ACCESS_TOKEN is not configured",
          errorClass: "auth_invalid",
          durationMs: 0,
        }],
        summary: "1 failed",
      };
    }

    const logger = createLogger(this.env);
    const repos = new SalesRepositoryBundle(this.prisma);
    const client = new Client({ accessToken: this.env.HUBSPOT_ACCESS_TOKEN });
    const api = createHubSpotApiAdapter(client);

    return runPreflight({ api, client, repos, companyId, logger });
  }

  async runSync(companyId: string): Promise<SyncResult> {
    if (!this.env.HUBSPOT_ACCESS_TOKEN) {
      throw new Error("HUBSPOT_ACCESS_TOKEN is not configured");
    }

    const logger = createLogger(this.env);
    const repos = new SalesRepositoryBundle(this.prisma);
    const client = new Client({ accessToken: this.env.HUBSPOT_ACCESS_TOKEN });
    const api = createHubSpotApiAdapter(client);
    const service = new HubSpotSyncService(api, repos, logger);

    const result = await service.runSync(companyId);

    logger.info(
      {
        deals: result.counters.deals,
        contacts: result.counters.contacts,
        companies: result.counters.companies,
        activities: result.counters.activities,
        associations: result.counters.associations,
        warnings: result.warnings.length,
      },
      "HubSpot sync completed"
    );

    return result;
  }

  async runExtract(
    companyId: string,
    opts?: { reprocess?: boolean; batchSize?: number; drain?: boolean; activityIds?: string[] },
  ): Promise<ExtractionResult & { stopReason?: DrainStopReason; iterations?: number }> {
    const logger = createLogger(this.env);
    const repos = new SalesRepositoryBundle(this.prisma);

    if (opts?.activityIds && (opts.reprocess || opts.drain)) {
      throw new Error("--activity-ids cannot be combined with --reprocess or --drain");
    }

    if (opts?.reprocess) {
      const reset = await repos.resetExtractions(companyId);
      logger.info({ count: reset.count }, "Reset extractions for reprocessing");
    }

    const llmClient = new LlmClient(this.env, logger);
    const provider = this.env.SALES_LLM_PROVIDER ?? "openai";
    const model = this.env.SALES_LLM_MODEL ?? "gpt-5.4-nano";
    const batchSize = opts?.batchSize ?? (opts?.drain ? 200 : undefined);

    if (opts?.activityIds) {
      return runExtraction({ companyId, repos, llmClient, logger, provider, model, activityIds: opts.activityIds });
    }

    if (!opts?.drain) {
      return runExtraction({ companyId, repos, llmClient, logger, provider, model, batchSize });
    }

    // Drain mode: loop until queue is empty or a safety cap is hit
    const startTime = Date.now();
    const aggregate = emptyExtractionResult();
    let consecutiveStalls = 0;
    let rateLimitRetried = false;
    let stopReason: DrainStopReason = "iteration_cap"; // default if loop exhausts naturally
    let iterations = 0;

    for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
      if (Date.now() - startTime > MAX_DRAIN_DURATION_MS) {
        stopReason = "time_cap";
        logger.warn("Drain hit time cap — stopping");
        break;
      }

      const result = await runExtraction({ companyId, repos, llmClient, logger, provider, model, batchSize });
      mergeExtractionResults(aggregate, result);
      iterations++;

      // Items that permanently left the unextracted queue this iteration
      const itemsDrained = result.activitiesProcessed + result.activitiesSkipped
        + result.stageSkipped + result.exhaustedItems;

      // Empty queue: nothing handled, no retryable errors, and not rate-limited
      if (itemsDrained === 0 && result.retryableErrors === 0 && !result.rateLimited) {
        stopReason = "queue_empty";
        logger.info("Drain complete — no more unextracted activities");
        break;
      }

      // Rate-limit backoff (checked before stall counter so rate-limited
      // iterations with zero drain are classified as rate_limited, not stalled)
      if (result.rateLimited) {
        if (rateLimitRetried) {
          stopReason = "rate_limited";
          logger.warn("Rate limited twice — stopping drain");
          break;
        }
        rateLimitRetried = true;
        logger.info(`Rate limited — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s`);
        await sleep(RATE_LIMIT_BACKOFF_MS);
        continue;
      }
      rateLimitRetried = false;

      // Backlog-reduction safeguard (only reached for non-rate-limited iterations)
      if (itemsDrained === 0) {
        consecutiveStalls++;
        if (consecutiveStalls >= MAX_STALL_ITERATIONS) {
          stopReason = "stalled";
          logger.warn({ consecutiveStalls }, "Drain stalled — no backlog reduction, stopping");
          break;
        }
      } else {
        consecutiveStalls = 0;
      }
    }

    logger.info({ stopReason, iterations, processed: aggregate.activitiesProcessed,
      skipped: aggregate.activitiesSkipped, facts: aggregate.factsCreated,
      exhausted: aggregate.exhaustedItems, costUsd: aggregate.costUsd,
    }, "Drain completed");

    return { ...aggregate, stopReason, iterations };
  }

  async runDetect(companyId: string): Promise<DetectionResult> {
    const logger = createLogger(this.env);
    const repos = new SalesRepositoryBundle(this.prisma);
    return runDetection({ companyId, repos, logger });
  }

  async runStatus(companyId: string): Promise<StatusResult> {
    const repos = new SalesRepositoryBundle(this.prisma);

    // Load doctrine to scope status to intelligence stages (same as extraction)
    let intelligenceStageIds: string[] | undefined;
    try {
      const doctrine = await repos.getLatestDoctrine(companyId);
      if (doctrine?.doctrineJson) {
        const config = doctrine.doctrineJson as unknown as SalesDoctrineConfig;
        const stageLabels = config.stageLabels;
        const intelligenceStages = config.intelligenceStages ?? ["New", "Opportunity Validated"];
        if (stageLabels && Object.keys(stageLabels).length > 0) {
          intelligenceStageIds = Object.entries(stageLabels)
            .filter(([, label]) => intelligenceStages.includes(label))
            .map(([id]) => id);
        }
      }
    } catch {
      // Fall back to unscoped status
    }

    return repos.getExtractionStatus(companyId, intelligenceStageIds);
  }

  async runDiagnostics(companyId: string): Promise<DiagnosticsResult> {
    const repos = new SalesRepositoryBundle(this.prisma);

    let intelligenceStageIds: string[] | undefined;
    try {
      const doctrine = await repos.getLatestDoctrine(companyId);
      if (doctrine?.doctrineJson) {
        const config = doctrine.doctrineJson as unknown as SalesDoctrineConfig;
        const stageLabels = config.stageLabels;
        const intelligenceStages = config.intelligenceStages ?? ["New", "Opportunity Validated"];
        if (stageLabels && Object.keys(stageLabels).length > 0) {
          intelligenceStageIds = Object.entries(stageLabels)
            .filter(([, label]) => intelligenceStages.includes(label))
            .map(([id]) => id);
        }
      }
    } catch {
      // Fall back to unscoped diagnostics
    }

    const [diag, status] = await Promise.all([
      repos.getExtractionDiagnostics(companyId, intelligenceStageIds),
      repos.getExtractionStatus(companyId, intelligenceStageIds),
    ]);

    const adjustedTotal = status.totalActivities - diag.permanentlyUnreachable;
    const adjustedProcessingRate = adjustedTotal > 0
      ? Math.round((status.processedActivities / adjustedTotal) * 1000) / 10
      : 0;

    return { ...diag, adjustedTotal, adjustedProcessingRate };
  }

  async runCleanupOrphans(
    companyId: string,
    opts: { commit: boolean; force?: boolean },
  ): Promise<CleanupOrphansResult> {
    const FACT_PREFIX = "hubspot-fact:";
    const BATCH_SIZE = 200;
    const SAFETY_THRESHOLD = 500;

    // --- Scan phase (outside transaction) ---
    const hubspotItems = await this.prisma.sourceItem.findMany({
      where: { companyId, source: "hubspot", sourceItemId: { startsWith: FACT_PREFIX } },
      select: { id: true, sourceItemId: true },
    });

    if (hubspotItems.length === 0) {
      return { scanned: 0, orphaned: 0, deleted: 0, dryRun: !opts.commit,
               cascadeEvidenceReferences: 0, nulledSignalLinks: 0 };
    }

    // Parse factId from each sourceItemId
    const itemsByFactId = new Map<string, string>(); // factId → SourceItem.id
    const emptyFactItemIds: string[] = [];
    for (const item of hubspotItems) {
      const factId = item.sourceItemId.slice(FACT_PREFIX.length);
      if (factId) {
        itemsByFactId.set(factId, item.id);
      } else {
        emptyFactItemIds.push(item.id);
      }
    }

    // Check which facts still exist
    const existingFacts = await this.prisma.salesExtractedFact.findMany({
      where: { id: { in: [...itemsByFactId.keys()] } },
      select: { id: true },
    });
    const existingIds = new Set(existingFacts.map(f => f.id));

    const orphanIds = [
      ...emptyFactItemIds,
      ...[...itemsByFactId.entries()]
        .filter(([factId]) => !existingIds.has(factId))
        .map(([, siId]) => siId),
    ];

    // Safety threshold (checked before blast-radius to avoid unnecessary queries)
    if (opts.commit && orphanIds.length > SAFETY_THRESHOLD && !opts.force) {
      throw new Error(
        `Orphan count (${orphanIds.length}) exceeds safety threshold (${SAFETY_THRESHOLD}). ` +
        `Pass --force to proceed.`,
      );
    }

    // --- Dry-run: compute scan-phase estimates and return ---
    if (!opts.commit) {
      const [estEvidence, estSignals] = orphanIds.length > 0
        ? await Promise.all([
            this.prisma.evidenceReference.count({ where: { sourceItemId: { in: orphanIds } } }),
            this.prisma.salesSignal.count({ where: { sourceItemId: { in: orphanIds } } }),
          ])
        : [0, 0];
      return {
        scanned: hubspotItems.length, orphaned: orphanIds.length, deleted: 0,
        dryRun: true, cascadeEvidenceReferences: estEvidence, nulledSignalLinks: estSignals,
      };
    }

    // --- Commit phase (inside transaction: re-validate → count dependents → delete) ---
    if (orphanIds.length === 0) {
      return { scanned: hubspotItems.length, orphaned: 0, deleted: 0,
               dryRun: false, cascadeEvidenceReferences: 0, nulledSignalLinks: 0 };
    }

    const txResult = await this.prisma.$transaction(async (tx) => {
      // Pass 1: re-validate all batches, collect still-orphaned IDs
      const stillOrphanedIds: string[] = [];

      for (let i = 0; i < orphanIds.length; i += BATCH_SIZE) {
        const batch = orphanIds.slice(i, i + BATCH_SIZE);

        const candidates = await tx.sourceItem.findMany({
          where: { id: { in: batch } },
          select: { id: true, sourceItemId: true },
        });

        const candidateFactIds = candidates
          .map(c => c.sourceItemId.slice(FACT_PREFIX.length))
          .filter(Boolean);

        const nowExisting = candidateFactIds.length > 0
          ? await tx.salesExtractedFact.findMany({
              where: { id: { in: candidateFactIds } },
              select: { id: true },
            })
          : [];
        const nowExistingSet = new Set(nowExisting.map(f => f.id));

        for (const c of candidates) {
          const factId = c.sourceItemId.slice(FACT_PREFIX.length);
          if (!factId || !nowExistingSet.has(factId)) {
            stillOrphanedIds.push(c.id);
          }
        }
      }

      if (stillOrphanedIds.length === 0) {
        return { orphaned: 0, deleted: 0, evidenceRefs: 0, signalLinks: 0 };
      }

      // Pass 2: count dependents BEFORE deletion (accurate blast radius)
      const [evidenceRefs, signalLinks] = await Promise.all([
        tx.evidenceReference.count({ where: { sourceItemId: { in: stillOrphanedIds } } }),
        tx.salesSignal.count({ where: { sourceItemId: { in: stillOrphanedIds } } }),
      ]);

      // Pass 3: delete in batches
      let totalDeleted = 0;
      for (let i = 0; i < stillOrphanedIds.length; i += BATCH_SIZE) {
        const deleteBatch = stillOrphanedIds.slice(i, i + BATCH_SIZE);
        const result = await tx.sourceItem.deleteMany({ where: { id: { in: deleteBatch } } });
        totalDeleted += result.count;
      }

      return { orphaned: stillOrphanedIds.length, deleted: totalDeleted, evidenceRefs, signalLinks };
    });

    return {
      scanned: hubspotItems.length, orphaned: txResult.orphaned,
      deleted: txResult.deleted, dryRun: false,
      cascadeEvidenceReferences: txResult.evidenceRefs,
      nulledSignalLinks: txResult.signalLinks,
    };
  }

  async runResolveStages(companyId: string): Promise<Record<string, string>> {
    if (!this.env.HUBSPOT_ACCESS_TOKEN) {
      throw new Error("HUBSPOT_ACCESS_TOKEN is not configured");
    }

    const logger = createLogger(this.env);
    const repos = new SalesRepositoryBundle(this.prisma);
    const client = new Client({ accessToken: this.env.HUBSPOT_ACCESS_TOKEN });

    // Load doctrine
    const doctrine = await repos.getLatestDoctrine(companyId);
    if (!doctrine) {
      throw new Error("No doctrine found — run sales:preflight first to set up doctrine");
    }

    const pipelineId = (doctrine.doctrineJson as unknown as SalesDoctrineConfig).hubspotPipelineId;
    if (!pipelineId) {
      throw new Error("Doctrine missing hubspotPipelineId");
    }

    // Fetch stage labels from HubSpot
    const stageMap = await fetchPipelineStageMap(client, pipelineId);
    const stageLabels: Record<string, string> = {};
    for (const [id, label] of stageMap) {
      stageLabels[id] = label;
    }

    // Merge into doctrine (in-place update, same version)
    const existingConfig = doctrine.doctrineJson as unknown as SalesDoctrineConfig;
    const updatedConfig: SalesDoctrineConfig = {
      ...existingConfig,
      stageLabels,
      intelligenceStages: existingConfig.intelligenceStages ?? ["New", "Opportunity Validated"],
    };

    await repos.upsertDoctrine(companyId, doctrine.version, updatedConfig);
    logger.info({ stageLabels, intelligenceStages: updatedConfig.intelligenceStages },
      "Stage labels resolved and saved to doctrine");

    return stageLabels;
  }
}

// ---------------------------------------------------------------------------
// Drain loop helpers
// ---------------------------------------------------------------------------

const MAX_DRAIN_ITERATIONS = 20;
const MAX_DRAIN_DURATION_MS = 30 * 60_000; // 30 minutes
const RATE_LIMIT_BACKOFF_MS = 60_000;       // 60 seconds
const MAX_STALL_ITERATIONS = 2;

export type DrainStopReason = "queue_empty" | "stalled" | "rate_limited" | "iteration_cap" | "time_cap";

function emptyExtractionResult(): ExtractionResult {
  return {
    activitiesProcessed: 0,
    activitiesSkipped: 0,
    stageSkipped: 0,
    factsCreated: 0,
    retryableErrors: 0,
    terminalSkips: 0,
    exhaustedItems: 0,
    errors: [],
    warnings: [],
    costUsd: 0,
    rateLimited: false,
    capabilityStats: { totalFacts: 0, activitiesWithCapabilities: 0, activitiesProcessed: 0, meanPerActivity: 0, maxPerActivity: 0 },
  };
}

export function mergeExtractionResults(target: ExtractionResult, source: ExtractionResult): void {
  target.activitiesProcessed += source.activitiesProcessed;
  target.activitiesSkipped += source.activitiesSkipped;
  target.stageSkipped += source.stageSkipped;
  target.factsCreated += source.factsCreated;
  target.retryableErrors += source.retryableErrors;
  target.terminalSkips += source.terminalSkips;
  target.exhaustedItems += source.exhaustedItems;
  target.errors.push(...source.errors);
  target.warnings.push(...source.warnings);
  target.costUsd += source.costUsd;
  target.rateLimited = target.rateLimited || source.rateLimited;
  target.capabilityStats.totalFacts += source.capabilityStats.totalFacts;
  target.capabilityStats.activitiesWithCapabilities += source.capabilityStats.activitiesWithCapabilities;
  target.capabilityStats.activitiesProcessed += source.capabilityStats.activitiesProcessed;
  target.capabilityStats.maxPerActivity = Math.max(
    target.capabilityStats.maxPerActivity, source.capabilityStats.maxPerActivity
  );
  target.capabilityStats.meanPerActivity = target.capabilityStats.activitiesProcessed > 0
    ? target.capabilityStats.totalFacts / target.capabilityStats.activitiesProcessed
    : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
