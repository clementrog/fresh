import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { createDeterministicId } from "../../lib/ids.js";
import type {
  ConfidenceLevel,
  DismissReason,
  RecommendationActionType,
  RecommendationStatus,
  SalesDoctrineConfig
} from "../domain/types.js";

type PrismaTransaction = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

// ---------------------------------------------------------------------------
// Deterministic ID helpers
// ---------------------------------------------------------------------------

export function salesDealDbId(companyId: string, hubspotDealId: string): string {
  return createDeterministicId("sd", [companyId, hubspotDealId]);
}

export function salesContactDbId(companyId: string, hubspotContactId: string): string {
  return createDeterministicId("sc", [companyId, hubspotContactId]);
}

export function salesHubspotCompanyDbId(companyId: string, hubspotCompanyId: string): string {
  return createDeterministicId("shc", [companyId, hubspotCompanyId]);
}

export function salesActivityDbId(companyId: string, hubspotEngagementId: string): string {
  return createDeterministicId("sa", [companyId, hubspotEngagementId]);
}

export function salesSignalDbId(companyId: string, parts: string[]): string {
  return createDeterministicId("ss", [companyId, ...parts]);
}

export function salesExtractedFactDbId(companyId: string, parts: string[]): string {
  return createDeterministicId("sef", [companyId, ...parts]);
}

export function salesRecommendationDbId(companyId: string, dealId: string, signalId: string): string {
  return createDeterministicId("sr", [companyId, dealId, signalId]);
}

export function salesDraftDbId(companyId: string, recommendationId: string, channelType: string): string {
  return createDeterministicId("sdr", [companyId, recommendationId, channelType, Date.now().toString()]);
}

export function salesDoctrineDbId(companyId: string, version: number): string {
  return createDeterministicId("sdoc", [companyId, version.toString()]);
}

function toJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// Recommendation include for detail queries
// ---------------------------------------------------------------------------

const recommendationInclude = {
  deal: true,
  signal: true,
  evidence: { include: { evidence: true } },
  actions: { orderBy: { createdAt: "desc" as const } },
  drafts: { orderBy: { createdAt: "desc" as const } },
  user: true
} satisfies Prisma.SalesRecommendationInclude;

// ---------------------------------------------------------------------------
// SalesRepositoryBundle
// ---------------------------------------------------------------------------

export class SalesRepositoryBundle {
  constructor(private readonly prisma: PrismaClient) {}

  // ---- Deals ----

  async upsertDeal(params: {
    companyId: string;
    hubspotDealId: string;
    dealName: string;
    pipeline: string;
    stage: string;
    amount: number | null;
    ownerEmail: string | null;
    hubspotOwnerId: string | null;
    lastActivityDate: Date | null;
    closeDateExpected: Date | null;
    propertiesJson: Record<string, unknown>;
    staleDays: number;
  }, tx: PrismaTransaction = this.prisma) {
    const id = salesDealDbId(params.companyId, params.hubspotDealId);
    return tx.salesDeal.upsert({
      where: {
        companyId_hubspotDealId: {
          companyId: params.companyId,
          hubspotDealId: params.hubspotDealId
        }
      },
      create: { id, ...params, propertiesJson: toJson(params.propertiesJson) },
      update: {
        dealName: params.dealName,
        pipeline: params.pipeline,
        stage: params.stage,
        amount: params.amount,
        ownerEmail: params.ownerEmail,
        hubspotOwnerId: params.hubspotOwnerId,
        lastActivityDate: params.lastActivityDate,
        closeDateExpected: params.closeDateExpected,
        propertiesJson: toJson(params.propertiesJson),
        staleDays: params.staleDays
      }
    });
  }

  async getDealByHubspotId(companyId: string, hubspotDealId: string) {
    return this.prisma.salesDeal.findUnique({
      where: {
        companyId_hubspotDealId: { companyId, hubspotDealId }
      }
    });
  }

  async listDeals(companyId: string, options?: { stage?: string; skip?: number; take?: number }) {
    return this.prisma.salesDeal.findMany({
      where: { companyId, ...(options?.stage ? { stage: options.stage } : {}) },
      orderBy: { updatedAt: "desc" },
      skip: options?.skip ?? 0,
      take: options?.take ?? 100
    });
  }

