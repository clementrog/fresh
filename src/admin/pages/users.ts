import type { FastifyInstance } from "fastify";

import type { AdminQueries } from "../queries.js";
import type { ResolvedCompany } from "../plugin.js";
import { layout, escapeHtml } from "../layout.js";
import {
  table,
  formatDate,
  badge,
  detailSection,
  bulletList,
  collapsible,
  jsonViewer,
  linkTo,
  backLink,
  buildDetailUrl
} from "../components.js";

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
    const returnTo = request.url;

    const users = await queries.listUsers(company.id);

    const rows = users.map((u) => [
      linkTo(buildDetailUrl(`/admin/users/${u.id}`, companySlug, returnTo), u.displayName),
      u.type,
      u.language,
      formatDate(u.createdAt)
    ]);

    const tableHtml = table(["Name", "Type", "Language", "Created"], rows);

    const html = layout(`Users (${users.length})`, tableHtml, company.name, companySlug);
    return reply.type("text/html").send(html);
  });

  server.get<{ Params: { id: string } }>("/admin/users/:id", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const returnTo = query.returnTo || undefined;

    const user = await queries.getUser(request.params.id);
    if (!user || user.companyId !== company.id) {
      return reply
        .code(404)
        .type("text/html")
        .send(layout("Not Found", `<p>User not found.</p>`, company.name, companySlug));
    }

    const backHtml = backLink(returnTo);

    const typeBadge = user.type === "human" ? badge("human", "green") : badge(user.type, "blue");
    const headerHtml = `<p>${typeBadge} · Language: ${escapeHtml(user.language)} · Created: ${formatDate(user.createdAt)} · Updated: ${formatDate(user.updatedAt)}</p>`;

    const profile = (user.baseProfile as Record<string, unknown>) ?? {};
    const knownKeys = new Set([
      "toneSummary", "preferredStructure", "typicalPhrases",
      "avoidRules", "contentTerritories", "weakFitTerritories", "sampleExcerpts"
    ]);
    const extraKeys = Object.fromEntries(Object.entries(profile).filter(([k]) => !knownKeys.has(k)));

    const toneHtml = detailSection(
      "Tone of Voice",
      profile.toneSummary ? `<p>${escapeHtml(String(profile.toneSummary))}</p>` : "<p>—</p>"
    );

    const structureHtml = detailSection(
      "Preferred Structure",
      profile.preferredStructure ? `<p>${escapeHtml(String(profile.preferredStructure))}</p>` : "<p>—</p>"
    );

    const phrasesHtml = detailSection("Typical Phrases", bulletList(profile.typicalPhrases));
    const avoidHtml = detailSection("Avoid Rules", bulletList(profile.avoidRules));
    const territoriesHtml = detailSection("Content Territories", bulletList(profile.contentTerritories));
    const weakHtml = detailSection("Weak-Fit Territories", bulletList(profile.weakFitTerritories));

    const excerpts = Array.isArray(profile.sampleExcerpts) ? profile.sampleExcerpts : [];
    const excerptsContent = excerpts.length > 0
      ? `<ol>${excerpts.map((e: unknown) => `<li><blockquote>${escapeHtml(String(e))}</blockquote></li>`).join("")}</ol>`
      : "<p>—</p>";
    const excerptsHtml = detailSection(
      "Sample Excerpts",
      excerpts.length > 3 ? collapsible(`${excerpts.length} excerpts`, excerptsContent) : excerptsContent
    );

    const extraHtml = Object.keys(extraKeys).length > 0
      ? collapsible("Additional profile fields", jsonViewer(extraKeys))
      : "";

    const oppCount = user._count.ownedOpportunities;
    const oppHtml = detailSection(
      "Owned Opportunities",
      `<p>${oppCount} opportunit${oppCount === 1 ? "y" : "ies"}</p>`
    );

    const html = layout(
      escapeHtml(user.displayName),
      backHtml + headerHtml + toneHtml + structureHtml + phrasesHtml + avoidHtml +
      territoriesHtml + weakHtml + excerptsHtml + extraHtml + oppHtml,
      company.name,
      companySlug
    );
    return reply.type("text/html").send(html);
  });
}
