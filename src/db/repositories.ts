import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import type {
  CompanyRecord,
  ContentOpportunity,
  CostLedgerEntry,
  DraftV1,
  EditorialConfigRecord,
  EvidenceReference,
  MarketQueryRecord,
  NormalizedSourceItem,
  ScreeningResult,
  SourceConfigRecord,
  SyncRun,
  UserRecord
} from "../domain/types.js";
import { createDeterministicId } from "../lib/ids.js";
import { normalizeNarrativePillar } from "../lib/text.js";

export type { PrismaTransaction };

export function sourceItemDbId(companyId: string, externalId: string): string {
  return createDeterministicId("si", [companyId, externalId]);
}

type PrismaTransaction = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

const opportunityInclude = {
  evidence: true,
  primaryEvidence: true,
  linkedEvidence: { include: { evidence: true } }
} satisfies Prisma.OpportunityInclude;

export class RepositoryBundle {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureDefaultCompany(params: { slug: string; name: string; defaultTimezone: string }): Promise<CompanyRecord> {
    const company = await this.prisma.company.upsert({
      where: { slug: params.slug },
      create: {
        id: createDeterministicId("company", [params.slug]),
        slug: params.slug,
        name: params.name,
        defaultTimezone: params.defaultTimezone
      },
      update: {
        name: params.name,
        defaultTimezone: params.defaultTimezone
      }
    });

    return mapCompany(company);
  }

  async getCompanyBySlug(slug: string): Promise<CompanyRecord | null> {
    const company = await this.prisma.company.findUnique({ where: { slug } });
    return company ? mapCompany(company) : null;
  }

  async upsertUser(user: UserRecord, tx: PrismaTransaction = this.prisma) {
    return tx.user.upsert({
      where: { id: user.id },
      create: {
        id: user.id,
        companyId: user.companyId,
        displayName: user.displayName,
        type: user.type,
        language: user.language,
        baseProfile: toJson(user.baseProfile)
      },
      update: {
        companyId: user.companyId,
        displayName: user.displayName,
        type: user.type,
        language: user.language,
        baseProfile: toJson(user.baseProfile)
      }
    });
  }

  async upsertEditorialConfig(config: EditorialConfigRecord, tx: PrismaTransaction = this.prisma) {
    return tx.editorialConfig.upsert({
      where: {
        companyId_version: {
          companyId: config.companyId,
          version: config.version
        }
      },
      create: {
        id: config.id,
        companyId: config.companyId,
        version: config.version,
        layer1CompanyLens: toJson(config.layer1CompanyLens),
        layer2ContentPhilosophy: toJson(config.layer2ContentPhilosophy),
        layer3LinkedInCraft: toJson(config.layer3LinkedInCraft),
        createdAt: new Date(config.createdAt)
      },
      update: {
        layer1CompanyLens: toJson(config.layer1CompanyLens),
        layer2ContentPhilosophy: toJson(config.layer2ContentPhilosophy),
        layer3LinkedInCraft: toJson(config.layer3LinkedInCraft)
      }
    });
  }

  async getLatestEditorialConfig(companyId: string) {
    return this.prisma.editorialConfig.findFirst({
      where: { companyId },
      orderBy: { version: "desc" }
    });
  }

  async upsertSourceConfig(config: SourceConfigRecord, tx: PrismaTransaction = this.prisma) {
    return tx.sourceConfig.upsert({
      where: {
        companyId_source: {
          companyId: config.companyId,
          source: config.source
        }
      },
      create: {
        id: config.id,
        companyId: config.companyId,
        source: config.source,
        enabled: config.enabled,
        configJson: toJson(config.configJson)
      },
      update: {
        enabled: config.enabled,
        configJson: toJson(config.configJson)
      }
    });
  }

  async listSourceConfigs(companyId: string) {
    return this.prisma.sourceConfig.findMany({
      where: { companyId, enabled: true },
      orderBy: { source: "asc" }
    });
  }

