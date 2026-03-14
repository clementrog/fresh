import Fastify, { type FastifyInstance } from "fastify";

import { EditorialSignalEngineApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { NotFoundError, ForbiddenError, UnprocessableError } from "./lib/errors.js";
import { createLogger } from "./lib/logger.js";

export function registerDraftRoute(server: FastifyInstance, app: EditorialSignalEngineApp) {
  server.post<{
    Params: { companyId: string; opportunityId: string };
  }>("/v1/companies/:companyId/opportunities/:opportunityId/draft", async (request, reply) => {
    const { companyId, opportunityId } = request.params;
    if (!opportunityId || opportunityId.trim().length === 0) {
      return reply.code(422).send({
        status: "error",
        message: "opportunityId is required"
      });
    }

    try {
      const draft = await app.run("draft:generate", {
        companySlug: companyId,
        opportunityId
      });
      return reply.code(200).send({
        status: "ok",
        opportunityId,
        draftId: (draft as { id?: string } | undefined)?.id
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return reply.code(404).send({ status: "error", message: error.message });
      }
      if (error instanceof ForbiddenError) {
        return reply.code(403).send({ status: "error", message: error.message });
      }
      if (error instanceof UnprocessableError) {
        return reply.code(422).send({ status: "error", message: error.message });
      }
      request.log.error({ error }, "Draft generation request failed");
      return reply.code(500).send({ status: "error", message: "Internal server error" });
    }
  });
}

async function main() {
  const env = loadEnv();
  const logger = createLogger(env);
  const app = new EditorialSignalEngineApp(env, logger);
  const server = Fastify({ logger: true });

  registerDraftRoute(server, app);

  await server.listen({
    host: "0.0.0.0",
    port: env.HTTP_PORT
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""))) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
