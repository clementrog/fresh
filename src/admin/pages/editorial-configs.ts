import type { FastifyInstance } from "fastify";

import type { AdminQueries } from "../queries.js";
import type { ResolvedCompany } from "../plugin.js";
import { layout, escapeHtml } from "../layout.js";
import {
  table,
  badge,
  formatDate,
  linkTo,
  detailSection,
  jsonViewer,
  collapsible,
  bulletList,
  withCompany,
  buildDetailUrl,
  backLink
} from "../components.js";

export function registerEditorialConfigPages(
  server: FastifyInstance,
  queries: AdminQueries,
  resolveCompany: (query: Record<string, string>) => Promise<ResolvedCompany | null>
) {
  server.get("/admin/editorial-configs", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const returnTo = request.url;

    const configs = await queries.listEditorialConfigs(company.id);

    const latestVersion = configs.length > 0 ? Math.max(...configs.map((c) => c.version)) : -1;

    const rows = configs.map((c) => [
      linkTo(
        buildDetailUrl(`/admin/editorial-configs/${c.id}`, companySlug, returnTo),
        `v${c.version}`
      ),
      c.version === latestVersion ? badge("latest", "green") : badge("older", "gray"),
      formatDate(c.createdAt)
    ]);

    const tableHtml = table(["Version", "Status", "Created"], rows);

    const html = layout(
      `Editorial Config (${configs.length})`,
      tableHtml,
      company.name,
      companySlug
    );
    return reply.type("text/html").send(html);
  });

  server.get<{ Params: { id: string } }>("/admin/editorial-configs/:id", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const returnTo = query.returnTo || undefined;

    const config = await queries.getEditorialConfig(request.params.id);
    if (!config || config.companyId !== company.id) {
      return reply
        .code(404)
        .type("text/html")
        .send(layout("Not Found", `<p>Editorial config not found.</p>`, company.name, companySlug));
    }

    const backHtml = backLink(returnTo);

    const headerHtml = `<p>${badge(`v${config.version}`, "blue")} · Created: ${formatDate(config.createdAt)}</p>`;

    // Layer 1: Company Lens
    const l1 = config.layer1CompanyLens as Record<string, unknown> | null;
    const doctrineMarkdown = (l1?.doctrineMarkdown as string) ?? "";
    const sensitivityMarkdown = (l1?.sensitivityMarkdown as string) ?? "";
    const l1KnownKeys = new Set(["doctrineMarkdown", "sensitivityMarkdown"]);
    const l1Extra = l1 ? Object.fromEntries(Object.entries(l1).filter(([k]) => !l1KnownKeys.has(k))) : {};

    const doctrineHtml = detailSection(
      "Company Doctrine",
      doctrineMarkdown
        ? `<pre style="white-space:pre-wrap">${escapeHtml(doctrineMarkdown)}</pre>`
        : "<p>—</p>"
    );

    const sensitivityHtml = detailSection(
      "Sensitivity Rules",
      sensitivityMarkdown
        ? `<pre style="white-space:pre-wrap">${escapeHtml(sensitivityMarkdown)}</pre>`
        : "<p>—</p>"
    );

    const l1ExtraHtml = Object.keys(l1Extra).length > 0
      ? collapsible("Additional Layer 1 fields", jsonViewer(l1Extra))
      : "";

    // Layer 2: Content Philosophy
    const l2 = config.layer2ContentPhilosophy as Record<string, unknown> | null;
    const l2Defaults = l2?.defaults;
    const l2KnownKeys = new Set(["defaults"]);
    const l2Extra = l2 ? Object.fromEntries(Object.entries(l2).filter(([k]) => !l2KnownKeys.has(k))) : {};

    const philosophyHtml = detailSection("Content Philosophy", bulletList(l2Defaults));
    const l2ExtraHtml = Object.keys(l2Extra).length > 0
      ? collapsible("Additional Layer 2 fields", jsonViewer(l2Extra))
      : "";

    // Layer 3: LinkedIn Craft
    const l3 = config.layer3LinkedInCraft as Record<string, unknown> | null;
    const l3Defaults = l3?.defaults;
    const l3KnownKeys = new Set(["defaults"]);
    const l3Extra = l3 ? Object.fromEntries(Object.entries(l3).filter(([k]) => !l3KnownKeys.has(k))) : {};

    const craftHtml = detailSection("LinkedIn Craft Rules", bulletList(l3Defaults));
    const l3ExtraHtml = Object.keys(l3Extra).length > 0
      ? collapsible("Additional Layer 3 fields", jsonViewer(l3Extra))
      : "";

    const html = layout(
      `Editorial Config v${config.version}`,
      backHtml + headerHtml + doctrineHtml + sensitivityHtml + l1ExtraHtml +
      philosophyHtml + l2ExtraHtml + craftHtml + l3ExtraHtml,
      company.name,
      companySlug
    );
    return reply.type("text/html").send(html);
  });
}