  async upsertMarketQuery(query: MarketQueryRecord, tx: PrismaTransaction = this.prisma) {
    return tx.marketQuery.upsert({
      where: { id: query.id },
      create: {
        id: query.id,
        companyId: query.companyId,
        query: query.query,
        enabled: query.enabled,
        priority: query.priority
      },
      update: {
        companyId: query.companyId,
        query: query.query,
        enabled: query.enabled,
        priority: query.priority
      }
    });
  }

  async listActiveMarketQueries(companyId: string): Promise<MarketQueryRecord[]> {
    const rows = await this.prisma.marketQuery.findMany({
      where: {
        companyId,
        enabled: true
      },
      orderBy: [
        { priority: "asc" },
        { createdAt: "asc" }
      ]
    });

    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      query: row.query,
      enabled: row.enabled,
      priority: row.priority,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    }));
  }

  async getCursor(source: string, companyId?: string) {
    if (companyId) {
      const cursor = await this.prisma.sourceCursor.findUnique({
        where: {
          companyId_source: {
            companyId,
            source
          }
        }
      });
      return cursor?.cursor ?? null;
    }
    // Fallback: find by source (for legacy callers without companyId)
    const cursor = await this.prisma.sourceCursor.findFirst({
      where: { source }
    });
    return cursor?.cursor ?? null;
  }

  async setCursor(source: string, cursor: string | null, tx: PrismaTransaction = this.prisma, companyId?: string) {
    const id = companyId ? createDeterministicId("cursor", [companyId, source]) : source;
    return tx.sourceCursor.upsert({
      where: companyId
        ? {
            companyId_source: {
              companyId,
              source
            } as never
          }
        : { id },
      create: {
        id,
        companyId,
        source,
        cursor
      },
      update: {
        cursor
      }
    });
  }

  async upsertSourceItem(
    item: NormalizedSourceItem,
    rawTextExpiresAt: Date | null,
    tx: PrismaTransaction = this.prisma,
    companyId: string
  ) {
    return tx.sourceItem.upsert({
      where: {
        companyId_source_sourceItemId: {
          companyId,
          source: item.source,
          sourceItemId: item.sourceItemId
        }
      },
      create: {
        id: sourceItemDbId(companyId, item.externalId),
        companyId,
        source: item.source,
        sourceItemId: item.sourceItemId,
        externalId: item.externalId,
        fingerprint: item.sourceFingerprint,
        sourceUrl: item.sourceUrl,
        title: item.title,
        summary: item.summary,
        text: item.text,
        authorName: item.authorName,
        speakerName: item.speakerName,
        occurredAt: new Date(item.occurredAt),
        ingestedAt: new Date(item.ingestedAt),
        metadataJson: toJson(item.metadata),
        rawPayloadJson: toJson(item.rawPayload),
        rawText: item.rawText ?? null,
        chunksJson: nullableJson(item.chunks ?? null),
        rawTextStored: item.rawText !== undefined && item.rawText !== null,
        rawTextExpiresAt,
        cleanupEligible: rawTextExpiresAt !== null,
        processedAt: null
      },
      update: {
        companyId,
        externalId: item.externalId,
        fingerprint: item.sourceFingerprint,
        sourceUrl: item.sourceUrl,
        title: item.title,
        summary: item.summary,
        text: item.text,
        authorName: item.authorName,
        speakerName: item.speakerName,
        occurredAt: new Date(item.occurredAt),
        ingestedAt: new Date(item.ingestedAt),
        metadataJson: toJson(item.metadata),
        rawPayloadJson: toJson(item.rawPayload),
        rawText: item.rawText ?? null,
        chunksJson: nullableJson(item.chunks ?? null),
        rawTextStored: item.rawText !== undefined && item.rawText !== null,
        rawTextExpiresAt,
        cleanupEligible: rawTextExpiresAt !== null,
        processedAt: null
      }
    });
  }

  async findSourceItemBySourceKey(params: { companyId: string; source: string; sourceItemId: string }) {
    return this.prisma.sourceItem.findUnique({
      where: {
        companyId_source_sourceItemId: {
          companyId: params.companyId,
          source: params.source,
          sourceItemId: params.sourceItemId
        }
      }
    });
  }

  async listPendingSourceItems(params: { companyId?: string; take: number }) {
    return this.prisma.sourceItem.findMany({
      where: {
        ...(params.companyId ? { companyId: params.companyId } : {}),
        processedAt: null
      },
      // Dogfood the freshest inputs first so the intelligence loop reaches current signals quickly.
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: params.take
    });
  }

  /**
   * Recent source items within a rolling window, used by the routing gate as
   * the corroboration candidate pool. Includes both processed and unprocessed
   * items — the gate only needs the content (title/summary/text/metadata) to
   * score token overlap, not the processing state.
   */
  async listRecentSourceItems(params: {
    companyId: string;
    sinceDate: Date;
    take: number;
  }) {
    return this.prisma.sourceItem.findMany({
      where: {
        companyId: params.companyId,
        occurredAt: { gte: params.sinceDate }
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: params.take
    });
  }

  async markSourceItemsProcessed(sourceItemIds: string[], processedAt: Date, tx: PrismaTransaction = this.prisma) {
    if (sourceItemIds.length === 0) {
      return;
    }
    await tx.sourceItem.updateMany({
      where: {
        id: {
          in: sourceItemIds
        }
      },
      data: {
        processedAt
      }
    });
  }

  async findOpportunityById(opportunityId: string) {
    return this.prisma.opportunity.findUnique({
      where: { id: opportunityId },
      include: opportunityInclude
    });
  }


  async upsertOpportunity(opportunity: ContentOpportunity, tx: PrismaTransaction = this.prisma) {
    const supportingEvidenceCount = Math.max(0, opportunity.evidence.length - 1);
    // Normalize narrativePillar at the write boundary so accent drift,
    // whitespace, and separator inconsistency collapse to one canonical
    // string. Applied to both create and update paths.
    const normalizedNarrativePillar = normalizeNarrativePillar(opportunity.narrativePillar);
    return tx.opportunity.upsert({
      where: { id: opportunity.id },
      create: {
        id: opportunity.id,
        companyId: opportunity.companyId ?? "",
        sourceFingerprint: opportunity.sourceFingerprint,
        title: opportunity.title,
        ownerProfile: opportunity.ownerProfile,
        ownerUserId: opportunity.ownerUserId,
        narrativePillar: normalizedNarrativePillar,
        targetSegment: opportunity.targetSegment ?? "",
        editorialPillar: opportunity.editorialPillar ?? "",
        awarenessTarget: opportunity.awarenessTarget ?? "",
        buyerFriction: opportunity.buyerFriction ?? "",
        contentMotion: opportunity.contentMotion ?? "",
        angle: opportunity.angle,
        editorialClaim: opportunity.editorialClaim ?? "",
        whyNow: opportunity.whyNow,
        whatItIsAbout: opportunity.whatItIsAbout,
        whatItIsNotAbout: opportunity.whatItIsNotAbout,
        routingStatus: opportunity.routingStatus,
        readiness: opportunity.readiness,
        status: opportunity.status,
        suggestedFormat: opportunity.suggestedFormat,
        supportingEvidenceCount,
        evidenceFreshness: opportunity.evidenceFreshness,
        editorialOwner: opportunity.editorialOwner,
        editorialNotes: opportunity.editorialNotes ?? "",
        dedupFlag: opportunity.dedupFlag ?? "",
        selectedAt: opportunity.selectedAt ? new Date(opportunity.selectedAt) : null,
        lastDigestAt: null,
        v1HistoryJson: toJson(opportunity.v1History),
        notionPageId: opportunity.notionPageId,
        notionPageFingerprint: opportunity.notionPageFingerprint
      },
      update: {
        companyId: opportunity.companyId ?? undefined,
        sourceFingerprint: opportunity.sourceFingerprint,
        title: opportunity.title,
        ownerProfile: opportunity.ownerProfile,
        ownerUserId: opportunity.ownerUserId,
        narrativePillar: normalizedNarrativePillar,
        targetSegment: opportunity.targetSegment ?? "",
        editorialPillar: opportunity.editorialPillar ?? "",
        awarenessTarget: opportunity.awarenessTarget ?? "",
        buyerFriction: opportunity.buyerFriction ?? "",
        contentMotion: opportunity.contentMotion ?? "",
        angle: opportunity.angle,
        editorialClaim: opportunity.editorialClaim ?? "",
        whyNow: opportunity.whyNow,
        whatItIsAbout: opportunity.whatItIsAbout,
        whatItIsNotAbout: opportunity.whatItIsNotAbout,
        routingStatus: opportunity.routingStatus,
        readiness: opportunity.readiness,
        status: opportunity.status,
        suggestedFormat: opportunity.suggestedFormat,
        supportingEvidenceCount,
        evidenceFreshness: opportunity.evidenceFreshness,
        editorialOwner: opportunity.editorialOwner,
        editorialNotes: opportunity.editorialNotes ?? "",
        selectedAt: opportunity.selectedAt ? new Date(opportunity.selectedAt) : null,
        lastDigestAt: null,
        v1HistoryJson: toJson(opportunity.v1History),
        notionPageId: opportunity.notionPageId,
        notionPageFingerprint: opportunity.notionPageFingerprint
      }
    });
  }

  async replaceOpportunityRelations(
    opportunityId: string,
    evidence: EvidenceReference[],
    primaryEvidenceId: string | null,
    companyId: string,
    tx: PrismaTransaction = this.prisma
  ) {
    validateOpportunityPrimaryEvidence(evidence, primaryEvidenceId);

    await tx.evidenceReference.deleteMany({
      where: { opportunityId }
    });

    if (evidence.length > 0) {
      await tx.evidenceReference.createMany({
        data: evidence.map((item) => ({
          id: item.id,
          opportunityId,
          companyId,
          sourceItemId: item.sourceItemId,
          source: item.source,
          sourceUrl: item.sourceUrl,
          timestamp: new Date(item.timestamp),
          excerpt: item.excerpt,
          excerptHash: item.excerptHash,
          speakerOrAuthor: item.speakerOrAuthor,
          freshnessScore: item.freshnessScore
        }))
      });
    }

    await tx.opportunity.update({
      where: { id: opportunityId },
      data: {
        primaryEvidenceId
      }
    });
  }

  async createDraft(draft: DraftV1, tx: PrismaTransaction = this.prisma, companyId: string) {
    await tx.draft.create({
      data: {
        id: draft.id,
        companyId,
        opportunityId: draft.opportunityId,
        profileId: draft.profileId,
        proposedTitle: draft.proposedTitle,
        hook: draft.hook,
        summary: draft.summary,
        whatItIsAbout: draft.whatItIsAbout,
        whatItIsNotAbout: draft.whatItIsNotAbout,
        visualIdea: draft.visualIdea,
        firstDraftText: draft.firstDraftText,
        confidenceScore: draft.confidenceScore,
        language: draft.language,
        createdAt: new Date(draft.createdAt)
      }
    });

    if (draft.sourceEvidence.length > 0) {
      await tx.evidenceReference.createMany({
        data: draft.sourceEvidence.map((item) => ({
          id: item.id,
          draftId: draft.id,
          companyId,
          sourceItemId: item.sourceItemId,
          source: item.source,
          sourceUrl: item.sourceUrl,
          timestamp: new Date(item.timestamp),
          excerpt: item.excerpt,
          excerptHash: item.excerptHash,
          speakerOrAuthor: item.speakerOrAuthor,
          freshnessScore: item.freshnessScore
        }))
      });
    }
  }

  async createSyncRun(run: SyncRun, tx: PrismaTransaction = this.prisma) {
    return tx.syncRun.create({
      data: {
        id: run.id,
        companyId: run.companyId,
        runType: run.runType,
        source: run.source,
        status: run.status,
        startedAt: new Date(run.startedAt),
        finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
        countersJson: toJson(run.counters),
        llmStatsJson: toJson(run.llmStats),
        warningsJson: toJson(run.warnings),
        notes: run.notes,
        notionPageId: run.notionPageId,
        notionPageFingerprint: run.notionPageFingerprint
      }
    });
  }

  async updateSyncRun(run: SyncRun, tx: PrismaTransaction = this.prisma) {
    const isTerminal = run.status === "completed" || run.status === "failed";
    return tx.syncRun.update({
      where: { id: run.id },
      data: {
        status: run.status,
        finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
        countersJson: toJson(run.counters),
        llmStatsJson: toJson(run.llmStats),
        warningsJson: toJson(run.warnings),
        notes: run.notes,
        notionPageId: run.notionPageId,
        notionPageFingerprint: run.notionPageFingerprint,
        // Release lease on terminal status (no-op when leaseExpiresAt was never set)
        ...(isTerminal ? { leaseExpiresAt: null } : {})
      }
    });
  }

  /**
   * Atomically acquire a per-(company, runType) lease before creating a SyncRun.
   *
   * Uses PostgreSQL `pg_advisory_xact_lock` to serialize concurrent starters,
   * then checks for a live lease.  If the existing lease has expired, the
   * abandoned run is marked failed before the new run takes over.
   *
   * Call `updateSyncRun` with a terminal status to release the lease.
   */
  static readonly LEASE_DURATION_MS = 300_000;   // 5 minutes
  static readonly LEASE_RENEWAL_MS  = 120_000;   // 2 minutes

  async acquireRunLease(run: SyncRun) {
    if (!run.companyId) throw new Error("acquireRunLease requires companyId");

    return this.prisma.$transaction(async (tx) => {
      const lockKey = deterministicInt32(run.companyId + ":" + run.runType);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      const existing = await tx.syncRun.findFirst({
        where: { companyId: run.companyId!, runType: run.runType, status: "running" },
        orderBy: { startedAt: "desc" }
      });

      if (existing && existing.leaseExpiresAt && existing.leaseExpiresAt > new Date()) {
        throw new ConcurrentRunError(existing.id, run.runType);
      }

      if (existing) {
        await tx.syncRun.update({
          where: { id: existing.id },
          data: { status: "failed", finishedAt: new Date(), notes: "Lease expired — abandoned" }
        });
      }

      return tx.syncRun.create({
        data: {
          id: run.id,
          companyId: run.companyId,
          runType: run.runType,
          source: run.source,
          status: run.status,
          startedAt: new Date(run.startedAt),
          finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
          countersJson: toJson(run.counters),
          llmStatsJson: toJson(run.llmStats),
          warningsJson: toJson(run.warnings),
          notes: run.notes,
          notionPageId: run.notionPageId,
          notionPageFingerprint: run.notionPageFingerprint,
          leaseExpiresAt: new Date(Date.now() + RepositoryBundle.LEASE_DURATION_MS)
        }
      });
    });
  }

  /**
   * Extend the lease for a running SyncRun.  Returns false if the run is no
   * longer in "running" status (e.g. it was taken over after lease expiry).
   */
  async renewRunLease(runId: string): Promise<boolean> {
    const result = await this.prisma.syncRun.updateMany({
      where: { id: runId, status: "running" },
      data: { leaseExpiresAt: new Date(Date.now() + RepositoryBundle.LEASE_DURATION_MS) }
    });
    return result.count > 0;
  }

  async addCostEntries(entries: CostLedgerEntry[], tx: PrismaTransaction = this.prisma) {
    if (entries.length === 0) {
      return;
    }

    await tx.costLedgerEntry.createMany({
      data: entries.map((entry) => ({
        id: entry.id,
        step: entry.step,
        model: entry.model,
        mode: entry.mode,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        estimatedCostUsd: entry.estimatedCostUsd,
        runId: entry.runId,
        createdAt: new Date(entry.createdAt)
      }))
    });
  }

  async persistOpportunityGraph(opportunity: ContentOpportunity) {
    if (!opportunity.companyId) {
      throw new Error(`persistOpportunityGraph: opportunity ${opportunity.id} has no companyId — every opportunity must be scoped to a company`);
    }
    return this.prisma.$transaction(async (tx) => {
      await this.upsertOpportunity(opportunity, tx);
      await this.replaceOpportunityRelations(opportunity.id, opportunity.evidence, opportunity.primaryEvidence.id, opportunity.companyId!, tx);
    });
  }

  async persistDraftGraph(draft: DraftV1, opportunity: ContentOpportunity, companyId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.createDraft(draft, tx, companyId);
      await this.upsertOpportunity(opportunity, tx);
    });
  }

  async findOpportunitiesByIds(ids: string[]) {
    if (ids.length === 0) {
      return [];
    }

    return this.prisma.opportunity.findMany({
      where: {
        id: {
          in: ids
        }
      },
      include: opportunityInclude,
      orderBy: {
        updatedAt: "desc"
      }
    });
  }

  async updateOpportunityEditableFields(params: {
    opportunityId: string;
    title: string;
    angle: string;
    editorialClaim?: string;
    whyNow: string;
    whatItIsAbout: string;
    whatItIsNotAbout: string;
    editorialNotes: string;
    targetSegment?: string;
    editorialPillar?: string;
    awarenessTarget?: string;
    buyerFriction?: string;
    contentMotion?: string;
  }) {
    return this.prisma.opportunity.update({
      where: { id: params.opportunityId },
      data: {
        title: params.title,
        angle: params.angle,
        ...(params.editorialClaim !== undefined && { editorialClaim: params.editorialClaim }),
        whyNow: params.whyNow,
        whatItIsAbout: params.whatItIsAbout,
        whatItIsNotAbout: params.whatItIsNotAbout,
        editorialNotes: params.editorialNotes,
        ...(params.targetSegment !== undefined && { targetSegment: params.targetSegment }),
        ...(params.editorialPillar !== undefined && { editorialPillar: params.editorialPillar }),
        ...(params.awarenessTarget !== undefined && { awarenessTarget: params.awarenessTarget }),
        ...(params.buyerFriction !== undefined && { buyerFriction: params.buyerFriction }),
        ...(params.contentMotion !== undefined && { contentMotion: params.contentMotion }),
      },
      include: opportunityInclude
    });
  }

  async updateEvidenceSourceUrl(evidenceId: string, sourceUrl: string) {
    return this.prisma.evidenceReference.update({
      where: { id: evidenceId },
      data: { sourceUrl }
    });
  }

  async listCleanupCandidates(now: Date) {
    return this.prisma.sourceItem.findMany({
      where: {
        cleanupEligible: true,
        rawTextExpiresAt: {
          lte: now
        }
      }
    });
  }

  async cleanupSourceItemRawText(id: string) {
    return this.prisma.sourceItem.update({
      where: { id },
      data: {
        rawText: null,
        chunksJson: Prisma.JsonNull,
        rawTextStored: false,
        cleanupEligible: false
      }
    });
  }

  async listUsers(companyId: string) {
    return this.prisma.user.findMany({
      where: { companyId }
    });
  }

  async listRecentActiveOpportunities(params: { companyId: string; take: number }) {
    return this.prisma.opportunity.findMany({
      where: {
        companyId: params.companyId,
        status: { notIn: ["Rejected", "Archived"] }
      },
      orderBy: { updatedAt: "desc" },
      take: params.take,
      include: opportunityInclude
    });
  }

  async createOpportunityOnly(opportunity: ContentOpportunity, tx: PrismaTransaction) {
    return tx.opportunity.create({
      data: {
        id: opportunity.id,
        companyId: opportunity.companyId ?? "",
        sourceFingerprint: opportunity.sourceFingerprint,
        title: opportunity.title,
        ownerProfile: opportunity.ownerProfile,
        ownerUserId: opportunity.ownerUserId,
        narrativePillar: normalizeNarrativePillar(opportunity.narrativePillar),
        angle: opportunity.angle,
        editorialClaim: opportunity.editorialClaim ?? "",
        whyNow: opportunity.whyNow,
        whatItIsAbout: opportunity.whatItIsAbout,
        whatItIsNotAbout: opportunity.whatItIsNotAbout,
        routingStatus: opportunity.routingStatus,
        readiness: opportunity.readiness,
        status: opportunity.status,
        suggestedFormat: opportunity.suggestedFormat,
        supportingEvidenceCount: 0,
        evidenceFreshness: 0,
        primaryEvidenceId: null,
        editorialOwner: opportunity.editorialOwner,
        editorialNotes: opportunity.editorialNotes ?? "",
        dedupFlag: opportunity.dedupFlag ?? "",
        selectedAt: opportunity.selectedAt ? new Date(opportunity.selectedAt) : null,
        lastDigestAt: null,
        enrichmentLogJson: toJson(opportunity.enrichmentLog ?? []),
        v1HistoryJson: toJson(opportunity.v1History),
        notionPageId: opportunity.notionPageId,
        notionPageFingerprint: opportunity.notionPageFingerprint
      }
    });
  }

  async persistStandaloneEvidence(
    params: {
      evidence: EvidenceReference[];
      companyId: string;
      opportunityId: string;
      primaryEvidenceId: string | null;
      supportingEvidenceCount: number;
      evidenceFreshness: number;
      relevanceNote: string;
    },
    tx: PrismaTransaction
  ) {
    if (params.evidence.length > 0) {
      await tx.evidenceReference.createMany({
        data: params.evidence.map((item) => ({
          id: item.id,
          companyId: params.companyId,
          sourceItemId: item.sourceItemId,
          source: item.source,
          sourceUrl: item.sourceUrl,
          timestamp: new Date(item.timestamp),
          excerpt: item.excerpt,
          excerptHash: item.excerptHash,
          speakerOrAuthor: item.speakerOrAuthor,
          freshnessScore: item.freshnessScore
        })),
        skipDuplicates: true
      });

      await tx.opportunityEvidence.createMany({
        data: params.evidence.map((item) => ({
          opportunityId: params.opportunityId,
          evidenceId: item.id,
          relevanceNote: params.relevanceNote
        })),
        skipDuplicates: true
      });
    }

    if (params.primaryEvidenceId) {
      await validatePrimaryEvidenceOwnership(tx, params.opportunityId, params.primaryEvidenceId);
      await tx.opportunity.update({
        where: { id: params.opportunityId },
        data: {
          primaryEvidenceId: params.primaryEvidenceId,
          supportingEvidenceCount: params.supportingEvidenceCount,
          evidenceFreshness: params.evidenceFreshness
        }
      });
    }
  }

  async enrichOpportunity(params: {
    opportunityId: string;
    enrichmentLogJson: unknown;
    newEvidence: EvidenceReference[];
    primaryEvidenceId: string | null;
    supportingEvidenceCount: number;
    evidenceFreshness: number;
    companyId: string;
    relevanceNote: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.persistStandaloneEvidence(
        {
          evidence: params.newEvidence,
          companyId: params.companyId,
          opportunityId: params.opportunityId,
          primaryEvidenceId: params.primaryEvidenceId,
          supportingEvidenceCount: params.supportingEvidenceCount,
          evidenceFreshness: params.evidenceFreshness,
          relevanceNote: params.relevanceNote
        },
        tx
      );

      await tx.opportunity.update({
        where: { id: params.opportunityId },
        data: {
          enrichmentLogJson: toJson(params.enrichmentLogJson)
        }
      });
    });
  }

  async listCandidateSourceItems(params: { companyId: string; excludeIds?: string[]; take?: number }) {
    const take = params.take ?? 200;
    return this.prisma.sourceItem.findMany({
      where: {
        companyId: params.companyId,
        processedAt: { not: null },
        NOT: { metadataJson: { path: ["scopeExcluded"], equals: true } },
        ...(params.excludeIds && params.excludeIds.length > 0
          ? { id: { notIn: params.excludeIds } }
          : {})
      },
      orderBy: [
        // Bias toward curated/internal material: raw SQL CASE not available in Prisma orderBy,
        // so we rely on the source index and let the caller get a capped result set.
        // The caller filters and ranks by source policy in evidence-pack.ts.
        { occurredAt: "desc" }
      ],
      take
    });
  }

  async listSourceItemsByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return this.prisma.sourceItem.findMany({
      where: { id: { in: ids } }
    });
  }

  /**
   * Check whether an active (non-Rejected/Archived) opportunity already has
   * evidence originating from the given source item.  Searches both the legacy
   * direct FK path (EvidenceReference.opportunityId) and the junction table
   * (OpportunityEvidence).  Returns the opportunity ID if found.
   */
  async findActiveOpportunityByOriginSourceItem(params: {
    sourceItemId: string;
    companyId: string;
  }): Promise<{ id: string; title: string } | null> {
    // Path 1: OpportunityEvidence junction (new pipeline)
    const junctionMatch = await this.prisma.opportunityEvidence.findFirst({
      where: {
        evidence: { sourceItemId: params.sourceItemId },
        opportunity: {
          companyId: params.companyId,
          status: { notIn: ["Rejected", "Archived"] }
        }
      },
      select: { opportunityId: true, opportunity: { select: { title: true } } }
    });
    if (junctionMatch) {
      return { id: junctionMatch.opportunityId, title: junctionMatch.opportunity.title };
    }

    // Path 2: Direct FK (legacy pipeline)
    const fkMatch = await this.prisma.evidenceReference.findFirst({
      where: {
        sourceItemId: params.sourceItemId,
        opportunityId: { not: null },
        opportunity: {
          companyId: params.companyId,
          status: { notIn: ["Rejected", "Archived"] }
        }
      },
      select: { opportunityId: true, opportunity: { select: { title: true } } }
    });
    if (fkMatch?.opportunityId) {
      return { id: fkMatch.opportunityId, title: fkMatch.opportunity?.title ?? "" };
    }

    return null;
  }

  async saveScreeningResults(items: Array<{ id: string; result: ScreeningResult }>): Promise<{ missingIds: string[] }> {
    const missingIds: string[] = [];
    for (const item of items) {
      const updated = await this.prisma.sourceItem.updateMany({
        where: { id: item.id },
        data: {
          screeningResultJson: toJson(item.result)
        }
      });
      if (updated.count === 0) {
        missingIds.push(item.id);
      }
    }
    return { missingIds };
  }

}

