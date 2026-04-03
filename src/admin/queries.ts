import { Prisma, type PrismaClient } from "@prisma/client";
import { createDeterministicId, createId } from "../lib/ids.js";
import { jaccardSimilarity, removeStopWords, tokenizeV2 } from "../lib/text.js";

interface AdminPagination {
  page: number;
  pageSize: number;
}

export type Disposition = "screened-out" | "blocked" | "orphaned";

interface AdminSourceItemFilters {
  source?: string;
  screening?: "skip" | "retain";
  processed?: "yes" | "no";
  disposition?: Disposition;
  q?: string;
}

interface AdminOpportunityFilters {
  status?: string;
  readiness?: string;
  q?: string;
}

interface AdminRunFilters {
  runType?: string;
}

export interface AdminMarketQueryFilters {
  enabled?: "yes" | "no";
}

export interface AdminDraftFilters {
  profileId?: string;
  q?: string;
}

// NOT with a JSON path that evaluates to NULL in PostgreSQL produces NOT(NULL)=NULL,
// which silently excludes the row.  Guard each NOT element with a DbNull existence
// check so the condition is FALSE (not NULL) when the path is absent.
const SCREENED_OUT_GUARD: Prisma.SourceItemWhereInput = {
  AND: [
    { screeningResultJson: { path: ["decision"], not: Prisma.DbNull } },
    { screeningResultJson: { path: ["decision"], equals: "skip" } }
  ]
};
const HARMFUL_GUARD: Prisma.SourceItemWhereInput = {
  AND: [
    { metadataJson: { path: ["publishabilityRisk"], not: Prisma.DbNull } },
    { metadataJson: { path: ["publishabilityRisk"], equals: "harmful" } }
  ]
};
const REFRAMEABLE_GUARD: Prisma.SourceItemWhereInput = {
  AND: [
    { metadataJson: { path: ["publishabilityRisk"], not: Prisma.DbNull } },
    { metadataJson: { path: ["publishabilityRisk"], equals: "reframeable" } }
  ]
};

export const DISPOSITION_CLAUSES: Record<Disposition, Prisma.SourceItemWhereInput> = {
  "screened-out": {
    screeningResultJson: { path: ["decision"], equals: "skip" }
  },
  blocked: {
    OR: [
      { metadataJson: { path: ["publishabilityRisk"], equals: "harmful" } },
      { metadataJson: { path: ["publishabilityRisk"], equals: "reframeable" } }
    ]
  },
  orphaned: {
    processedAt: { not: null },
    evidenceReferences: {
      every: {
        opportunityId: null,
        opportunityLinks: { none: {} },
        primaryForOpportunities: { none: {} }
      }
    },
    NOT: [SCREENED_OUT_GUARD, HARMFUL_GUARD, REFRAMEABLE_GUARD]
  }
};

function buildSourceItemWhere(
  companyId: string,
  filters: AdminSourceItemFilters
): Prisma.SourceItemWhereInput {
  const where: Prisma.SourceItemWhereInput = { companyId };

  if (filters.source) {
    where.source = filters.source;
  }
  if (filters.screening === "skip") {
    where.screeningResultJson = { path: ["decision"], equals: "skip" };
  } else if (filters.screening === "retain") {
    where.screeningResultJson = { path: ["decision"], equals: "retain" };
  }
  if (filters.processed === "yes") {
    where.processedAt = { not: null };
  } else if (filters.processed === "no") {
    where.processedAt = null;
  }
  if (filters.q) {
    where.title = { contains: filters.q, mode: "insensitive" };
  }
  if (filters.disposition) {
    Object.assign(where, DISPOSITION_CLAUSES[filters.disposition]);
  }

  return where;
}

function buildOpportunityWhere(
  companyId: string,
  filters: AdminOpportunityFilters
): Prisma.OpportunityWhereInput {
  const where: Prisma.OpportunityWhereInput = { companyId };

  if (filters.status) {
    where.status = filters.status;
  }
  if (filters.readiness) {
    where.readiness = filters.readiness;
  }
  if (filters.q) {
    where.title = { contains: filters.q, mode: "insensitive" };
  }

  return where;
}

export class AdminQueries {
  constructor(private prisma: PrismaClient) {}

  async getCompanyBySlug(slug: string) {
    return this.prisma.company.findUnique({
      where: { slug },
      select: { id: true, slug: true, name: true }
    });
  }

