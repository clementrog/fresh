import type { FastifyInstance } from "fastify";

import type { AdminQueries } from "../queries.js";
import type { ResolvedCompany } from "../plugin.js";
import { layout } from "../layout.js";
import { table, sourceBadge, enabledBadge, formatDate, collapsible, jsonViewer } from "../components.js";

export function registerSourceConfigPages(
  server: FastifyInstance,
  queries: AdminQueries,
  resolveCompany: (query: Record<string, string>) => Promise<ResolvedCompany | null>
) {
  server.get("/admin/source-configs", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;

    const configs = await queries.listSourceConfigs(company.id);

    const rows = configs.map((c) => [
      sourceBadge(c.source),
      enabledBadge(c.enabled),
      formatDate(c.updatedAt)
    ]);

    const tableHtml = table(["Source", "Enabled", "Updated"], rows);

    const configDetails = configs
      .map((c) => collapsible(`${c.source} config`, jsonViewer(c.configJson)))
      .join("");

    const html = layout(
      `Source Configs (${configs.length})`,
      tableHtml + (configDetails ? `<div class="detail-section"><h2>Config Details</h2>${configDetails}</div>` : ""),
      company.name,
      companySlug
    );
    return reply.type("text/html").send(html);
  });
}
