import type { FastifyInstance } from "fastify";

import type { AdminQueries } from "../queries.js";
import type { ResolvedCompany } from "../plugin.js";
import { layout } from "../layout.js";
import { table, pagination, badge, formatDate, linkTo, withCompany, buildDetailUrl } from "../components.js";

export function registerReviewPages(
  server: FastifyInstance,
  queries: AdminQueries,
  resolveCompany: (query: Record<string, string>) => Promise<ResolvedCompany | null>
) {
  server.get("/admin/reviews/claap", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
    const returnTo = request.url;

    const [total, items] = await Promise.all([
      queries.countClaapReviewItems(company.id),
      queries.listClaapReviewItems(company.id, { page, pageSize: 50 })
    ]);

    const totalPages = Math.ceil(total / 50);

    const rows = items.map((item) => {
      const meta = item.metadataJson as Record<string, unknown>;
      const risk = String(meta.publishabilityRisk ?? "unknown");
      const riskColor = risk === "safe" ? "green" : risk === "harmful" ? "red" : "orange";
      return [
        linkTo(buildDetailUrl(`/admin/source-items/${item.id}`, companySlug, returnTo), truncate(item.title, 60)),
        badge(risk, riskColor as "green" | "red" | "orange"),
        meta.reframingSuggestion ? truncate(String(meta.reframingSuggestion), 60) : "—",
        item.processedAt ? badge("yes", "green") : badge("no", "gray"),
        formatDate(item.occurredAt)
      ];
    });

    const tableHtml = table(["Title", "Risk", "Reframing", "Processed", "Occurred"], rows);
    const paginationHtml = pagination(page, totalPages, withCompany("/admin/reviews/claap", companySlug));

    const html = layout(
      `Claap Review (${total})`,
      tableHtml + paginationHtml,
      company.name,
      companySlug
    );
    return reply.type("text/html").send(html);
  });

  server.get("/admin/reviews/linear", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
    const returnTo = request.url;

    const [total, items] = await Promise.all([
      queries.countLinearReviewItems(company.id),
      queries.listLinearReviewItems(company.id, { page, pageSize: 50 })
    ]);

    const totalPages = Math.ceil(total / 50);

    const rows = items.map((item) => {
      const meta = item.metadataJson as Record<string, unknown>;
      const cls = String(meta.linearEnrichmentClassification ?? "unknown");
      const clsColor = cls === "enrich-worthy" ? "green" : cls === "ignore" ? "gray" : "orange";
      return [
        linkTo(buildDetailUrl(`/admin/source-items/${item.id}`, companySlug, returnTo), truncate(item.title, 60)),
        badge(cls, clsColor as "green" | "gray" | "orange"),
        meta.linearCustomerVisibility ? String(meta.linearCustomerVisibility) : "—",
        meta.linearSensitivityLevel ? String(meta.linearSensitivityLevel) : "—",
        item.processedAt ? badge("yes", "green") : badge("no", "gray"),
        formatDate(item.occurredAt)
      ];
    });

    const tableHtml = table(
      ["Title", "Classification", "Visibility", "Sensitivity", "Processed", "Occurred"],
      rows
    );
    const paginationHtml = pagination(page, totalPages, withCompany("/admin/reviews/linear", companySlug));

    const html = layout(
      `Linear Review (${total})`,
      tableHtml + paginationHtml,
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
