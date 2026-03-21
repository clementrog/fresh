import type { FastifyInstance } from "fastify";

import type { AdminQueries } from "../queries.js";
import type { ResolvedCompany } from "../plugin.js";
import { layout } from "../layout.js";
import { table, formatDate } from "../components.js";

export function registerUserPages(
  server: FastifyInstance,
  queries: AdminQueries,
  resolveCompany: (query: Record<string, string>) => Promise<ResolvedCompany | null>
) {
  server.get("/admin/users", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;

    const users = await queries.listUsers(company.id);

    const rows = users.map((u) => [
      u.displayName,
      u.type,
      u.language,
      formatDate(u.createdAt)
    ]);

    const tableHtml = table(["Name", "Type", "Language", "Created"], rows);

    const html = layout(`Users (${users.length})`, tableHtml, company.name, companySlug);
    return reply.type("text/html").send(html);
  });
}
