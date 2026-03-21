import { Prisma, type PrismaClient } from "@prisma/client";

interface AdminPagination {
  page: number;
  pageSize: number;
}

export type Disposition = "screened-out" | "blocked" | "orphaned" | "unsynced";

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
    NOT: [
      { screeningResultJson: { path: ["decision"], equals: "skip" } },
      { metadataJson: { path: ["publishabilityRisk"], equals: "harmful" } },
      { metadataJson: { path: ["publishabilityRisk"], equals: "reframeable" } }
    ]
  },
  unsynced: {
    processedAt: { not: null },
    notionPageId: null,
    NOT: [
      { screeningResultJson: { path: ["decision"], equals: "skip" } },
      { metadataJson: { path: ["publishabilityRisk"], equals: "harmful" } },
      { metadataJson: { path: ["publishabilityRisk"], equals: "reframeable" } }
    ]
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
        metadataJson: { path: ["linearEnrichmentClassification"], not: Prisma.DbNull }
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
        metadataJson: { path: ["linearEnrichmentClassification"], not: Prisma.DbNull }
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

  async getDashboardCounts(companyId: string) {
    const [
      sourceItems,
      opportunities,
      drafts,
      runs,
      users,
      screenedOut,
      blocked,
      orphaned,
      unsynced
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
      }),
      this.prisma.sourceItem.count({
        where: { companyId, ...DISPOSITION_CLAUSES.unsynced }
      })
    ]);

    return { sourceItems, opportunities, drafts, runs, users, screenedOut, blocked, orphaned, unsynced };
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
}
