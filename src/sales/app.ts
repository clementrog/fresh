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

  async runExtract(companyId: string, opts?: { reprocess?: boolean; batchSize?: number }): Promise<ExtractionResult> {
    const logger = createLogger(this.env);
    const repos = new SalesRepositoryBundle(this.prisma);

    if (opts?.reprocess) {
      const reset = await repos.resetExtractions(companyId);
      logger.info({ count: reset.count }, "Reset extractions for reprocessing");
    }

    const llmClient = new LlmClient(this.env, logger);
    const provider = this.env.SALES_LLM_PROVIDER ?? "openai";
    const model = this.env.SALES_LLM_MODEL ?? "gpt-4.1-mini";

    return runExtraction({ companyId, repos, llmClient, logger, provider, model, batchSize: opts?.batchSize });
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