  async listStaleDeals(companyId: string, minStaleDays: number) {
    return this.prisma.salesDeal.findMany({
      where: { companyId, staleDays: { gte: minStaleDays } },
      orderBy: { staleDays: "desc" }
    });
  }

  async countDeals(companyId: string) {
    return this.prisma.salesDeal.count({ where: { companyId } });
  }

  // ---- Contacts ----

  async upsertContact(params: {
    companyId: string;
    hubspotContactId: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    title: string | null;
    company: string | null;
    propertiesJson: Record<string, unknown>;
  }, tx: PrismaTransaction = this.prisma) {
    const id = salesContactDbId(params.companyId, params.hubspotContactId);
    return tx.salesContact.upsert({
      where: {
        companyId_hubspotContactId: {
          companyId: params.companyId,
          hubspotContactId: params.hubspotContactId
        }
      },
      create: { id, ...params, propertiesJson: toJson(params.propertiesJson) },
      update: {
        email: params.email,
        firstName: params.firstName,
        lastName: params.lastName,
        title: params.title,
        company: params.company,
        propertiesJson: toJson(params.propertiesJson)
      }
    });
  }

  // ---- HubSpot companies ----

  async upsertHubspotCompany(params: {
    companyId: string;
    hubspotCompanyId: string;
    name: string;
    domain: string | null;
    industry: string | null;
    size: string | null;
    propertiesJson: Record<string, unknown>;
  }, tx: PrismaTransaction = this.prisma) {
    const id = salesHubspotCompanyDbId(params.companyId, params.hubspotCompanyId);
    return tx.salesHubspotCompany.upsert({
      where: {
        companyId_hubspotCompanyId: {
          companyId: params.companyId,
          hubspotCompanyId: params.hubspotCompanyId
        }
      },
      create: { id, ...params, propertiesJson: toJson(params.propertiesJson) },
      update: {
        name: params.name,
        domain: params.domain,
        industry: params.industry,
        size: params.size,
        propertiesJson: toJson(params.propertiesJson)
      }
    });
  }

  // ---- Deal associations ----

  async linkDealContact(dealId: string, contactId: string, tx: PrismaTransaction = this.prisma) {
    return tx.dealContact.upsert({
      where: { dealId_contactId: { dealId, contactId } },
      create: { dealId, contactId },
      update: {}
    });
  }

  async linkDealCompany(dealId: string, salesCompanyId: string, tx: PrismaTransaction = this.prisma) {
    return tx.dealCompany.upsert({
      where: { dealId_salesCompanyId: { dealId, salesCompanyId } },
      create: { dealId, salesCompanyId },
      update: {}
    });
  }

  // ---- Activities ----

  async upsertActivity(params: {
    companyId: string;
    hubspotEngagementId: string;
    type: string;
    body: string | null;
    timestamp: Date;
    dealId: string | null;
    contactId: string | null;
    rawTextExpiresAt: Date | null;
  }, tx: PrismaTransaction = this.prisma) {
    const id = salesActivityDbId(params.companyId, params.hubspotEngagementId);
    return tx.salesActivity.upsert({
      where: {
        companyId_hubspotEngagementId: {
          companyId: params.companyId,
          hubspotEngagementId: params.hubspotEngagementId
        }
      },
      create: { id, ...params },
      update: {
        body: params.body,
        timestamp: params.timestamp,
        dealId: params.dealId,
        contactId: params.contactId,
        rawTextExpiresAt: params.rawTextExpiresAt
      }
    });
  }

  async listUnextractedActivities(companyId: string, take = 50) {
    return this.prisma.salesActivity.findMany({
      where: {
        companyId,
        extractedAt: null,
        body: { not: null },
        rawTextCleaned: false
      },
      orderBy: { timestamp: "desc" },
      take
    });
  }

  async markActivityExtracted(id: string) {
    return this.prisma.salesActivity.update({
      where: { id },
      data: { extractedAt: new Date() }
    });
  }

