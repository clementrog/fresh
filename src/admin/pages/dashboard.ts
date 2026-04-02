import type { FastifyInstance } from "fastify";

import type { AdminQueries } from "../queries.js";
import type { ResolvedCompany } from "../plugin.js";
import { layout } from "../layout.js";
import { statCard, table, linkTo, formatDate, sourceBadge, withCompany } from "../components.js";

export function registerDashboard(
  server: FastifyInstance,
  queries: AdminQueries,
  resolveCompany: (query: Record<string, string>) => Promise<ResolvedCompany | null>
) {
  server.get("/admin", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const c = (path: string) => withCompany(path, companySlug);

    const [counts, recentRuns] = await Promise.all([
      queries.getDashboardCounts(company.id),
      queries.getRecentRuns(company.id)
    ]);

    const statsHtml = `<div class="stat-grid">
      ${statCard("Source Items", counts.sourceItems)}
      ${statCard("Opportunities", counts.opportunities)}
      <a href="${c("/admin/drafts")}" style="text-decoration:none;color:inherit">${statCard("Drafts", counts.drafts)}</a>
      ${statCard("Runs", counts.runs)}
      ${statCard("Users", counts.users)}
    </div>`;

    const dispositionHtml = `<div class="detail-section"><h2>Disposition Breakdown</h2>
      <div class="stat-grid">
        ${statCard("Screened Out", counts.screenedOut)}
        ${statCard("Blocked", counts.blocked)}
        ${statCard("Orphaned", counts.orphaned)}
      </div>
      <p>
        ${linkTo(c("/admin/source-items?disposition=screened-out"), "View screened-out")} ·
        ${linkTo(c("/admin/source-items?disposition=blocked"), "View blocked")} ·
        ${linkTo(c("/admin/source-items?disposition=orphaned"), "View orphaned")}
      </p>
    </div>`;

    const runRows = recentRuns.map((r) => [
      linkTo(c("/admin/runs"), r.runType),
      r.source ? sourceBadge(r.source) : "—",
      r.status,
      formatDate(r.startedAt),
      formatDate(r.finishedAt)
    ]);
    const runsHtml = `<div class="detail-section"><h2>Recent Runs</h2>
      ${table(["Type", "Source", "Status", "Started", "Finished"], runRows)}
    </div>`;

    const html = layout("Dashboard", statsHtml + dispositionHtml + runsHtml, company.name, companySlug);
    return reply.type("text/html").send(html);
  });
}
