import type { FastifyInstance } from "fastify";

import type { AdminQueries, Disposition } from "../queries.js";
import type { ResolvedCompany } from "../plugin.js";
import { layout, escapeHtml } from "../layout.js";
import {
  table,
  pagination,
  filterForm,
  sourceBadge,
  badge,
  formatDate,
  linkTo,
  jsonViewer,
  detailSection,
  collapsible,
  buildDetailUrl,
  backLink
} from "../components.js";

export function registerSourceItemPages(
  server: FastifyInstance,
  queries: AdminQueries,
  resolveCompany: (query: Record<string, string>) => Promise<ResolvedCompany | null>
) {
  server.get("/admin/source-items", async (request, reply) => {
    const query = request.query as Record<string, string | string[]>;
    const company = await resolveCompany(query as Record<string, string>);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = (query.company as string) || undefined;

    const page = Math.max(1, parseInt(String(query.page ?? "1"), 10) || 1);
    const filters = {
      source: String(query.source ?? ""),
      screening: (query.screening as "skip" | "retain" | undefined) || undefined,
      processed: (query.processed as "yes" | "no" | undefined) || undefined,
      q: String(query.q ?? ""),
      disposition: parseDisposition(String(query.disposition ?? ""))
    };

    const [total, items] = await Promise.all([
      queries.countSourceItems(company.id, filters),
      queries.listSourceItems(company.id, filters, { page, pageSize: 50 })
    ]);

    const totalPages = Math.ceil(total / 50);

    const hiddenFields = companySlug ? { company: companySlug } : undefined;

    const filtersHtml = filterForm(
      [
        {
          name: "source",
          label: "All sources",
          type: "select",
          options: [
            { value: "claap", label: "Claap" },
            { value: "linear", label: "Linear" },
            { value: "notion", label: "Notion" },
            { value: "market-findings", label: "Market Findings" },
            { value: "market-research", label: "Market Research" }
          ]
        },
        {
          name: "screening",
          label: "All screening",
          type: "select",
          options: [
            { value: "skip", label: "Skipped" },
            { value: "retain", label: "Retained" }
          ]
        },
        {
          name: "processed",
          label: "All processed",
          type: "select",
          options: [
            { value: "yes", label: "Processed" },
            { value: "no", label: "Not processed" }
          ]
        },
        {
          name: "disposition",
          label: "All dispositions",
          type: "select",
          options: [
            { value: "screened-out", label: "Screened Out" },
            { value: "blocked", label: "Blocked" },
            { value: "orphaned", label: "Orphaned" },
            { value: "unsynced", label: "Unsynced" }
          ]
        },
        { name: "q", label: "Search title…", type: "text" }
      ],
      {
        source: filters.source,
        screening: filters.screening ?? "",
        processed: filters.processed ?? "",
        disposition: filters.disposition ?? "",
        q: filters.q
      },
      "/admin/source-items",
      hiddenFields
    );

    const returnTo = request.url;

    const rows = items.map((item) => {
      const meta = item.metadataJson as Record<string, unknown> | null;
      const screening = item.screeningResultJson as Record<string, unknown> | null;
      const screeningDecision = screening?.decision as string | undefined;

      return [
        linkTo(buildDetailUrl(`/admin/source-items/${item.id}`, companySlug, returnTo), truncate(item.title, 60)),
        sourceBadge(item.source),
        screeningDecision
          ? badge(screeningDecision, screeningDecision === "skip" ? "red" : "green")
          : badge("pending", "gray"),
        item.processedAt ? badge("yes", "green") : badge("no", "gray"),
        meta?.publishabilityRisk
          ? badge(
              String(meta.publishabilityRisk),
              meta.publishabilityRisk === "safe" ? "green" : meta.publishabilityRisk === "harmful" ? "red" : "orange"
            )
          : "—",
        formatDate(item.occurredAt)
      ];
    });

    const tableHtml = table(
      ["Title", "Source", "Screening", "Processed", "Risk", "Occurred"],
      rows
    );

    const paginationHtml = pagination(page, totalPages, buildCurrentUrl("/admin/source-items", query));

    const html = layout(
      `Source Items (${total})`,
      filtersHtml + tableHtml + paginationHtml,
      company.name,
      companySlug
    );
    return reply.type("text/html").send(html);
  });

  server.get<{ Params: { id: string } }>("/admin/source-items/:id", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const returnTo = query.returnTo || undefined;

    const item = await queries.getSourceItem(request.params.id);
    if (!item || item.companyId !== company.id) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Source item not found.</p>`, company.name, companySlug));
    }

    const backHtml = backLink(returnTo);

    const headerHtml = `<p>${sourceBadge(item.source)} · ${formatDate(item.occurredAt)}${
      item.sourceUrl ? ` · ${linkTo(item.sourceUrl, "Source URL")}` : ""
    }</p>`;

    const summaryHtml = detailSection("Summary", `<p>${escapeHtml(item.summary)}</p>`);

    const screeningHtml = detailSection(
      "Screening Result",
      item.screeningResultJson ? jsonViewer(item.screeningResultJson) : "<p>Not screened yet.</p>"
    );

    const metadataHtml = detailSection("Metadata", jsonViewer(item.metadataJson));

    const payloadStr = JSON.stringify(item.rawPayloadJson, null, 2);
    const truncatedPayload = payloadStr.length > 10240 ? payloadStr.slice(0, 10240) + "\n... (truncated)" : payloadStr;
    const rawPayloadHtml = detailSection(
      "Raw Payload",
      collapsible("Show raw payload", `<pre><code>${escapeHtml(truncatedPayload)}</code></pre>`)
    );

    const evidenceRows = item.evidenceReferences.map((e) => {
      const oppTitle = e.opportunity?.title ?? e.primaryForOpportunities?.[0]?.title ?? "—";
      const oppId = e.opportunity?.id ?? e.primaryForOpportunities?.[0]?.id ?? null;
      return [
        oppId ? linkTo(buildDetailUrl(`/admin/opportunities/${oppId}`, companySlug, returnTo), truncate(oppTitle, 40)) : "—",
        truncate(e.excerpt, 80),
        e.speakerOrAuthor ?? "—",
        String(e.freshnessScore.toFixed(2))
      ];
    });
    const evidenceHtml = detailSection(
      "Linked Evidence",
      table(["Opportunity", "Excerpt", "Speaker/Author", "Freshness"], evidenceRows)
    );

    const html = layout(
      escapeHtml(item.title),
      backHtml + headerHtml + summaryHtml + screeningHtml + metadataHtml + rawPayloadHtml + evidenceHtml,
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

const VALID_DISPOSITIONS: Disposition[] = ["screened-out", "blocked", "orphaned", "unsynced"];

function parseDisposition(value: string): Disposition | undefined {
  return VALID_DISPOSITIONS.includes(value as Disposition) ? (value as Disposition) : undefined;
}

function buildCurrentUrl(base: string, query: Record<string, string | string[]>): string {
  const url = new URL(base, "http://localhost");
  for (const [key, val] of Object.entries(query)) {
    if (key === "page" || key === "returnTo" || !val) continue;
    const v = Array.isArray(val) ? val[0] : val;
    if (v) url.searchParams.set(key, v);
  }
  return url.pathname + url.search;
}
