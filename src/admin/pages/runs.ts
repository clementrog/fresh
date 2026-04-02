import type { FastifyInstance } from "fastify";

import type { AdminQueries } from "../queries.js";
import type { ResolvedCompany } from "../plugin.js";
import { layout, escapeHtml } from "../layout.js";
import {
  table,
  pagination,
  filterForm,
  badge,
  formatDate,
  sourceBadge,
  withCompany,
  linkTo,
  detailSection,
  collapsible,
  jsonViewer,
  backLink,
  buildDetailUrl
} from "../components.js";

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
    const returnTo = request.url;

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
        .filter(([k]) => k !== "notionCreates" && k !== "notionUpdates")
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      const statusColor = run.status === "completed" ? "green" : run.status === "failed" ? "red" : "blue";
      const warnings = Array.isArray(run.warningsJson) ? run.warningsJson as unknown[] : [];
      const warningBadge = warnings.length > 0 ? " " + badge(`${warnings.length} warning${warnings.length > 1 ? "s" : ""}`, "orange") : "";

      return [
        linkTo(buildDetailUrl(`/admin/runs/${run.id}`, companySlug, returnTo), run.runType),
        run.source ? sourceBadge(run.source) : "—",
        badge(run.status, statusColor as "green" | "red" | "blue") + warningBadge,
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

  server.get<{ Params: { id: string } }>("/admin/runs/:id", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const returnTo = query.returnTo || undefined;

    const run = await queries.getRun(request.params.id);
    if (!run || run.companyId !== company.id) {
      return reply
        .code(404)
        .type("text/html")
        .send(layout("Not Found", `<p>Run not found.</p>`, company.name, companySlug));
    }

    const backHtml = backLink(returnTo);

    const statusColor = run.status === "completed" ? "green" : run.status === "failed" ? "red" : "blue";
    const headerHtml = `<p>${badge(run.runType, "blue")} · ${run.source ? sourceBadge(run.source) : "No source"} · ${badge(run.status, statusColor as "green" | "red" | "blue")} · Started: ${formatDate(run.startedAt)} · Finished: ${formatDate(run.finishedAt)}</p>`;

    const countersHtml = detailSection("Counters", jsonViewer(run.countersJson));

    const warnings = Array.isArray(run.warningsJson) ? run.warningsJson as string[] : [];
    const warningsHtml = warnings.length > 0
      ? detailSection(
          `${badge(`${warnings.length} warning${warnings.length > 1 ? "s" : ""}`, "orange")} Warnings`,
          `<ul>${warnings.map(w => `<li>${escapeHtml(String(w))}</li>`).join("")}</ul>`
        )
      : "";

    const llmStatsHtml = run.llmStatsJson
      ? detailSection("LLM Stats", collapsible("Show LLM stats", jsonViewer(run.llmStatsJson)))
      : "";

    const tokenTotalsHtml = run.tokenTotalsJson
      ? detailSection("Token Totals", collapsible("Show token totals", jsonViewer(run.tokenTotalsJson)))
      : "";

    const notesHtml = run.notes
      ? detailSection("Notes", `<p>${escapeHtml(run.notes)}</p>`)
      : "";

    // Cost entries
    let costHtml: string;
    if (run.costEntries.length === 0) {
      costHtml = detailSection("Cost Breakdown", `<p class="empty">No cost entries.</p>`);
    } else {
      const costRows = run.costEntries.map((ce) => [
        escapeHtml(ce.step),
        escapeHtml(ce.model),
        badge(ce.mode, ce.mode === "provider" ? "green" : "orange"),
        String(ce.promptTokens),
        String(ce.completionTokens),
        `$${ce.estimatedCostUsd.toFixed(4)}`
      ]);

      const totalCost = run.costEntries.reduce((sum, ce) => sum + ce.estimatedCostUsd, 0);
      costRows.push(["", "", "", "", "<strong>Total</strong>", `<strong>$${totalCost.toFixed(2)}</strong>`]);

      costHtml = detailSection(
        "Cost Breakdown",
        table(["Step", "Model", "Mode", "Prompt Tokens", "Completion Tokens", "Cost (USD)"], costRows)
      );
    }

    const html = layout(
      `Run: ${escapeHtml(run.runType)}`,
      backHtml + headerHtml + countersHtml + warningsHtml + llmStatsHtml + tokenTotalsHtml + notesHtml + costHtml,
      company.name,
      companySlug
    );
    return reply.type("text/html").send(html);
  });
}
