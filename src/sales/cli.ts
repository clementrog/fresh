import { getPrisma } from "../db/client.js";
import { loadEnv } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { SalesApp } from "./app.js";

async function main() {
  const command = process.argv[2];
  const env = loadEnv();
  const logger = createLogger(env);

  if (!command) {
    logger.error("Usage: tsx src/sales/cli.ts <command>");
    logger.error("Commands: sales:check-config, sales:sync, sales:extract, sales:detect, sales:match, sales:cleanup");
    process.exit(1);
  }

  const prisma = getPrisma();
  const app = new SalesApp(prisma, env);

  try {
    switch (command) {
      case "sales:check-config": {
        const result = await app.checkConfig();
        for (const [key, value] of Object.entries(result.details)) {
          logger.info(`${key}: ${value}`);
        }
        if (!result.ok) {
          logger.error("Config check FAILED — resolve the above before running Sales commands");
          process.exit(1);
        }
        logger.info("Config check PASSED — env and schema are ready");
        logger.info("Note: this does not validate HubSpot API reachability. That requires sales:preflight (Slice 2).");
        break;
      }

      case "sales:sync":
      case "sales:extract":
      case "sales:detect":
      case "sales:match":
      case "sales:cleanup":
        logger.warn(`Command ${command} is not yet implemented (Slice 2+)`);
        break;

      default:
        logger.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Sales CLI fatal error:", error);
  process.exit(1);
});