  async listCleanupCandidateActivities(now: Date) {
    return this.prisma.salesActivity.findMany({
      where: {
        rawTextCleaned: false,
        rawTextExpiresAt: { lte: now }
      }
    });
  }

  async cleanupActivityRawText(id: string) {
    return this.prisma.salesActivity.update({
      where: { id },
      data: {
        body: null,
        rawTextCleaned: true
      }
    });
  }

  // ---- Signals ----

  async createSignal(params: {
    id: string;
    companyId: string;
    signalType: string;
    title: string;
    description: string;
    sourceItemId: string | null;
    dealId: string | null;
    confidence: ConfidenceLevel;
    metadataJson: Record<string, unknown>;
    detectedAt: Date;
  }) {
    return this.prisma.salesSignal.upsert({
      where: { id: params.id },
      create: { ...params, metadataJson: toJson(params.metadataJson) },
      update: {}
    });
  }

  async listUnmatchedSignals(companyId: string) {
    return this.prisma.salesSignal.findMany({
      where: { companyId, matchedAt: null },
      orderBy: { detectedAt: "desc" }
    });
  }

  async markSignalMatched(id: string) {
    return this.prisma.salesSignal.update({
      where: { id },
      data: { matchedAt: new Date() }
    });
  }

  async listRecentSignals(companyId: string, take = 50) {
    return this.prisma.salesSignal.findMany({
      where: { companyId },
      orderBy: { detectedAt: "desc" },
      take
    });
  }

  async listSignalsForDeal(dealId: string) {
    return this.prisma.salesSignal.findMany({
      where: { dealId },
      orderBy: { detectedAt: "desc" }
    });
  }

  async countSignals(companyId: string) {
    return this.prisma.salesSignal.count({ where: { companyId } });
  }

  // ---- Extracted facts ----

  async createExtractedFact(params: {
    id: string;
    companyId: string;
    activityId: string | null;
    dealId: string;
    category: string;
    label: string;
    extractedValue: string;
    confidence: number;
    sourceText: string;
  }) {
    return this.prisma.salesExtractedFact.upsert({
      where: { id: params.id },
      create: params,
      update: {}
    });
  }

  async listExtractionsForDeal(dealId: string) {
    return this.prisma.salesExtractedFact.findMany({
      where: { dealId },
      include: { activity: { select: { timestamp: true } } },
      orderBy: { createdAt: "desc" }
    });
  }

  async countExtractions(companyId: string) {
    return this.prisma.salesExtractedFact.count({ where: { companyId } });
  }

  // ---- Recommendations ----

  async createRecommendation(params: {
    id: string;
    companyId: string;
    dealId: string;
    signalId: string;
    userId: string | null;
    whyNow: string;
    recommendedAngle: string;
    nextStepType: string;
    matchedContextJson: Record<string, unknown>;
    confidence: ConfidenceLevel;
    priorityRank: number;
  }) {
    return this.prisma.salesRecommendation.upsert({
      where: { id: params.id },
      create: { ...params, matchedContextJson: toJson(params.matchedContextJson) },
      update: {
        whyNow: params.whyNow,
        recommendedAngle: params.recommendedAngle,
        nextStepType: params.nextStepType,
        matchedContextJson: toJson(params.matchedContextJson),
        confidence: params.confidence,
        priorityRank: params.priorityRank
      }
    });
  }

  async updateRecommendationStatus(
    id: string,
    status: RecommendationStatus,
    extra?: { dismissReason?: DismissReason; snoozedUntil?: Date }
  ) {
    return this.prisma.salesRecommendation.update({
      where: { id },
      data: {
        status,
        dismissReason: extra?.dismissReason ?? null,
        snoozedUntil: extra?.snoozedUntil ?? null
      }
    });
  }

  async getRecommendation(id: string) {
    return this.prisma.salesRecommendation.findUnique({
      where: { id },
      include: recommendationInclude
    });
  }