  async countSourceItems(companyId: string, filters: AdminSourceItemFilters = {}): Promise<number> {
    return this.prisma.sourceItem.count({
      where: buildSourceItemWhere(companyId, filters)
    });
  }

  async listSourceItems(
    companyId: string,
    filters: AdminSourceItemFilters = {},
    { page, pageSize }: AdminPagination = { page: 1, pageSize: 50 }
  ) {
    return this.prisma.sourceItem.findMany({
      where: buildSourceItemWhere(companyId, filters),
      orderBy: { occurredAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        source: true,
        title: true,
        occurredAt: true,
        processedAt: true,
        notionPageId: true,
        screeningResultJson: true,
        metadataJson: true
      }
    });
  }

  async getSourceItem(id: string) {
    return this.prisma.sourceItem.findUnique({
      where: { id },
      include: {
        evidenceReferences: {
          include: {
            opportunity: { select: { id: true, title: true } },
            opportunityLinks: { select: { opportunityId: true } },
            primaryForOpportunities: { select: { id: true, title: true } }
          }
        }
      }
    });
  }

  async countOpportunities(companyId: string, filters: AdminOpportunityFilters = {}): Promise<number> {
    return this.prisma.opportunity.count({
      where: buildOpportunityWhere(companyId, filters)
    });
  }

