import type { PrismaClient } from "@prisma/client";
import { Client } from "@hubspot/api-client";
import type { AppEnv } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { SalesRepositoryBundle } from "./db/sales-repositories.js";
import { createHubSpotApiAdapter, HubSpotSyncService } from "./connectors/hubspot.js";
import type { SyncResult } from "./connectors/hubspot.js";

export interface ConfigCheckResult {
  ok: boolean;
  details: Record<string, string>;
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
    details.hubspot = "token present (not validated — use sales:preflight after Slice 2)";

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
}
