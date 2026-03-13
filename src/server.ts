import Fastify from "fastify";

import { EditorialSignalEngineApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createLogger } from "./lib/logger.js";

async function main() {
  const env = loadEnv();
  const logger = createLogger(env);
  const app = new EditorialSignalEngineApp(env, logger);
  const server = Fastify({ logger: false });

  server.post<{
    Params: { companyId: string; opportunityId: string };
  }>("/v1/companies/:companyId/opportunities/:opportunityId/draft", async (request, reply) => {
    try {
      const draft = await app.run("draft:generate", {
        companySlug: request.params.companyId,
        opportunityId: request.params.opportunityId
      });
      return reply.code(202).send({
        status: "accepted",
        opportunityId: request.params.opportunityId,
        draftId: (draft as { id?: string } | undefined)?.id
      });
    } catch (error) {
      request.log.error({ error }, "Draft generation request failed");
      return reply.code(400).send({
        status: "error",
        message: error instanceof Error ? error.message : "Unknown draft generation error"
      });
    }
  });

  await server.listen({
    host: "0.0.0.0",
    port: env.HTTP_PORT
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
