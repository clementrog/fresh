import { getPrisma } from "../db/client.js";
import { loadEnv } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { SalesApp } from "./app.js";
import { translateSalesError } from "./connectors/hubspot.js";
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

    case "sales:extract":
    case "sales:detect":
    case "sales:match":
    case "sales:cleanup":
      logger.warn(`Command ${command} is not yet implemented (Slice 3+)`);
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
    logger.error("Commands: sales:check-config, sales:preflight, sales:sync, sales:extract, sales:detect, sales:match, sales:cleanup");
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