async function validatePrimaryEvidenceOwnership(
  tx: PrismaTransaction,
  opportunityId: string,
  primaryEvidenceId: string | null
): Promise<void> {
  if (!primaryEvidenceId) return;
  const junctionLink = await tx.opportunityEvidence.findUnique({
    where: { opportunityId_evidenceId: { opportunityId, evidenceId: primaryEvidenceId } }
  });
  if (junctionLink) return;
  const fkLink = await tx.evidenceReference.findFirst({
    where: { id: primaryEvidenceId, opportunityId }
  });
  if (fkLink) return;
  throw new Error(`Primary evidence ${primaryEvidenceId} is not linked to opportunity ${opportunityId}`);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function nullableJson(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  return value === null ? Prisma.JsonNull : toJson(value);
}

function mapCompany(company: {
  id: string;
  slug: string;
  name: string;
  defaultTimezone: string;
  createdAt: Date;
  updatedAt: Date;
}): CompanyRecord {
  return {
    id: company.id,
    slug: company.slug,
    name: company.name,
    defaultTimezone: company.defaultTimezone,
    createdAt: company.createdAt.toISOString(),
    updatedAt: company.updatedAt.toISOString()
  };
}

export function validateOpportunityPrimaryEvidence(evidence: EvidenceReference[], primaryEvidenceId: string | null) {
  if (evidence.length === 0) {
    if (primaryEvidenceId !== null) {
      throw new Error("Primary evidence id must be null when opportunity evidence is empty.");
    }
    return;
  }

  if (!primaryEvidenceId) {
    throw new Error("Primary evidence id is required when opportunity evidence exists.");
  }

  if (!evidence.some((item) => item.id === primaryEvidenceId)) {
    throw new Error("Primary evidence id must reference an evidence row owned by the opportunity.");
  }
}

// ---------------------------------------------------------------------------
// Concurrency error (shared with sales-repositories.ts pattern)
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
