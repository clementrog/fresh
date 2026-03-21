import type { FastifyInstance } from "fastify";

import type { AdminQueries } from "../queries.js";
import type { ResolvedCompany } from "../plugin.js";
import { layout } from "../layout.js";
import { table, pagination, filterForm, badge, formatDate, sourceBadge, withCompany } from "../components.js";

export function registerRunPages(
  server: FastifyInstance,
  queries: AdminQueries,
  resolveCompany: (query: Record<string, string>) => Promise<ResolvedCompany | null>
) {
  server.get("/admin/runs", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
    const filters = { runType: query.runType || undefined };

    const [total, items] = await Promise.all([
      queries.countRuns(company.id, filters),
      queries.listRuns(company.id, filters, { page, pageSize: 50 })
    ]);

    const totalPages = Math.ceil(total / 50);

    const hiddenFields = companySlug ? { company: companySlug } : undefined;

    const filtersHtml = filterForm(
      [
        {
          name: "runType",
          label: "All run types",
          type: "select",
          options: [
            { value: "ingest:run", label: "ingest:run" },
            { value: "intelligence:run", label: "intelligence:run" },
            { value: "draft:generate", label: "draft:generate" },
            { value: "draft:generate-ready", label: "draft:generate-ready" },
            { value: "market-research:run", label: "market-research:run" },
            { value: "setup:notion", label: "setup:notion" },
            { value: "selection:scan", label: "selection:scan" },
            { value: "cleanup:retention", label: "cleanup:retention" },
            { value: "cleanup:claap-publishability", label: "cleanup:claap-publishability" },
            { value: "backfill:evidence", label: "backfill:evidence" }
          ]
        }
      ],
      { runType: filters.runType ?? "" },
      "/admin/runs",
      hiddenFields
    );

    const rows = items.map((run) => {
      const counters = run.countersJson as Record<string, unknown>;
      const counterStr = Object.entries(counters)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      const statusColor = run.status === "completed" ? "green" : run.status === "failed" ? "red" : "blue";

      return [
        run.runType,
        run.source ? sourceBadge(run.source) : "—",
        badge(run.status, statusColor as "green" | "red" | "blue"),
        counterStr || "—",
        formatDate(run.startedAt),
        formatDate(run.finishedAt),
        run.notes ?? "—"
      ];
    });

    const tableHtml = table(
      ["Type", "Source", "Status", "Counters", "Started", "Finished", "Notes"],
      rows
    );

    const url = new URL("/admin/runs", "http://localhost");
    if (filters.runType) url.searchParams.set("runType", filters.runType);
    if (companySlug) url.searchParams.set("company", companySlug);
    const paginationHtml = pagination(page, totalPages, url.pathname + url.search);

    const html = layout(
      `Runs (${total})`,
      filtersHtml + tableHtml + paginationHtml,
      company.name,
      companySlug
    );
    return reply.type("text/html").send(html);
  });
}
