import type { PrismaClient } from "@prisma/client";
import type { AppEnv } from "../config/env.js";

export interface ConfigCheckResult {
  ok: boolean;
  details: Record<string, string>;
}

/**
 * SalesApp — top-level orchestrator for Fresh Sales.
 *
 * `checkConfig()` validates that the env/config prerequisites for Sales are
 * present and minimally valid. It does NOT call external services (HubSpot API,
 * LLM providers). External-service reachability checks belong in a `preflight`
 * method that will be added in Slice 2 once the HubSpot connector exists.
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
}