  async listOpportunities(
    companyId: string,
    filters: AdminOpportunityFilters = {},
    { page, pageSize }: AdminPagination = { page: 1, pageSize: 50 }
  ) {
    return this.prisma.opportunity.findMany({
      where: buildOpportunityWhere(companyId, filters),
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        title: true,
        status: true,
        readiness: true,
        ownerProfile: true,
        supportingEvidenceCount: true,
        notionPageId: true,
        updatedAt: true
      }
    });
  }

  async getOpportunity(id: string) {
    return this.prisma.opportunity.findUnique({
      where: { id },
      include: {
        primaryEvidence: true,
        evidence: {
          select: {
            id: true,
            source: true,
            excerpt: true,
            timestamp: true,
            speakerOrAuthor: true,
            sourceUrl: true
          }
        },
        linkedEvidence: {
          include: {
            evidence: {
              select: {
                id: true,
                source: true,
                excerpt: true,
                timestamp: true,
                speakerOrAuthor: true
              }
            }
          }
        },
        drafts: {
          select: {
            id: true,
            profileId: true,
            proposedTitle: true,
            confidenceScore: true,
            createdAt: true
          }
        },
        ownerUser: { select: { id: true, displayName: true } }
      }
    });
  }

  async listClaapReviewItems(
    companyId: string,
    { page, pageSize }: AdminPagination = { page: 1, pageSize: 50 }
  ) {
    return this.prisma.sourceItem.findMany({
      where: {
        companyId,
        source: "claap",
        metadataJson: { path: ["publishabilityRisk"], not: Prisma.DbNull }
      },
      orderBy: { occurredAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        title: true,
        occurredAt: true,
        metadataJson: true,
        processedAt: true
      }
    });
  }

  async countClaapReviewItems(companyId: string): Promise<number> {
    return this.prisma.sourceItem.count({
      where: {
        companyId,
        source: "claap",
        metadataJson: { path: ["publishabilityRisk"], not: Prisma.DbNull }
      }
    });
  }

  async listLinearReviewItems(
    companyId: string,
    { page, pageSize }: AdminPagination = { page: 1, pageSize: 50 }
  ) {
    return this.prisma.sourceItem.findMany({
      where: {
        companyId,
        source: "linear",
        metadataJson: { path: ["linearEnrichmentClassification"], equals: "manual-review-needed" }
      },
      orderBy: { occurredAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        title: true,
        occurredAt: true,
        metadataJson: true,
        processedAt: true
      }
    });
  }

  async countLinearReviewItems(companyId: string): Promise<number> {
    return this.prisma.sourceItem.count({
      where: {
        companyId,
        source: "linear",
        metadataJson: { path: ["linearEnrichmentClassification"], equals: "manual-review-needed" }
      }
    });
  }

  async listGitHubReviewItems(
    companyId: string,
    { page, pageSize }: AdminPagination = { page: 1, pageSize: 50 }
  ) {
    return this.prisma.sourceItem.findMany({
      where: {
        companyId,
        source: "github",
        AND: [
          { metadataJson: { path: ["githubEnrichmentClassification"], equals: "manual-review" } },
          { NOT: { metadataJson: { path: ["scopeExcluded"], equals: true } } }
        ]
      },
      orderBy: { occurredAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        title: true,
        occurredAt: true,
        metadataJson: true,
        processedAt: true
      }
    });
  }

  async countGitHubReviewItems(companyId: string): Promise<number> {
    return this.prisma.sourceItem.count({
      where: {
        companyId,
        source: "github",
        AND: [
          { metadataJson: { path: ["githubEnrichmentClassification"], equals: "manual-review" } },
          { NOT: { metadataJson: { path: ["scopeExcluded"], equals: true } } }
        ]
      }
    });
  }

  async listRuns(
    companyId: string,
    filters: AdminRunFilters = {},
    { page, pageSize }: AdminPagination = { page: 1, pageSize: 50 }
  ) {
    const where: Prisma.SyncRunWhereInput = { companyId };
    if (filters.runType) {
      where.runType = filters.runType;
    }
    return this.prisma.syncRun.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        runType: true,
        source: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        countersJson: true,
        warningsJson: true,
        notes: true
      }
    });
  }

  async countRuns(companyId: string, filters: AdminRunFilters = {}): Promise<number> {
    const where: Prisma.SyncRunWhereInput = { companyId };
    if (filters.runType) {
      where.runType = filters.runType;
    }
    return this.prisma.syncRun.count({ where });
  }

  async listUsers(companyId: string) {
    return this.prisma.user.findMany({
      where: { companyId },
      orderBy: { displayName: "asc" },
      select: {
        id: true,
        displayName: true,
        type: true,
        language: true,
        createdAt: true
      }
    });
  }

  async listEditorialConfigs(companyId: string) {
    return this.prisma.editorialConfig.findMany({
      where: { companyId },
      orderBy: { version: "desc" },
      select: { id: true, version: true, createdAt: true }
    });
  }

  async getEditorialConfig(id: string) {
    return this.prisma.editorialConfig.findUnique({
      where: { id }
    });
  }

  async getUser(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { ownedOpportunities: true } } }
    });
  }

  async listSourceConfigs(companyId: string) {
    return this.prisma.sourceConfig.findMany({
      where: { companyId },
      orderBy: { source: "asc" }
    });
  }

  async listMarketQueries(
    companyId: string,
    filters: AdminMarketQueryFilters = {},
    { page, pageSize }: AdminPagination = { page: 1, pageSize: 50 }
  ) {
    const where: Prisma.MarketQueryWhereInput = { companyId };
    if (filters.enabled === "yes") where.enabled = true;
    else if (filters.enabled === "no") where.enabled = false;

    return this.prisma.marketQuery.findMany({
      where,
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize
    });
  }

  async countMarketQueries(
    companyId: string,
    filters: AdminMarketQueryFilters = {}
  ): Promise<number> {
    const where: Prisma.MarketQueryWhereInput = { companyId };
    if (filters.enabled === "yes") where.enabled = true;
    else if (filters.enabled === "no") where.enabled = false;

    return this.prisma.marketQuery.count({ where });
  }

  async listDraftProfileIds(companyId: string): Promise<string[]> {
    const rows = await this.prisma.draft.findMany({
      where: { companyId },
      select: { profileId: true },
      distinct: ["profileId"],
      orderBy: { profileId: "asc" }
    });
    return rows.map((r) => r.profileId);
  }

  async listDrafts(
    companyId: string,
    filters: AdminDraftFilters = {},
    { page, pageSize }: AdminPagination = { page: 1, pageSize: 50 }
  ) {
    const where: Prisma.DraftWhereInput = { companyId };
    if (filters.profileId) where.profileId = filters.profileId;
    if (filters.q) where.proposedTitle = { contains: filters.q, mode: "insensitive" };

    return this.prisma.draft.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        proposedTitle: true,
        profileId: true,
        confidenceScore: true,
        language: true,
        createdAt: true,
        opportunity: { select: { id: true, title: true } }
      }
    });
  }

  async countDrafts(
    companyId: string,
    filters: AdminDraftFilters = {}
  ): Promise<number> {
    const where: Prisma.DraftWhereInput = { companyId };
    if (filters.profileId) where.profileId = filters.profileId;
    if (filters.q) where.proposedTitle = { contains: filters.q, mode: "insensitive" };

    return this.prisma.draft.count({ where });
  }

  async getDraft(id: string) {
    return this.prisma.draft.findUnique({
      where: { id },
      include: {
        opportunity: { select: { id: true, title: true, status: true } },
        evidence: {
          select: {
            id: true,
            source: true,
            excerpt: true,
            timestamp: true,
            speakerOrAuthor: true,
            sourceUrl: true
          }
        }
      }
    });
  }

  async getRun(id: string) {
    return this.prisma.syncRun.findUnique({
      where: { id },
      include: {
        costEntries: { orderBy: { createdAt: "asc" } }
      }
    });
  }

  async getDashboardCounts(companyId: string) {
    const [
      sourceItems,
      opportunities,
      drafts,
      runs,
      users,
      screenedOut,
      blocked,
      orphaned
    ] = await Promise.all([
      this.prisma.sourceItem.count({ where: { companyId } }),
      this.prisma.opportunity.count({ where: { companyId } }),
      this.prisma.draft.count({ where: { companyId } }),
      this.prisma.syncRun.count({ where: { companyId } }),
      this.prisma.user.count({ where: { companyId } }),
      this.prisma.sourceItem.count({
        where: { companyId, ...DISPOSITION_CLAUSES["screened-out"] }
      }),
      this.prisma.sourceItem.count({
        where: { companyId, ...DISPOSITION_CLAUSES.blocked }
      }),
      this.prisma.sourceItem.count({
        where: { companyId, ...DISPOSITION_CLAUSES.orphaned }
      })
    ]);

    return { sourceItems, opportunities, drafts, runs, users, screenedOut, blocked, orphaned };
  }

  async getRecentRuns(companyId: string, limit = 10) {
    return this.prisma.syncRun.findMany({
      where: { companyId },
      orderBy: { startedAt: "desc" },
      take: limit,
      select: {
        id: true,
        runType: true,
        source: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        countersJson: true
      }
    });
  }

  // ── Duplicate cluster detection & management ────────────────────────

  async detectDuplicateClusters(companyId: string) {
    // Phase 1: Find opportunity pairs sharing a sourceItemId via evidence
    const pairs = await this.prisma.$queryRaw<
      Array<{ opp_a: string; opp_b: string; source_item_id: string }>
    >`
      SELECT DISTINCT
        e1."opportunityId" AS opp_a,
        e2."opportunityId" AS opp_b,
        e1."sourceItemId"  AS source_item_id
      FROM "EvidenceReference" e1
      JOIN "EvidenceReference" e2
        ON e1."sourceItemId" = e2."sourceItemId"
        AND e1."opportunityId" < e2."opportunityId"
      JOIN "Opportunity" o1 ON o1."id" = e1."opportunityId"
        AND o1."companyId" = ${companyId}
        AND o1."status" NOT IN ('Archived', 'Rejected')
      JOIN "Opportunity" o2 ON o2."id" = e2."opportunityId"
        AND o2."companyId" = ${companyId}
        AND o2."status" NOT IN ('Archived', 'Rejected')
      WHERE e1."opportunityId" IS NOT NULL
        AND e2."opportunityId" IS NOT NULL
    `;

    // Also check junction table paths
    const junctionPairs = await this.prisma.$queryRaw<
      Array<{ opp_a: string; opp_b: string; source_item_id: string }>
    >`
      SELECT DISTINCT
        oe1."opportunityId" AS opp_a,
        oe2."opportunityId" AS opp_b,
        er1."sourceItemId"  AS source_item_id
      FROM "OpportunityEvidence" oe1
      JOIN "EvidenceReference" er1 ON oe1."evidenceId" = er1."id"
      JOIN "EvidenceReference" er2 ON er1."sourceItemId" = er2."sourceItemId"
      JOIN "OpportunityEvidence" oe2 ON oe2."evidenceId" = er2."id"
        AND oe1."opportunityId" < oe2."opportunityId"
      JOIN "Opportunity" o1 ON o1."id" = oe1."opportunityId"
        AND o1."companyId" = ${companyId}
        AND o1."status" NOT IN ('Archived', 'Rejected')
      JOIN "Opportunity" o2 ON o2."id" = oe2."opportunityId"
        AND o2."companyId" = ${companyId}
        AND o2."status" NOT IN ('Archived', 'Rejected')
    `;

    // Merge all pairs
    const allPairs = [...pairs, ...junctionPairs];
    const pairSet = new Map<string, Set<string>>();
    for (const { opp_a, opp_b, source_item_id } of allPairs) {
      const key = [opp_a, opp_b].sort().join("|");
      if (!pairSet.has(key)) pairSet.set(key, new Set());
      pairSet.get(key)!.add(source_item_id);
    }

    // Phase 2: Transitive closure via union-find
    const clusters = buildClustersFromPairs(
      [...pairSet.keys()].map((k) => k.split("|") as [string, string])
    );

    // Phase 3: Suppression filter — exclude clusters already reviewed
    const reviewedClusters = await this.prisma.duplicateCluster.findMany({
      where: { companyId, status: "reviewed" },
      select: { suppressionHash: true }
    });
    const suppressedHashes = new Set(reviewedClusters.map((c) => c.suppressionHash));

    // Phase 4: Check for existing pending clusters
    const pendingClusters = await this.prisma.duplicateCluster.findMany({
      where: { companyId, status: "pending" },
      select: { id: true, suppressionHash: true, memberIds: true }
    });
    const pendingByHash = new Map(pendingClusters.map((c) => [c.suppressionHash, c]));

    // Build output
    const result: Array<{
      memberIds: string[];
      suppressionHash: string;
      existingClusterId: string | null;
      sharedSourceItems: Map<string, Set<string>>;
    }> = [];

    for (const memberIds of clusters) {
      if (memberIds.length < 2) continue;
      const sorted = [...memberIds].sort();
      const hash = clusterSuppressionHash(sorted);
      if (suppressedHashes.has(hash)) continue;

      // Collect shared source items for this cluster
      const shared = new Map<string, Set<string>>();
      for (const [key, sourceItems] of pairSet) {
        const [a, b] = key.split("|");
        if (memberIds.includes(a) && memberIds.includes(b)) {
          for (const si of sourceItems) {
            if (!shared.has(si)) shared.set(si, new Set());
            shared.get(si)!.add(a);
            shared.get(si)!.add(b);
          }
        }
      }

      const existing = pendingByHash.get(hash);
      result.push({
        memberIds: sorted,
        suppressionHash: hash,
        existingClusterId: existing?.id ?? null,
        sharedSourceItems: shared
      });
    }

    return result;
  }

  async listPendingClusters(companyId: string) {
    return this.prisma.duplicateCluster.findMany({
      where: { companyId, status: "pending" },
      orderBy: { createdAt: "desc" }
    });
  }

  async getClusterById(id: string) {
    return this.prisma.duplicateCluster.findUnique({ where: { id } });
  }

  async upsertPendingCluster(companyId: string, memberIds: string[], suppressionHash: string) {
    return this.prisma.duplicateCluster.upsert({
      where: { companyId_suppressionHash: { companyId, suppressionHash } },
      create: {
        id: createId("dcluster"),
        companyId,
        memberIds,
        suppressionHash,
        status: "pending"
      },
      update: { memberIds }
    });
  }
}

// ── Cluster detection helpers (exported for testing) ──────────────────

export function clusterSuppressionHash(sortedMemberIds: string[]): string {
  return createDeterministicId("dcluster", sortedMemberIds);
}

export function buildClustersFromPairs(pairs: Array<[string, string]>): string[][] {
  const parent = new Map<string, string>();

  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression
    let curr = x;
    while (curr !== root) {
      const next = parent.get(curr)!;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const [a, b] of pairs) {
    union(a, b);
  }

  const groups = new Map<string, string[]>();
  for (const node of parent.keys()) {
    const root = find(node);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(node);
  }

  // Cap cluster size at 10
  const MAX_CLUSTER_SIZE = 10;
  return [...groups.values()].map((members) =>
    members.length > MAX_CLUSTER_SIZE ? members.slice(0, MAX_CLUSTER_SIZE) : members
  );
}

export function computeTopicalScore(
  titleA: string,
  angleA: string,
  titleB: string,
  angleB: string
): number {
  const tokensA = new Set(removeStopWords(tokenizeV2(`${titleA} ${angleA}`)));
  const tokensB = new Set(removeStopWords(tokenizeV2(`${titleB} ${angleB}`)));
  return jaccardSimilarity(tokensA, tokensB);
}
