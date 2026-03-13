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

  const parsedFlags = parseFlags(flags);
  await app.run(command as Parameters<typeof app.run>[0], {
    dryRun: parsedFlags["dry-run"] === "true",
    opportunityId: parsedFlags["opportunity-id"],
    companySlug: parsedFlags["company"] ?? env.DEFAULT_COMPANY_SLUG,
    port: parsedFlags.port ? Number(parsedFlags.port) : undefined
  });
}

function parseFlags(flags: string[]) {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (!flag.startsWith("--")) {
      continue;
    }

    const key = flag.slice(2);
    const next = flags[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