  async listRecommendationsForUser(companyId: string, userId: string | null, options?: {
    status?: RecommendationStatus;
    skip?: number;
    take?: number;
  }) {
    return this.prisma.salesRecommendation.findMany({
      where: {
        companyId,
        ...(userId ? { userId } : {}),
        ...(options?.status ? { status: options.status } : {})
      },
      include: { deal: true, signal: true },
      orderBy: { priorityRank: "desc" },
      skip: options?.skip ?? 0,
      take: options?.take ?? 50
    });
  }

  async listRecommendationsForDeal(dealId: string) {
    return this.prisma.salesRecommendation.findMany({
      where: { dealId },
      include: { signal: true },
      orderBy: { priorityRank: "desc" }
    });
  }

  async countRecommendations(companyId: string, status?: RecommendationStatus) {
    return this.prisma.salesRecommendation.count({
      where: { companyId, ...(status ? { status } : {}) }
    });
  }

  async countRecommendationsForDealSince(dealId: string, since: Date) {
    return this.prisma.salesRecommendation.count({
      where: { dealId, createdAt: { gte: since } }
    });
  }

  // countRecommendationsForUserToday removed — requires timezone-aware
  // day-boundary computation (Company.defaultTimezone). Deferred to Slice 4
  // where the suppression engine can implement it correctly.

  // ---- Evidence linking ----

  async linkRecommendationEvidence(recommendationId: string, evidenceId: string, relevanceNote = "") {
    return this.prisma.recommendationEvidence.upsert({
      where: { recommendationId_evidenceId: { recommendationId, evidenceId } },
      create: { recommendationId, evidenceId, relevanceNote },
      update: { relevanceNote }
    });
  }

  // ---- Actions ----

  async createAction(params: {
    recommendationId: string;
    userId: string | null;
    actionType: RecommendationActionType;
    reason: string | null;
    metadataJson?: Record<string, unknown>;
  }) {
    const id = createDeterministicId("ra", [
      params.recommendationId,
      params.actionType,
      Date.now().toString()
    ]);
    return this.prisma.recommendationAction.create({
      data: {
        id,
        recommendationId: params.recommendationId,
        userId: params.userId,
        actionType: params.actionType,
        reason: params.reason,
        metadataJson: toJson(params.metadataJson ?? {})
      }
    });
  }

  // ---- Drafts ----

  async createDraft(params: {
    companyId: string;
    recommendationId: string;
    channelType: string;
    subject: string | null;
    body: string;
    repProfileId: string | null;
    confidenceScore: number;
  }) {
    const id = salesDraftDbId(params.companyId, params.recommendationId, params.channelType);
    return this.prisma.salesDraft.create({
      data: { id, ...params }
    });
  }

  async getDraftForRecommendation(recommendationId: string) {
    return this.prisma.salesDraft.findFirst({
      where: { recommendationId },
      orderBy: { createdAt: "desc" }
    });
  }

  // ---- Doctrine ----

  async upsertDoctrine(companyId: string, version: number, doctrineJson: SalesDoctrineConfig) {
    const id = salesDoctrineDbId(companyId, version);
    return this.prisma.salesDoctrine.upsert({
      where: { companyId_version: { companyId, version } },
      create: { id, companyId, version, doctrineJson: toJson(doctrineJson as unknown as Record<string, unknown>) },
      update: { doctrineJson: toJson(doctrineJson as unknown as Record<string, unknown>) }
    });
  }

  async getLatestDoctrine(companyId: string) {
    return this.prisma.salesDoctrine.findFirst({
      where: { companyId },
      orderBy: { version: "desc" }
    });
  }

  // ---- Sync runs (reuses shared SyncRun/CostLedgerEntry tables) ----

  async createSyncRun(params: {
    companyId: string;
    runType: string;
    source?: string;
  }) {
    const id = createDeterministicId("run", [params.companyId, params.runType, Date.now().toString()]);
    return this.prisma.syncRun.create({
      data: {
        id,
        companyId: params.companyId,
        runType: params.runType,
        source: params.source ?? null,
        status: "running",
        startedAt: new Date(),
        countersJson: {},
        warningsJson: [],
        notionPageFingerprint: ""
      }
    });
  }

