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
  linkTo,
  detailSection,
  backLink,
  withCompany,
  buildDetailUrl
} from "../components.js";

export function registerDraftPages(
  server: FastifyInstance,
  queries: AdminQueries,
  resolveCompany: (query: Record<string, string>) => Promise<ResolvedCompany | null>
) {
  server.get("/admin/drafts", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
    const filters = {
      profileId: query.profileId || undefined,
      q: query.q || undefined
    };

    // Dynamic profileId options
    const profileIds = await queries.listDraftProfileIds(company.id);

    const [total, items] = await Promise.all([
      queries.countDrafts(company.id, filters),
      queries.listDrafts(company.id, filters, { page, pageSize: 50 })
    ]);

    const totalPages = Math.ceil(total / 50);
    const hiddenFields = companySlug ? { company: companySlug } : undefined;
    const returnTo = request.url;

    const filtersHtml = filterForm(
      [
        {
          name: "profileId",
          label: "All profiles",
          type: "select",
          options: profileIds.map((p) => ({ value: p, label: p }))
        },
        { name: "q", label: "Search title…", type: "text" }
      ],
      { profileId: filters.profileId ?? "", q: filters.q ?? "" },
      "/admin/drafts",
      hiddenFields
    );

    const rows = items.map((d) => {
      const oppLink = d.opportunity
        ? linkTo(buildDetailUrl(`/admin/opportunities/${d.opportunity.id}`, companySlug), truncate(d.opportunity.title, 30))
        : "—";
      return [
        linkTo(buildDetailUrl(`/admin/drafts/${d.id}`, companySlug, returnTo), truncate(d.proposedTitle, 50)),
        badge(d.profileId, "blue"),
        oppLink,
        d.confidenceScore.toFixed(2),
        d.language,
        formatDate(d.createdAt)
      ];
    });

    const tableHtml = table(
      ["Title", "Profile", "Opportunity", "Confidence", "Language", "Created"],
      rows
    );

    const url = new URL("/admin/drafts", "http://localhost");
    if (filters.profileId) url.searchParams.set("profileId", filters.profileId);
    if (filters.q) url.searchParams.set("q", filters.q);
    if (companySlug) url.searchParams.set("company", companySlug);
    const paginationHtml = pagination(page, totalPages, url.pathname + url.search);

    const html = layout(
      `Drafts (${total})`,
      filtersHtml + tableHtml + paginationHtml,
      company.name,
      companySlug
    );
    return reply.type("text/html").send(html);
  });

  server.get<{ Params: { id: string } }>("/admin/drafts/:id", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const returnTo = query.returnTo || undefined;

    const draft = await queries.getDraft(request.params.id);
    if (!draft || draft.companyId !== company.id) {
      return reply
        .code(404)
        .type("text/html")
        .send(layout("Not Found", `<p>Draft not found.</p>`, company.name, companySlug));
    }

    const backHtml = backLink(returnTo);

    const headerHtml = `<p>${badge(draft.profileId, "blue")} · Confidence: ${draft.confidenceScore.toFixed(2)} · Language: ${escapeHtml(draft.language)} · Created: ${formatDate(draft.createdAt)}</p>`;

    const oppHtml = draft.opportunity
      ? `<p>Opportunity: ${linkTo(buildDetailUrl(`/admin/opportunities/${draft.opportunity.id}`, companySlug), escapeHtml(draft.opportunity.title))}</p>`
      : "<p>Opportunity: —</p>";

    const hookHtml = detailSection("Opening Hook", `<p>${escapeHtml(draft.hook)}</p>`);
    const summaryHtml = detailSection("Summary", `<p>${escapeHtml(draft.summary)}</p>`);
    const aboutHtml = detailSection(
      "What It Is About / Not About",
      `<p><strong>About:</strong> ${escapeHtml(draft.whatItIsAbout)}</p>
       <p><strong>Not About:</strong> ${escapeHtml(draft.whatItIsNotAbout)}</p>`
    );
    const visualHtml = detailSection("Visual Idea", `<p>${escapeHtml(draft.visualIdea)}</p>`);
    const fullTextHtml = detailSection(
      "Full Draft Text",
      `<pre style="white-space:pre-wrap">${escapeHtml(draft.firstDraftText)}</pre>`
    );

    const evidenceRows = draft.evidence.map((e) => [
      truncate(e.excerpt, 80),
      e.source,
      e.speakerOrAuthor ?? "—",
      formatDate(e.timestamp),
      e.sourceUrl ? linkTo(e.sourceUrl, "link") : "—"
    ]);
    const evidenceHtml = detailSection(
      "Evidence",
      table(["Excerpt", "Source", "Speaker/Author", "Date", "URL"], evidenceRows)
    );

    const html = layout(
      escapeHtml(draft.proposedTitle),
      backHtml + headerHtml + oppHtml + hookHtml + summaryHtml + aboutHtml + visualHtml + fullTextHtml + evidenceHtml,
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
