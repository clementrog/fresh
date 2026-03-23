import type { FastifyInstance } from "fastify";

import type { AdminQueries } from "../queries.js";
import type { ResolvedCompany } from "../plugin.js";
import { layout, escapeHtml } from "../layout.js";
import { table, pagination, filterForm, enabledBadge, formatDate, withCompany } from "../components.js";

export function registerMarketQueryPages(
  server: FastifyInstance,
  queries: AdminQueries,
  resolveCompany: (query: Record<string, string>) => Promise<ResolvedCompany | null>
) {
  server.get("/admin/market-queries", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
    const filters = {
      enabled: (query.enabled as "yes" | "no" | undefined) || undefined
    };

    const [total, items] = await Promise.all([
      queries.countMarketQueries(company.id, filters),
      queries.listMarketQueries(company.id, filters, { page, pageSize: 50 })
    ]);

    const totalPages = Math.ceil(total / 50);

    const hiddenFields = companySlug ? { company: companySlug } : undefined;

    const filtersHtml = filterForm(
      [
        {
          name: "enabled",
          label: "All",
          type: "select",
          options: [
            { value: "yes", label: "Enabled" },
            { value: "no", label: "Disabled" }
          ]
        }
      ],
      { enabled: filters.enabled ?? "" },
      "/admin/market-queries",
      hiddenFields
    );

    const rows = items.map((mq) => [
      escapeHtml(truncate(mq.query, 80)),
      enabledBadge(mq.enabled),
      String(mq.priority),
      formatDate(mq.createdAt),
      formatDate(mq.updatedAt)
    ]);

    const tableHtml = table(
      ["Query", "Enabled", "Priority (1=highest)", "Created", "Updated"],
      rows
    );

    const url = new URL("/admin/market-queries", "http://localhost");
    if (filters.enabled) url.searchParams.set("enabled", filters.enabled);
    if (companySlug) url.searchParams.set("company", companySlug);
    const paginationHtml = pagination(page, totalPages, url.pathname + url.search);

    const html = layout(
      `Market Queries (${total})`,
      filtersHtml + tableHtml + paginationHtml,
      company.name,
      companySlug
    );
    return reply.type("text/html").send(html);
  });
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}