  async finalizeSyncRun(
    id: string,
    status: "completed" | "failed",
    counters: Record<string, number>,
    warnings: string[] = [],
    notes?: string
  ) {
    return this.prisma.syncRun.update({
      where: { id },
      data: {
        status,
        finishedAt: new Date(),
        countersJson: counters,
        warningsJson: warnings,
        notes: notes ?? null,
        leaseExpiresAt: null
      }
    });
  }

  async createCostEntry(params: {
    runId: string;
    step: string;
    model: string;
    mode: string;
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number;
  }) {
    const id = createDeterministicId("cost", [params.runId, params.step, Date.now().toString()]);
    return this.prisma.costLedgerEntry.create({
      data: { id, ...params }
    });
  }

  // ---- Cursor helpers (reuses shared SourceCursor table) ----

  async getCursor(companyId: string, source: string) {
    const row = await this.prisma.sourceCursor.findUnique({
      where: { companyId_source: { companyId, source } }
    });
    return row?.cursor ?? null;
  }

  async setCursor(companyId: string, source: string, cursor: string) {
    const id = createDeterministicId("cur", [companyId, source]);
    return this.prisma.sourceCursor.upsert({
      where: { companyId_source: { companyId, source } },
      create: { id, companyId, source, cursor },
      update: { cursor }
    });
  }

  // ---- Status helpers ----

  /**
   * Return pipeline counters for operator-visible status reporting.
   *
   * When `intelligenceStageIds` is provided and non-empty, every counter
   * (activities, deals, facts, signals) is scoped to deals whose stage is in
   * that set.  Facts and signals are filtered via their `deal` relation, so
   * only records attached to in-scope deals are counted — not the whole-company
   * totals.  This ensures the reported processing rate is consistent with the
   * actual extraction and detection scope.
   */
  async getExtractionStatus(companyId: string, intelligenceStageIds?: string[]) {
    const scoped = intelligenceStageIds && intelligenceStageIds.length > 0;

    // When stage IDs are provided, scope ALL counters to in-scope deals
    const dealWhere = scoped
      ? { companyId, stage: { in: intelligenceStageIds! } }
      : { companyId };
    const activityWhere = scoped
      ? { companyId, dealId: { not: null as string | null }, deal: { stage: { in: intelligenceStageIds! } } }
      : { companyId, dealId: { not: null as string | null } };
    const factWhere = scoped
      ? { companyId, deal: { stage: { in: intelligenceStageIds! } } }
      : { companyId };
    const signalWhere = scoped
      ? { companyId, deal: { stage: { in: intelligenceStageIds! } } }
      : { companyId };

    const [totalActivities, processedActivities, totalDeals, totalFacts, totalSignals] = await Promise.all([
      this.prisma.salesActivity.count({ where: activityWhere }),
      this.prisma.salesActivity.count({ where: { ...activityWhere, extractedAt: { not: null } } }),
      this.prisma.salesDeal.count({ where: dealWhere }),
      this.prisma.salesExtractedFact.count({ where: factWhere }),
      this.prisma.salesSignal.count({ where: signalWhere }),
    ]);
    const unprocessedActivities = totalActivities - processedActivities;
    const processingRate = totalActivities > 0
      ? Math.round((processedActivities / totalActivities) * 1000) / 10
      : 0;
    return { totalActivities, processedActivities, unprocessedActivities, processingRate, totalDeals, totalFacts, totalSignals };
  }

  // ---- Extraction helpers ----

  async deleteFactsForActivity(activityId: string, tx: PrismaTransaction = this.prisma) {
    return tx.salesExtractedFact.deleteMany({ where: { activityId } });
  }

  async incrementExtractionAttempts(activityId: string): Promise<number> {
    const updated = await this.prisma.salesActivity.update({
      where: { id: activityId },
      data: { extractionAttempts: { increment: 1 } },
      select: { extractionAttempts: true }
    });
    return updated.extractionAttempts;
  }

  async resetExtractions(companyId: string) {
    return this.prisma.salesActivity.updateMany({
      where: {
        companyId,
        rawTextCleaned: false,
        body: { not: null }
      },
      data: { extractedAt: null, extractionAttempts: 0 }
    });
  }

  // ---- Detection helpers ----

