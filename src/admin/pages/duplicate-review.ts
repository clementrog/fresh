import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

import type { AdminQueries } from "../queries.js";
import type { ResolvedCompany } from "../plugin.js";
import { computeTopicalScore } from "../queries.js";
import { executeDuplicateReview, validateDecisions, type ClusterDecision } from "../duplicate-actions.js";
import { layout, escapeHtml } from "../layout.js";
import {
  table,
  badge,
  statusBadge,
  formatDate,
  linkTo,
  detailSection,
  withCompany,
  backLink
} from "../components.js";

export function registerDuplicateReviewPages(
  server: FastifyInstance,
  queries: AdminQueries,
  prisma: PrismaClient,
  resolveCompany: (query: Record<string, string>) => Promise<ResolvedCompany | null>
) {
  // ── List page: pending duplicate clusters ──────────────────────────

  server.get("/admin/reviews/duplicates", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const success = query.success === "1";

    // Detect clusters and upsert pending ones
    const detected = await queries.detectDuplicateClusters(company.id);

    // Upsert any new clusters as pending
    for (const cluster of detected) {
      if (!cluster.existingClusterId) {
        await queries.upsertPendingCluster(company.id, cluster.memberIds, cluster.suppressionHash);
      }
    }

    // Reload all pending clusters (includes newly created)
    const pending = await queries.listPendingClusters(company.id);

    // Load member titles for display
    const allMemberIds = [...new Set(pending.flatMap((c) => c.memberIds))];
    const members = allMemberIds.length > 0
      ? await prisma.opportunity.findMany({
          where: { id: { in: allMemberIds } },
          select: { id: true, title: true, ownerProfile: true, status: true }
        })
      : [];
    const memberMap = new Map(members.map((m) => [m.id, m]));

    const successBanner = success
      ? `<div style="background:#e8f5e9;padding:10px 16px;border-radius:4px;margin-bottom:16px;color:#2e7d32;font-weight:600;">Review saved successfully.</div>`
      : "";

    const rows = pending.map((cluster) => {
      const memberTitles = cluster.memberIds
        .map((id) => memberMap.get(id)?.title ?? id)
        .map((t) => truncate(t, 40))
        .join(", ");
      return [
        linkTo(
          withCompany(`/admin/reviews/duplicates/${cluster.id}`, companySlug),
          `${cluster.memberIds.length} opportunities`
        ),
        memberTitles,
        formatDate(cluster.createdAt)
      ];
    });

    const tableHtml = table(["Cluster", "Members", "Detected"], rows);

    const html = layout(
      `Duplicate Review (${pending.length} pending)`,
      successBanner + tableHtml,
      company.name,
      companySlug
    );
    return reply.type("text/html").send(html);
  });

  // ── Detail page: cluster review form ───────────────────────────────

  server.get<{ Params: { id: string } }>("/admin/reviews/duplicates/:id", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const cluster = await queries.getClusterById(request.params.id);
    if (!cluster || cluster.companyId !== company.id) {
      return reply.code(404).type("text/html").send(
        layout("Not Found", `<p>Cluster not found.</p>`, company.name, companySlug)
      );
    }

    const isReviewed = cluster.status === "reviewed";
    const decisions = (isReviewed ? cluster.decisionsJson : {}) as Record<string, string>;

    // Load full opportunity details for each member
    const members = await prisma.opportunity.findMany({
      where: { id: { in: cluster.memberIds } },
      include: {
        evidence: {
          select: {
            id: true,
            source: true,
            excerpt: true,
            sourceItemId: true,
            timestamp: true,
            speakerOrAuthor: true
          }
        },
        linkedEvidence: {
          include: {
            evidence: {
              select: {
                id: true,
                source: true,
                excerpt: true,
                sourceItemId: true,
                timestamp: true,
                speakerOrAuthor: true
              }
            }
          }
        },
        ownerUser: { select: { displayName: true } }
      }
    });

    // Compute topical scores between pairs
    const scoreMap = new Map<string, number>();
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const score = computeTopicalScore(
          members[i].title, members[i].angle,
          members[j].title, members[j].angle
        );
        scoreMap.set(`${members[i].id}|${members[j].id}`, score);
      }
    }

    const backHtml = backLink(withCompany("/admin/reviews/duplicates", companySlug));

    const statusHtml = isReviewed
      ? `<div style="background:#e3f2fd;padding:10px 16px;border-radius:4px;margin-bottom:16px;">
           ${badge("reviewed", "blue")} by ${escapeHtml(cluster.reviewedBy ?? "unknown")} on ${formatDate(cluster.reviewedAt)}
         </div>`
      : "";

    // Topical similarity summary
    const scoreEntries = [...scoreMap.entries()];
    const topScore = scoreEntries.length > 0
      ? Math.max(...scoreEntries.map(([, s]) => s))
      : 0;
    const similarityHtml = `<p style="margin-bottom:16px;">Top topical similarity: <strong>${(topScore * 100).toFixed(0)}%</strong> · ${members.length} members</p>`;

    // Build member cards
    const memberCards = members.map((m) => {
      const allEvidence = [
        ...m.evidence.map((e) => ({
          id: e.id,
          source: e.source,
          excerpt: e.excerpt,
          sourceItemId: e.sourceItemId,
          timestamp: e.timestamp,
          speakerOrAuthor: e.speakerOrAuthor
        })),
        ...m.linkedEvidence.map((le) => ({
          id: le.evidence.id,
          source: le.evidence.source,
          excerpt: le.evidence.excerpt,
          sourceItemId: le.evidence.sourceItemId,
          timestamp: le.evidence.timestamp,
          speakerOrAuthor: le.evidence.speakerOrAuthor
        }))
      ];

      const evidenceRows = allEvidence.slice(0, 5).map((e) => [
        truncate(e.excerpt, 80),
        e.source,
        e.speakerOrAuthor ?? "—",
        formatDate(e.timestamp)
      ]);

      const evidenceTable = table(["Excerpt", "Source", "Speaker", "Date"], evidenceRows);
      const moreCount = allEvidence.length > 5 ? allEvidence.length - 5 : 0;
      const moreHtml = moreCount > 0 ? `<p style="color:#666;font-size:12px;">+ ${moreCount} more</p>` : "";

      const decisionValue = decisions[m.id] ?? "";
      const radioHtml = isReviewed
        ? `<p>Decision: ${badge(decisionValue, decisionValue === "canonical" ? "green" : decisionValue === "archive" ? "red" : "blue")}</p>`
        : `<div style="margin-top:10px;display:flex;gap:16px;">
             <label><input type="radio" name="decisions[${escapeHtml(m.id)}]" value="canonical" required> Canonical</label>
             <label><input type="radio" name="decisions[${escapeHtml(m.id)}]" value="archive"> Archive</label>
             <label><input type="radio" name="decisions[${escapeHtml(m.id)}]" value="keep-separate"> Keep separate</label>
           </div>`;

      return detailSection(
        escapeHtml(truncate(m.title, 70)),
        `<p>${statusBadge(m.status)} · Owner: ${escapeHtml(m.ownerUser?.displayName ?? m.ownerProfile ?? "—")} · Evidence: ${allEvidence.length} · Created: ${formatDate(m.createdAt)}</p>
         <p><strong>Angle:</strong> ${escapeHtml(m.angle)}</p>
         <p><strong>Why Now:</strong> ${escapeHtml(m.whyNow)}</p>
         ${m.editorialClaim ? `<p><strong>Claim:</strong> ${escapeHtml(m.editorialClaim)}</p>` : ""}
         <p><strong>ID:</strong> <code>${escapeHtml(m.id)}</code></p>
         ${evidenceTable}${moreHtml}
         ${radioHtml}`
      );
    }).join("");

    const formOpen = isReviewed
      ? ""
      : `<form method="POST" action="${escapeHtml(withCompany("/admin/reviews/duplicates/action", companySlug))}">
           <input type="hidden" name="clusterId" value="${escapeHtml(cluster.id)}">`;
    const formClose = isReviewed
      ? ""
      : `<div style="margin-top:16px;">
           <button type="submit" style="padding:8px 20px;background:#1a1a1a;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;">Submit Review</button>
         </div></form>`;

    const html = layout(
      `Duplicate Cluster`,
      backHtml + statusHtml + similarityHtml + formOpen + memberCards + formClose,
      company.name,
      companySlug
    );
    return reply.type("text/html").send(html);
  });

  // ── POST action handler ────────────────────────────────────────────

  server.post("/admin/reviews/duplicates/action", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const company = await resolveCompany(query);
    if (!company) {
      return reply.code(404).type("text/html").send(layout("Not Found", `<p>Company not found.</p>`));
    }

    const companySlug = query.company || undefined;
    const body = request.body as Record<string, unknown>;
    const clusterId = String(body.clusterId ?? "");

    // Parse decisions from form body
    const decisions: Record<string, ClusterDecision> = {};
    const decisionsRaw = (body.decisions ?? {}) as Record<string, string>;
    for (const [oppId, decision] of Object.entries(decisionsRaw)) {
      if (decision === "canonical" || decision === "archive" || decision === "keep-separate") {
        decisions[oppId] = decision;
      }
    }

    // Extract reviewer from Basic Auth
    const authHeader = request.headers.authorization ?? "";
    let reviewedBy = "admin";
    if (authHeader.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
      reviewedBy = decoded.split(":")[0] || "admin";
    }

    try {
      await executeDuplicateReview(prisma, {
        clusterId,
        decisions,
        reviewedBy
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const html = layout(
        "Review Error",
        `<div style="background:#ffebee;padding:10px 16px;border-radius:4px;color:#c62828;">
           <strong>Error:</strong> ${escapeHtml(message)}
         </div>
         <p><a href="${escapeHtml(withCompany(`/admin/reviews/duplicates/${clusterId}`, companySlug))}">&laquo; Back to cluster</a></p>`,
        company.name,
        companySlug
      );
      return reply.code(400).type("text/html").send(html);
    }

    const redirectBase = withCompany("/admin/reviews/duplicates", companySlug);
    const separator = redirectBase.includes("?") ? "&" : "?";
    return reply.redirect(redirectBase + separator + "success=1");
  });
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}
