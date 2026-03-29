import { getPrisma } from "../db/client.js";
import { loadEnv } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { SalesApp } from "./app.js";
import { translateSalesError } from "./connectors/hubspot.js";
import { ConcurrentRunError } from "./db/sales-repositories.js";
import type { AppEnv } from "../config/env.js";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";

export interface SalesCommandOpts {
  command: string;
  app: SalesApp;
  prisma: PrismaClient;
  env: AppEnv;
  logger: Logger;
  exit: (code: number) => void;
}

export async function runSalesCommand(opts: SalesCommandOpts): Promise<void> {
  const { command, app, prisma, env, logger, exit } = opts;

  switch (command) {
    case "sales:check-config": {
      const result = await app.checkConfig();
      for (const [key, value] of Object.entries(result.details)) {
        logger.info(`${key}: ${value}`);
      }
      if (!result.ok) {
        logger.error("Config check FAILED — resolve the above before running Sales commands");
        exit(1);
        return;
      }
      logger.info("Config check PASSED — env and schema are ready");
      logger.info("Note: this does not validate HubSpot API reachability. Use sales:preflight for that.");
      break;
    }

    case "sales:preflight": {
      const companySlug = env.DEFAULT_COMPANY_SLUG ?? "default";
      const company = await prisma.company.findUnique({ where: { slug: companySlug } });
      if (!company) {
        logger.error(`Company "${companySlug}" not found. Initialize it via the Content CLI first.`);
        exit(1);
        return;
      }
      logger.info(`Running preflight for company "${company.name}" (${company.id})`);

      // Path A: structured result — runPreflight never throws for readiness issues
      const result = await app.runPreflight(company.id);

      for (const check of result.checks) {
        const tag = check.status.toUpperCase();
        const classNote = check.errorClass ? ` [${check.errorClass}]` : "";
        logger.info(`[${tag}] ${check.name}: ${check.message}${classNote} (${check.durationMs}ms)`);
      }

      if (!result.ok) {
        logger.error(`Preflight FAILED: ${result.summary}`);
        exit(1);
        return;
      }
      if (!result.verified) {
        logger.info(`Preflight PASSED with caveats: ${result.summary}`);
        logger.info("Some checks could not be fully verified. Re-run after adding test data to the pipeline.");
      } else {
        logger.info(`Preflight PASSED — all capabilities verified: ${result.summary}`);
      }
      break;
    }

    case "sales:sync": {
      const companySlug = env.DEFAULT_COMPANY_SLUG ?? "default";
      const company = await prisma.company.findUnique({ where: { slug: companySlug } });
      if (!company) {
        logger.error(`Company "${companySlug}" not found. Initialize it via the Content CLI first.`);
        exit(1);
        return;
      }
      logger.info(`Starting HubSpot sync for company "${company.name}" (${company.id})`);

      // Path B: sync throws on failure — translate at command boundary
      try {
        await app.runSync(company.id);
        logger.info("HubSpot sync finished");
      } catch (error) {
        const t = translateSalesError(error);
        logger.error(t.message);
        // Log full error (with stack) at error level so diagnostics are preserved
        logger.error({ err: error }, "Raw error details");
        exit(t.exitCode);
      }
      break;
    }

    case "sales:extract": {
      const companySlug = env.DEFAULT_COMPANY_SLUG ?? "default";
      const company = await prisma.company.findUnique({ where: { slug: companySlug } });
      if (!company) {
        logger.error(`Company "${companySlug}" not found.`);
        exit(1);
        return;
      }
      const reprocess = process.argv.includes("--reprocess");
      const drain = process.argv.includes("--drain");
      const batchSizeIdx = process.argv.indexOf("--batch-size");
      let batchSize: number | undefined;
      if (batchSizeIdx !== -1) {
        const raw = process.argv[batchSizeIdx + 1];
        const parsed = Number(raw);
        batchSize = parsed;
        if (raw === undefined || !Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
          logger.error("--batch-size must be an integer between 1 and 1000");
          exit(1);
          return;
        }
      }
      const activityIdsIdx = process.argv.indexOf("--activity-ids");
      let activityIds: string[] | undefined;
      if (activityIdsIdx !== -1) {
        const raw = process.argv[activityIdsIdx + 1];
        if (!raw) {
          logger.error("--activity-ids requires a comma-separated list of activity IDs");
          exit(1);
          return;
        }
        activityIds = raw.split(",").map((s) => s.trim()).filter(Boolean);
        if (activityIds.length === 0 || activityIds.length > 50) {
          logger.error("--activity-ids must contain 1-50 IDs");
          exit(1);
          return;
        }
      }
      if (activityIds && (reprocess || drain)) {
        logger.error("--activity-ids cannot be combined with --reprocess or --drain");
        exit(1);
        return;
      }
      logger.info(`Starting extraction for company "${company.name}" (${company.id})${reprocess ? " [reprocess]" : ""}${drain ? " [drain]" : ""}${batchSize ? ` [batch=${batchSize}]` : ""}${activityIds ? ` [targeted=${activityIds.length}]` : ""}`);
      try {
        const result = await app.runExtract(company.id, { reprocess, batchSize, drain, activityIds });
        logger.info({
          processed: result.activitiesProcessed,
          skipped: result.activitiesSkipped,
          facts: result.factsCreated,
          retryable: result.retryableErrors,
          exhausted: result.exhaustedItems,
          costUsd: result.costUsd,
          rateLimited: result.rateLimited,
          capabilityStats: result.capabilityStats,
          ...(result.stopReason ? { stopReason: result.stopReason, iterations: result.iterations } : {}),
        }, activityIds ? "Targeted extraction completed" : drain ? "Drain completed" : "Extraction completed");
        for (const w of result.warnings) {
          logger.warn(w);
        }
      } catch (error) {
        if (error instanceof ConcurrentRunError) {
          logger.error(error.message);
          exit(1);
          return;
        }
        const t = translateSalesError(error);
        logger.error(t.message);
        logger.error({ err: error }, "Raw error details");
        exit(t.exitCode);
      }
      break;
    }

    case "sales:detect": {
      const companySlug = env.DEFAULT_COMPANY_SLUG ?? "default";
      const company = await prisma.company.findUnique({ where: { slug: companySlug } });
      if (!company) {
        logger.error(`Company "${companySlug}" not found.`);
        exit(1);
        return;
      }
      logger.info(`Starting signal detection for company "${company.name}" (${company.id})`);
      try {
        const result = await app.runDetect(company.id);
        logger.info({
          signals: result.signalsCreated,
          removed: result.signalsRemoved,
          deals: result.dealsScanned,
          errors: result.errors.length,
        }, "Detection completed");
      } catch (error) {
        if (error instanceof ConcurrentRunError) {
          logger.error(error.message);
          exit(1);
          return;
        }
        const t = translateSalesError(error);
        logger.error(t.message);
        logger.error({ err: error }, "Raw error details");
        exit(t.exitCode);
      }
      break;
    }

    case "sales:resolve-stages": {
      const companySlug = env.DEFAULT_COMPANY_SLUG ?? "default";
      const company = await prisma.company.findUnique({ where: { slug: companySlug } });
      if (!company) {
        logger.error(`Company "${companySlug}" not found.`);
        exit(1);
        return;
      }
      logger.info(`Resolving pipeline stage labels for company "${company.name}" (${company.id})`);
      try {
        const stageLabels = await app.runResolveStages(company.id);
        for (const [id, label] of Object.entries(stageLabels)) {
          logger.info(`  ${id} → ${label}`);
        }
        logger.info("Stage labels saved to doctrine");
      } catch (error) {
        const t = translateSalesError(error);
        logger.error(t.message);
        logger.error({ err: error }, "Raw error details");
        exit(t.exitCode);
      }
      break;
    }

    case "sales:status": {
      const companySlug = env.DEFAULT_COMPANY_SLUG ?? "default";
      const company = await prisma.company.findUnique({ where: { slug: companySlug } });
      if (!company) {
        logger.error(`Company "${companySlug}" not found.`);
        exit(1);
        return;
      }
      const status = await app.runStatus(company.id);
      logger.info({
        activities: `${status.processedActivities}/${status.totalActivities} processed (${status.processingRate}%)`,
        unprocessed: status.unprocessedActivities,
        deals: status.totalDeals,
        facts: status.totalFacts,
        signals: status.totalSignals,
      }, "Pipeline status");
      break;
    }

    case "sales:diagnostics": {
      const companySlug = env.DEFAULT_COMPANY_SLUG ?? "default";
      const company = await prisma.company.findUnique({ where: { slug: companySlug } });
      if (!company) {
        logger.error(`Company "${companySlug}" not found.`);
        exit(1);
        return;
      }
      const diag = await app.runDiagnostics(company.id);
      logger.info({
        nullBody: diag.nullBody,
        cleaned: diag.cleaned,
        exhaustedOrphan: diag.exhaustedOrphan,
        retryPending: diag.retryPending,
        pendingFirstAttempt: diag.pendingFirstAttempt,
        permanentlyUnreachable: diag.permanentlyUnreachable,
        actionable: diag.actionable,
      }, "Unprocessed in-scope activities (extractedAt IS NULL, intelligence-stage deals)");
      if (diag.noDeal > 0) {
        logger.info({ noDeal: diag.noDeal }, "Unprocessed out-of-scope activities (no deal association, company-wide)");
      }
      logger.info({
        adjustedTotal: diag.adjustedTotal,
        adjustedProcessingRate: `${diag.adjustedProcessingRate}%`,
      }, "Adjusted coverage (unvalidated — spot-check excluded items before trusting)");
      break;
    }

    case "sales:match":
    case "sales:cleanup":
      logger.warn(`Command ${command} is not yet implemented (Slice 4+)`);
      break;

    default:
      logger.error(`Unknown command: ${command}`);
      exit(1);
  }
}

async function main() {
  const command = process.argv[2];
  const env = loadEnv();
  const logger = createLogger(env);

  if (!command) {
    logger.error("Usage: tsx src/sales/cli.ts <command>");
    logger.error("Commands: sales:check-config, sales:preflight, sales:sync, sales:extract, sales:detect, sales:status, sales:diagnostics, sales:match, sales:cleanup");
    process.exit(1);
  }

  const prisma = getPrisma();
  const app = new SalesApp(prisma, env);

  try {
    await runSalesCommand({ command, app, prisma, env, logger, exit: process.exit });
  } finally {
    await prisma.$disconnect();
  }
}

// Guard against running main() when imported as a module (e.g., in tests)
const isDirectExecution = process.argv[1]?.endsWith("sales/cli.ts") || process.argv[1]?.endsWith("sales/cli.js");
if (isDirectExecution) {
  main().catch((error) => {
    console.error("Sales CLI fatal error:", error);
    process.exit(1);
  });
}