  async deleteDetectionSignalsForDeal(
    dealId: string,
    managedTypes: string[],
    tx: PrismaTransaction = this.prisma
  ) {
    return tx.salesSignal.deleteMany({
      where: { dealId, signalType: { in: managedTypes } }
    });
  }

  // ---- Stage-aware helpers ----

  async listDealsForStageCheck(companyId: string, dealIds: string[]): Promise<Map<string, string>> {
    if (dealIds.length === 0) return new Map();
    const deals = await this.prisma.salesDeal.findMany({
      where: { companyId, id: { in: dealIds } },
      select: { id: true, stage: true }
    });
    return new Map(deals.map((d) => [d.id, d.stage]));
  }

  async listCompanyNamesForDeals(companyId: string, dealIds: string[]): Promise<Map<string, string[]>> {
    if (dealIds.length === 0) return new Map();
    const links = await this.prisma.dealCompany.findMany({
      where: { dealId: { in: dealIds } },
      include: { company: { select: { name: true } } }
    });
    const result = new Map<string, string[]>();
    for (const link of links) {
      const names = result.get(link.dealId) ?? [];
      names.push(link.company.name);
      result.set(link.dealId, names);
    }
    return result;
  }

  async deleteSignalsForOutOfScopeDeals(
    companyId: string,
    intelligenceStageIds: string[],
    managedTypes: string[]
  ) {
    // Find deal IDs NOT in intelligence stages
    const outOfScopeDeals = await this.prisma.salesDeal.findMany({
      where: { companyId, stage: { notIn: intelligenceStageIds } },
      select: { id: true }
    });
    if (outOfScopeDeals.length === 0) return { count: 0 };

    const outOfScopeDealIds = outOfScopeDeals.map((d) => d.id);
    return this.prisma.salesSignal.deleteMany({
      where: {
        companyId,
        dealId: { in: outOfScopeDealIds },
        signalType: { in: managedTypes }
      }
    });
  }

  // ---- Lead detection helpers ----

  async listHubspotCompaniesWithLeadStatus(companyId: string) {
    return this.prisma.salesHubspotCompany.findMany({
      where: {
        companyId,
        propertiesJson: { path: ["hs_lead_status"], not: "" }
      }
    });
  }

  async listDealsByHubspotCompany(salesCompanyId: string) {
    const links = await this.prisma.dealCompany.findMany({
      where: { salesCompanyId },
      include: { deal: true }
    });
    return links.map((l) => l.deal);
  }

  async maxActivityTimestampForDeals(dealIds: string[], after?: Date): Promise<Date | null> {
    if (dealIds.length === 0) return null;
    const result = await this.prisma.salesActivity.aggregate({
      where: {
        dealId: { in: dealIds },
        ...(after ? { timestamp: { gt: after } } : {})
      },
      _max: { timestamp: true }
    });
    return result._max.timestamp;
  }

  async countActivitiesForDealsSince(dealIds: string[], after: Date): Promise<number> {
    if (dealIds.length === 0) return 0;
    return this.prisma.salesActivity.count({
      where: { dealId: { in: dealIds }, timestamp: { gt: after } }
    });
  }

  async deleteLeadSignalsForCompany(
    salesHubspotCompanyId: string,
    managedTypes: string[],
    tx: PrismaTransaction = this.prisma
  ) {
    return tx.salesSignal.deleteMany({
      where: {
        dealId: null,
        signalType: { in: managedTypes },
        metadataJson: { path: ["hubspotCompanyId"], equals: salesHubspotCompanyId }
      }
    });
  }

