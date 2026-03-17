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
  NotionDatabaseBinding,
  NormalizedSourceItem,
  ScreeningResult,
  SourceConfigRecord,
  SyncRun,
  UserRecord
} from "../domain/types.js";
import { createDeterministicId } from "../lib/ids.js";

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

  async getNotionDatabaseBinding(parentPageId: string, name: string): Promise<NotionDatabaseBinding | null> {
    const binding = await this.prisma.notionDatabaseBinding.findUnique({
      where: {
        parentPageId_name: {
          parentPageId,
          name
        }
      }
    });

    if (!binding) {
      return null;
    }

    return {
      name: binding.name,
      parentPageId: binding.parentPageId,
      databaseId: binding.databaseId,
      createdAt: binding.createdAt.toISOString(),
      updatedAt: binding.updatedAt.toISOString()
    };
  }

  async upsertNotionDatabaseBinding(parentPageId: string, name: string, databaseId: string, tx: PrismaTransaction = this.prisma) {
    return tx.notionDatabaseBinding.upsert({
      where: {
        parentPageId_name: {
          parentPageId,
          name
        }
      },
      create: {
        id: createDeterministicId("notion-db", [parentPageId, name]),
        parentPageId,
        name,
        databaseId
      },
      update: {
        databaseId
      }
    });
  }

  async clearNotionDatabaseBinding(parentPageId: string, name: string, tx: PrismaTransaction = this.prisma) {
    await tx.notionDatabaseBinding.deleteMany({
      where: {
        parentPageId,
        name
      }
    });
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

  async updateSourceItemNotionSync(sourceItemId: string, notionPageId: string, notionPageFingerprint: string) {
    return this.prisma.sourceItem.update({
      where: { id: sourceItemId },
      data: {
        notionPageId,
        notionPageFingerprint
      }
    });
  }

  async upsertOpportunity(opportunity: ContentOpportunity, tx: PrismaTransaction = this.prisma) {
    const supportingEvidenceCount = Math.max(0, opportunity.evidence.length - 1);
    return tx.opportunity.upsert({
      where: { id: opportunity.id },
      create: {
        id: opportunity.id,
        companyId: opportunity.companyId ?? "",
        sourceFingerprint: opportunity.sourceFingerprint,
        title: opportunity.title,
        ownerProfile: opportunity.ownerProfile,
        ownerUserId: opportunity.ownerUserId,
        narrativePillar: opportunity.narrativePillar,
        angle: opportunity.angle,
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
        narrativePillar: opportunity.narrativePillar,
        angle: opportunity.angle,
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
        selectedAt: opportunity.selectedAt ? new Date(opportunity.selectedAt) : null,
        lastDigestAt: null,
        v1HistoryJson: toJson(opportunity.v1History),
        notionPageId: opportunity.notionPageId,
        notionPageFingerprint: opportunity.notionPageFingerprint
      }
    });
  }

  async updateOpportunityNotionSync(opportunityId: string, notionPageId: string, notionPageFingerprint: string) {
    return this.prisma.opportunity.update({
      where: { id: opportunityId },
      data: {
        notionPageId,
        notionPageFingerprint
      }
    });
  }

  async replaceOpportunityRelations(
    opportunityId: string,
    evidence: EvidenceReference[],
    primaryEvidenceId: string | null,
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

  async createDraft(draft: DraftV1, tx: PrismaTransaction = this.prisma, companyId?: string) {
    await tx.draft.create({
      data: {
        id: draft.id,
        companyId: companyId ?? null,
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
          companyId: companyId ?? null,
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
        notionPageFingerprint: run.notionPageFingerprint
      }
    });
  }

  async updateSyncRunNotionSync(runId: string, notionPageId: string, notionPageFingerprint: string) {
    return this.prisma.syncRun.update({
      where: { id: runId },
      data: {
        notionPageId,
        notionPageFingerprint
      }
    });
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
    return this.prisma.$transaction(async (tx) => {
      await this.upsertOpportunity(opportunity, tx);
      await this.replaceOpportunityRelations(opportunity.id, opportunity.evidence, opportunity.primaryEvidence.id, tx);
    });
  }

  async persistDraftGraph(draft: DraftV1, opportunity: ContentOpportunity, companyId?: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.createDraft(draft, tx, companyId ?? opportunity.companyId);
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

  async findOpportunityByNotionPageId(notionPageId: string) {
    return this.prisma.opportunity.findFirst({
      where: { notionPageId },
      include: opportunityInclude
    });
  }

  async markOpportunitySelected(opportunityId: string, editorialOwner: string) {
    return this.prisma.opportunity.update({
      where: { id: opportunityId },
      data: {
        editorialOwner,
        selectedAt: new Date(),
        status: "Selected"
      },
      include: opportunityInclude
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
        narrativePillar: opportunity.narrativePillar,
        angle: opportunity.angle,
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
        }))
      });

      await tx.opportunityEvidence.createMany({
        data: params.evidence.map((item) => ({
          opportunityId: params.opportunityId,
          evidenceId: item.id,
          relevanceNote: params.relevanceNote
        }))
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

  async saveScreeningResults(items: Array<{ id: string; result: ScreeningResult }>) {
    for (const item of items) {
      await this.prisma.sourceItem.update({
        where: { id: item.id },
        data: {
          screeningResultJson: toJson(item.result)
        }
      });
    }
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
