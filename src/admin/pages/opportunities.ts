import type { FastifyInstance } from "fastify";

import type { AdminQueries } from "../queries.js";
import type { ResolvedCompany } from "../plugin.js";
import { layout, escapeHtml } from "../layout.js";
import {
  table,
  pagination,
  filterForm,
  statusBadge,
  badge,
  formatDate,
  linkTo,
  jsonViewer,
  detailSection,
  withCompany,
  buildDetailUrl,
  backLink
} from "../components.js";

export function registerOpportunityPages(
  server: FastifyInstance,
  queries: AdminQueries,
  resolveCompany: (query: Record<string, string>) => Promise<ResolvedCompany | null>
) {
  server.get("/admin/opportunities", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;

    const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
    const filters = {
      status: query.status || undefined,
      readiness: query.readiness || undefined,
      q: query.q || undefined
    };

    const [total, items] = await Promise.all([
      queries.countOpportunities(company.id, filters),
      queries.listOpportunities(company.id, filters, { page, pageSize: 50 })
    ]);

    const totalPages = Math.ceil(total / 50);

    const hiddenFields = companySlug ? { company: companySlug } : undefined;

    const filtersHtml = filterForm(
      [
        {
          name: "status",
          label: "All statuses",
          type: "select",
          options: [
            { value: "To review", label: "To review" },
            { value: "Needs routing", label: "Needs routing" },
            { value: "To enrich", label: "To enrich" },
            { value: "Ready for V1", label: "Ready for V1" },
            { value: "V1 generated", label: "V1 generated" },
            { value: "Selected", label: "Selected" },
            { value: "V2 in progress", label: "V2 in progress" },
            { value: "Waiting approval", label: "Waiting approval" },
            { value: "Rejected", label: "Rejected" },
            { value: "Archived", label: "Archived" }
          ]
        },
        {
          name: "readiness",
          label: "All readiness",
          type: "select",
          options: [
            { value: "Opportunity only", label: "Opportunity only" },
            { value: "Draft candidate", label: "Draft candidate" },
            { value: "V1 generated", label: "V1 generated" }
          ]
        },
        { name: "q", label: "Search title…", type: "text" }
      ],
      { status: filters.status ?? "", readiness: filters.readiness ?? "", q: filters.q ?? "" },
      "/admin/opportunities",
      hiddenFields
    );

    const returnTo = request.url;

    const rows = items.map((item) => [
      linkTo(buildDetailUrl(`/admin/opportunities/${item.id}`, companySlug, returnTo), truncate(item.title, 50)),
      statusBadge(item.status),
      item.readiness ? badge(item.readiness, item.readiness === "V1 generated" ? "green" : "blue") : "—",
      item.ownerProfile ?? "—",
      String(item.supportingEvidenceCount),
      item.notionPageId ? badge("synced", "green") : badge("local", "gray"),
      formatDate(item.updatedAt)
    ]);

    const tableHtml = table(
      ["Title", "Status", "Readiness", "Owner", "Evidence", "Notion", "Updated"],
      rows
    );

    const paginationHtml = pagination(page, totalPages, buildCurrentUrl("/admin/opportunities", query));

    const html = layout(
      `Opportunities (${total})`,
      filtersHtml + tableHtml + paginationHtml,
      company.name,
      companySlug
    );
    return reply.type("text/html").send(html);
  });

  server.get<{ Params: { id: string } }>("/admin/opportunities/:id", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const returnTo = query.returnTo || undefined;

    const opp = await queries.getOpportunity(request.params.id);
    if (!opp || opp.companyId !== company.id) {
      return reply
        .code(404)
        .type("text/html")
        .send(layout("Not Found", `<p>Opportunity not found.</p>`, company.name, companySlug));
    }

    const backHtml = backLink(returnTo);

    const headerHtml = `<p>${statusBadge(opp.status)} · ${
      opp.readiness ? badge(opp.readiness, "blue") : ""
    } · Owner: ${escapeHtml(opp.ownerUser?.displayName ?? opp.ownerProfile ?? "—")}${
      opp.notionPageId ? ` · ${linkTo(`https://notion.so/${opp.notionPageId.replace(/-/g, "")}`, "Notion")}` : ""
    }</p>`;

    const contentHtml = detailSection(
      "Content",
      `<p><strong>Angle:</strong> ${escapeHtml(opp.angle)}</p>
       <p><strong>Why Now:</strong> ${escapeHtml(opp.whyNow)}</p>
       <p><strong>What It Is About:</strong> ${escapeHtml(opp.whatItIsAbout)}</p>
       <p><strong>What It Is Not About:</strong> ${escapeHtml(opp.whatItIsNotAbout)}</p>
       <p><strong>Format:</strong> ${escapeHtml(opp.suggestedFormat)}</p>`
    );

    const directEvidence = opp.evidence.map((e) => [
      truncate(e.excerpt, 80),
      e.source,
      e.speakerOrAuthor ?? "—",
      formatDate(e.timestamp),
      e.sourceUrl ? linkTo(e.sourceUrl, "link") : "—"
    ]);
    const linkedEvidence = opp.linkedEvidence.map((le) => [
      truncate(le.evidence.excerpt, 80),
      le.evidence.source,
      le.evidence.speakerOrAuthor ?? "—",
      formatDate(le.evidence.timestamp),
      "—"
    ]);
    const allEvidence = [...directEvidence, ...linkedEvidence];
    const evidenceHtml = detailSection(
      "Evidence",
      table(["Excerpt", "Source", "Speaker/Author", "Date", "URL"], allEvidence)
    );

    const enrichmentLog = opp.enrichmentLogJson as unknown[];
    const enrichmentHtml = detailSection(
      "Enrichment Log",
      Array.isArray(enrichmentLog) && enrichmentLog.length > 0
        ? jsonViewer(enrichmentLog)
        : "<p>No enrichment log entries.</p>"
    );

    const draftRows = opp.drafts.map((d) => [
      escapeHtml(truncate(d.proposedTitle, 50)),
      d.profileId,
      String(d.confidenceScore.toFixed(2)),
      formatDate(d.createdAt)
    ]);
    const draftsHtml = detailSection(
      "Drafts",
      table(["Title", "Profile", "Confidence", "Created"], draftRows)
    );

    const html = layout(
      escapeHtml(opp.title),
      backHtml + headerHtml + contentHtml + evidenceHtml + enrichmentHtml + draftsHtml,
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

function buildCurrentUrl(base: string, query: Record<string, string>): string {
  const url = new URL(base, "http://localhost");
  for (const [key, val] of Object.entries(query)) {
    if (key === "page" || key === "returnTo" || !val) continue;
    url.searchParams.set(key, val);
  }
  return url.pathname + url.search;
}