  async deleteOrphanedLeadSignals(
    companyId: string,
    processedCompanyIds: string[],
    managedTypes: string[]
  ) {
    // 1. Find orphan company IDs from signal rows
    const allLeadSignals = await this.prisma.salesSignal.findMany({
      where: {
        companyId,
        dealId: null,
        signalType: { in: managedTypes }
      },
      select: { id: true, metadataJson: true }
    });

    const signalOrphanCompanyIds = new Set<string>();
    const signalOrphanIds: string[] = [];
    for (const s of allLeadSignals) {
      const meta = s.metadataJson as Record<string, unknown> | null;
      const hcId = meta?.hubspotCompanyId as string | undefined;
      if (hcId && !processedCompanyIds.includes(hcId)) {
        signalOrphanCompanyIds.add(hcId);
        signalOrphanIds.push(s.id);
      }
    }

    // 2. Find orphan company IDs from cursor rows (covers cursor-only orphans)
    const allLeadCursors = await this.prisma.sourceCursor.findMany({
      where: {
        companyId,
        source: { startsWith: "lead-detect:" }
      },
      select: { source: true }
    });

    const cursorOrphanCompanyIds = new Set<string>();
    for (const c of allLeadCursors) {
      const hcId = c.source.replace("lead-detect:", "");
      if (hcId && !processedCompanyIds.includes(hcId)) {
        cursorOrphanCompanyIds.add(hcId);
      }
    }

    // 3. Delete orphan signals
    let signalsDeleted = 0;
    if (signalOrphanIds.length > 0) {
      const deleted = await this.prisma.salesSignal.deleteMany({
        where: { id: { in: signalOrphanIds } }
      });
      signalsDeleted = deleted.count;
    }

    // 4. Delete orphan cursors (union of signal-derived and cursor-derived orphan IDs)
    const allOrphanCompanyIds = new Set([...signalOrphanCompanyIds, ...cursorOrphanCompanyIds]);
    let cursorsCleaned = 0;
    for (const hcId of allOrphanCompanyIds) {
      try {
        const result = await this.prisma.sourceCursor.deleteMany({
          where: { companyId, source: `lead-detect:${hcId}` }
        });
        if (result.count > 0) cursorsCleaned++;
      } catch {
        // best effort
      }
    }

    return { count: signalsDeleted, cursorsCleaned };
  }

  // ---- Lease / concurrency helpers ----

  static readonly LEASE_DURATION_MS = 300_000; // 5 minutes

  async acquireRunLease(params: {
    companyId: string;
    runType: string;
    runId: string;
    source?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // Advisory lock serializes concurrent starters for (companyId, runType)
      const lockKey = deterministicInt32(params.companyId + ":" + params.runType);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      // Check for existing live lease
      const existing = await tx.syncRun.findFirst({
        where: { companyId: params.companyId, runType: params.runType, status: "running" },
        orderBy: { startedAt: "desc" }
      });

      if (existing && existing.leaseExpiresAt && existing.leaseExpiresAt > new Date()) {
        throw new ConcurrentRunError(existing.id, params.runType);
      }

      // Expire abandoned run if lease has lapsed
      if (existing) {
        await tx.syncRun.update({
          where: { id: existing.id },
          data: { status: "failed", finishedAt: new Date(), notes: "Lease expired — abandoned" }
        });
      }

      // Create new run with lease
      return tx.syncRun.create({
        data: {
          id: params.runId,
          companyId: params.companyId,
          runType: params.runType,
          source: params.source ?? null,
          status: "running",
          startedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + SalesRepositoryBundle.LEASE_DURATION_MS),
          countersJson: {},
          warningsJson: [],
          notionPageFingerprint: ""
        }
      });
    });
  }

  async renewLease(runId: string): Promise<boolean> {
    const result = await this.prisma.syncRun.updateMany({
      where: { id: runId, status: "running" },
      data: { leaseExpiresAt: new Date(Date.now() + SalesRepositoryBundle.LEASE_DURATION_MS) }
    });
    return result.count > 0;
  }

  // ---- Transaction helper ----

  async transaction<T>(fn: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }
}

// ---------------------------------------------------------------------------
// Concurrency error
// ---------------------------------------------------------------------------

export class ConcurrentRunError extends Error {
  readonly blockingRunId: string;
  readonly runType: string;

  constructor(blockingRunId: string, runType: string) {
    super(`Another ${runType} run is already in progress (run ${blockingRunId})`);
    this.name = "ConcurrentRunError";
    this.blockingRunId = blockingRunId;
    this.runType = runType;
  }
}

// ---------------------------------------------------------------------------
// Utility: deterministic 32-bit int for advisory lock key
// ---------------------------------------------------------------------------

function deterministicInt32(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return hash;
}
