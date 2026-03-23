import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

import { AdminQueries } from "./queries.js";
import { registerDashboard } from "./pages/dashboard.js";
import { registerSourceItemPages } from "./pages/source-items.js";
import { registerOpportunityPages } from "./pages/opportunities.js";
import { registerReviewPages } from "./pages/reviews.js";
import { registerRunPages } from "./pages/runs.js";
import { registerUserPages } from "./pages/users.js";
import { registerEditorialConfigPages } from "./pages/editorial-configs.js";
import { registerSourceConfigPages } from "./pages/source-configs.js";
import { registerMarketQueryPages } from "./pages/market-queries.js";
import { registerDraftPages } from "./pages/drafts.js";

export interface AdminOptions {
  user: string;
  password: string;
  allowRemote: boolean;
  defaultCompanySlug: string;
}

export interface ResolvedCompany {
  id: string;
  slug: string;
  name: string;
}

export function registerAdminPlugin(
  server: FastifyInstance,
  prisma: PrismaClient,
  options: AdminOptions
) {
  if (!options.user || !options.password) {
    throw new Error("ADMIN_USER and ADMIN_PASSWORD must be set when ADMIN_ENABLED=true");
  }

  const queries = new AdminQueries(prisma);

  // Access control hook — localhost check + HTTP Basic Auth
  server.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/admin")) return;

    // Transport security: localhost-only by default
    if (!options.allowRemote) {
      const ip = request.ip;
      if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
        return reply
          .code(403)
          .type("text/plain")
          .send("Forbidden — admin is localhost-only. Set ADMIN_ALLOW_REMOTE=true if behind HTTPS proxy.");
      }
    }

    // HTTP Basic Auth
    const header = request.headers.authorization ?? "";
    if (!header.startsWith("Basic ")) {
      reply.header("WWW-Authenticate", 'Basic realm="Fresh Admin"');
      return reply.code(401).type("text/plain").send("Unauthorized");
    }
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const [user, ...rest] = decoded.split(":");
    const password = rest.join(":");
    if (user !== options.user || password !== options.password) {
      reply.header("WWW-Authenticate", 'Basic realm="Fresh Admin"');
      return reply.code(401).type("text/plain").send("Unauthorized");
    }
  });

  // Response hardening — no caching, no indexing
  server.addHook("onSend", async (request, reply) => {
    if (!request.url.startsWith("/admin")) return;
    reply.header("Cache-Control", "no-store");
    reply.header("X-Robots-Tag", "noindex");
  });

  // Company resolver shared by all pages
  async function resolveCompany(
    query: Record<string, string>
  ): Promise<ResolvedCompany | null> {
    const slug = query.company || options.defaultCompanySlug;
    return queries.getCompanyBySlug(slug);
  }

  // Register all page handlers
  registerDashboard(server, queries, resolveCompany);
  registerSourceItemPages(server, queries, resolveCompany);
  registerOpportunityPages(server, queries, resolveCompany);
  registerReviewPages(server, queries, resolveCompany);
  registerRunPages(server, queries, resolveCompany);
  registerUserPages(server, queries, resolveCompany);
  registerEditorialConfigPages(server, queries, resolveCompany);
  registerSourceConfigPages(server, queries, resolveCompany);
  registerMarketQueryPages(server, queries, resolveCompany);
  registerDraftPages(server, queries, resolveCompany);
}
