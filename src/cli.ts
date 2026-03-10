import { loadEnv } from "./config/env.js";
import { createLogger } from "./lib/logger.js";
import { EditorialSignalEngineApp } from "./app.js";

async function main() {
  const env = loadEnv();
  const logger = createLogger(env);
  const app = new EditorialSignalEngineApp(env, logger);
  const [command, ...flags] = process.argv.slice(2);

  if (!command) {
    throw new Error("Missing command");
  }

  const dryRun = flags.includes("--dry-run");
  await app.run(command as Parameters<typeof app.run>[0], { dryRun });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
