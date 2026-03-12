import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import type {
  ContentOpportunity,
  CostLedgerEntry,
  DigestDispatch,
  DraftV1,
  EditorialSignal,
  EvidenceReference,
  NotionDatabaseBinding,
  NormalizedSourceItem,
  ProfileBase,
  ProfileLearnedLayer,
  SyncRun,
  ThemeCluster
} from "../domain/types.js";
import { createDeterministicId } from "../lib/ids.js";

type PrismaTransaction = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

const opportunityInclude = {
  evidence: true,
  primaryEvidence: true,
  relatedSignals: true
} satisfies Prisma.OpportunityInclude;

export class RepositoryBundle {
  constructor(private readonly prisma: PrismaClient) {}

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

  async acquireDigestDispatch(params: {
    digestKey: string;
    channel: string;
    opportunityIds: string[];
    now: Date;
    leaseMs: number;
  }): Promise<{ action: "acquired" | "already_sent" | "inflight"; dispatch: DigestDispatch }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.digestDispatch.findUnique({
        where: { digestKey: params.digestKey }
      });

      if (existing?.status === "sent") {
        return {
          action: "already_sent" as const,
          dispatch: mapDigestDispatch(existing)
        };
      }

      if (existing?.status === "pending" && existing.leaseExpiresAt && existing.leaseExpiresAt > params.now) {
        return {
          action: "inflight" as const,
          dispatch: mapDigestDispatch(existing)
        };
      }

      const leaseExpiresAt = new Date(params.now.getTime() + params.leaseMs);
      const dispatch = existing
        ? await tx.digestDispatch.update({
            where: { digestKey: params.digestKey },
            data: {
              status: "pending",
              channel: params.channel,
              opportunityIdsJson: toJson(params.opportunityIds),
              leaseExpiresAt,
              slackMessageTs: null,
              sentAt: null,
              error: null
            }
          })
        : await tx.digestDispatch.create({
            data: {
              id: createDeterministicId("digest-dispatch", [params.digestKey]),
              digestKey: params.digestKey,
              status: "pending",
              channel: params.channel,
              opportunityIdsJson: toJson(params.opportunityIds),
              leaseExpiresAt
            }
          });

      return {
        action: "acquired" as const,
        dispatch: mapDigestDispatch(dispatch)
      };
    });
  }

  async finalizeDigestDispatch(params: {
    digestKey: string;
    slackMessageTs: string;
    sentAt: Date;
    opportunityIds: string[];
  }) {
    return this.prisma.$transaction(async (tx) => {
      const dispatch = await tx.digestDispatch.update({
        where: { digestKey: params.digestKey },
        data: {
          status: "sent",
          slackMessageTs: params.slackMessageTs,
          sentAt: params.sentAt,
          leaseExpiresAt: null,
          error: null
        }
      });

      await tx.opportunity.updateMany({
        where: {
          id: {
            in: params.opportunityIds
          }
        },
        data: {
          lastDigestAt: params.sentAt
        }
      });

      const opportunities = await tx.opportunity.findMany({
        where: {
          id: {
            in: params.opportunityIds
          }
        },
        include: opportunityInclude,
        orderBy: {
          updatedAt: "desc"
        }
      });

      return {
        dispatch: mapDigestDispatch(dispatch),
        opportunities
      };
    });
  }

  async listRecoverableDigestDispatches(channel: string, now: Date, take: number) {
    const lookback = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dispatches = await this.prisma.digestDispatch.findMany({
      where: {
        channel,
        status: {
          in: ["pending", "failed"]
        },
        createdAt: {
          gte: lookback
        }
      },
      orderBy: {
        createdAt: "asc"
      },
      take
    });

    return dispatches.map(mapDigestDispatch);
  }

  async markDigestDispatchFailed(digestKey: string, error: string, tx: PrismaTransaction = this.prisma) {
    return tx.digestDispatch.updateMany({
      where: { digestKey },
      data: {
        status: "failed",
        error,
        leaseExpiresAt: null
      }
    });
  }

  async getCursor(source: string) {
    const cursor = await this.prisma.sourceCursor.findUnique({
      where: { source }
    });
    return cursor?.cursor ?? null;
  }

  async setCursor(source: string, cursor: string | null, tx: PrismaTransaction = this.prisma) {
    return tx.sourceCursor.upsert({
      where: { source },
      create: {
        id: source,
        source,
        cursor
      },
      update: {
        cursor
      }
    });
  }

  async upsertSourceItem(item: NormalizedSourceItem, rawTextExpiresAt: Date | null, tx: PrismaTransaction = this.prisma) {
    return tx.sourceItem.upsert({
      where: {
        source_sourceItemId: {
          source: item.source,
          sourceItemId: item.sourceItemId
        }
      },
      create: {
        id: item.externalId,
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
        cleanupEligible: rawTextExpiresAt !== null
      },
      update: {
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
        cleanupEligible: rawTextExpiresAt !== null
      }
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

  async upsertSignal(signal: EditorialSignal, tx: PrismaTransaction = this.prisma) {
    return tx.signal.upsert({
      where: { id: signal.id },
      create: {
        id: signal.id,
        sourceFingerprint: signal.sourceFingerprint,
        title: signal.title,
        summary: signal.summary,
        type: signal.type,
        freshness: signal.freshness,
        confidence: signal.confidence,
        probableOwnerProfile: signal.probableOwnerProfile,
        suggestedAngle: signal.suggestedAngle,
        status: signal.status,
        sensitivityJson: toJson(signal.sensitivity),
        duplicateOfSignalId: signal.duplicateOfSignalId,
        themeClusterKey: signal.themeClusterKey,
        notionPageId: signal.notionPageId,
        notionPageFingerprint: signal.notionPageFingerprint
      },
      update: {
        sourceFingerprint: signal.sourceFingerprint,
        title: signal.title,
        summary: signal.summary,
        type: signal.type,
        freshness: signal.freshness,
        confidence: signal.confidence,
        probableOwnerProfile: signal.probableOwnerProfile,
        suggestedAngle: signal.suggestedAngle,
        status: signal.status,
        sensitivityJson: toJson(signal.sensitivity),
        duplicateOfSignalId: signal.duplicateOfSignalId,
        themeClusterKey: signal.themeClusterKey,
        notionPageId: signal.notionPageId,
        notionPageFingerprint: signal.notionPageFingerprint
      }
    });
  }

  async updateSignalNotionSync(signalId: string, notionPageId: string, notionPageFingerprint: string) {
    return this.prisma.signal.update({
      where: { id: signalId },
      data: {
        notionPageId,
        notionPageFingerprint
      }
    });
  }

  async replaceSignalRelations(
    signalId: string,
    evidence: EvidenceReference[],
    sourceItemIds: string[],
    tx: PrismaTransaction = this.prisma
  ) {
    await tx.evidenceReference.deleteMany({
      where: { signalId }
    });
    await tx.signalSourceItem.deleteMany({
      where: { signalId }
    });

    if (evidence.length > 0) {
      await tx.evidenceReference.createMany({
        data: evidence.map((item) => ({
          id: item.id,
          signalId,
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

    if (sourceItemIds.length > 0) {
      await tx.signalSourceItem.createMany({
        data: sourceItemIds.map((sourceItemId) => ({
          signalId,
          sourceItemId
        }))
      });
    }
  }

  async upsertThemeCluster(cluster: ThemeCluster, tx: PrismaTransaction = this.prisma) {
    return tx.themeCluster.upsert({
      where: { key: cluster.key },
      create: {
        key: cluster.key,
        title: cluster.title,
        profileHint: cluster.profileHint,
        evidenceCount: cluster.evidenceCount
      },
      update: {
        title: cluster.title,
        profileHint: cluster.profileHint,
        evidenceCount: cluster.evidenceCount
      }
    });
  }

  async upsertProfileBase(profile: ProfileBase, tx: PrismaTransaction = this.prisma) {
    return tx.profileBase.upsert({
      where: { profileId: profile.profileId },
      create: {
        profileId: profile.profileId,
        role: profile.role,
        languagePreference: profile.languagePreference,
        toneSummary: profile.toneSummary,
        preferredStructure: profile.preferredStructure,
        typicalPhrasesJson: toJson(profile.typicalPhrases),
        avoidRulesJson: toJson(profile.avoidRules),
        contentTerritoriesJson: toJson(profile.contentTerritories),
        weakFitTerritoriesJson: toJson(profile.weakFitTerritories),
        sampleExcerptsJson: toJson(profile.sampleExcerpts),
        sourcePath: profile.sourcePath,
        notionPageId: profile.notionPageId,
        notionPageFingerprint: profile.notionPageFingerprint
      },
      update: {
        role: profile.role,
        languagePreference: profile.languagePreference,
        toneSummary: profile.toneSummary,
        preferredStructure: profile.preferredStructure,
        typicalPhrasesJson: toJson(profile.typicalPhrases),
        avoidRulesJson: toJson(profile.avoidRules),
        contentTerritoriesJson: toJson(profile.contentTerritories),
        weakFitTerritoriesJson: toJson(profile.weakFitTerritories),
        sampleExcerptsJson: toJson(profile.sampleExcerpts),
        sourcePath: profile.sourcePath,
        notionPageId: profile.notionPageId,
        notionPageFingerprint: profile.notionPageFingerprint
      }
    });
  }

  async updateProfileBaseNotionSync(profileId: string, notionPageId: string, notionPageFingerprint: string) {
    return this.prisma.profileBase.update({
      where: { profileId },
      data: {
        notionPageId,
        notionPageFingerprint
      }
    });
  }

  async upsertProfileLearnedLayer(profile: ProfileLearnedLayer, tx: PrismaTransaction = this.prisma) {
    return tx.profileLearnedLayer.upsert({
      where: { profileId: profile.profileId },
      create: {
        profileId: profile.profileId,
        recurringPhrasesJson: toJson(profile.recurringPhrases),
        structuralPatternsJson: toJson(profile.structuralPatterns),
        evidenceExcerptIdsJson: toJson(profile.evidenceExcerptIds),
        lastIncrementalUpdateAt: new Date(profile.lastIncrementalUpdateAt),
        lastWeeklyRecomputeAt: profile.lastWeeklyRecomputeAt ? new Date(profile.lastWeeklyRecomputeAt) : null
      },
      update: {
        recurringPhrasesJson: toJson(profile.recurringPhrases),
        structuralPatternsJson: toJson(profile.structuralPatterns),
        evidenceExcerptIdsJson: toJson(profile.evidenceExcerptIds),
        lastIncrementalUpdateAt: new Date(profile.lastIncrementalUpdateAt),
        lastWeeklyRecomputeAt: profile.lastWeeklyRecomputeAt ? new Date(profile.lastWeeklyRecomputeAt) : null
      }
    });
  }

  async upsertOpportunity(opportunity: ContentOpportunity, tx: PrismaTransaction = this.prisma) {
    const supportingEvidenceCount = Math.max(0, opportunity.evidence.length - 1);
    return tx.opportunity.upsert({
      where: { id: opportunity.id },
      create: {
        id: opportunity.id,
        sourceFingerprint: opportunity.sourceFingerprint,
        title: opportunity.title,
        ownerProfile: opportunity.ownerProfile,
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
        lastDigestAt: opportunity.lastDigestAt ? new Date(opportunity.lastDigestAt) : null,
        v1HistoryJson: toJson(opportunity.v1History),
        notionPageId: opportunity.notionPageId,
        notionPageFingerprint: opportunity.notionPageFingerprint
      },
      update: {
        sourceFingerprint: opportunity.sourceFingerprint,
        title: opportunity.title,
        ownerProfile: opportunity.ownerProfile,
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
        lastDigestAt: opportunity.lastDigestAt ? new Date(opportunity.lastDigestAt) : null,
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
    signalIds: string[] | null,
    tx: PrismaTransaction = this.prisma
  ) {
    validateOpportunityPrimaryEvidence(evidence, primaryEvidenceId);

    await tx.evidenceReference.deleteMany({
      where: { opportunityId }
    });
    if (signalIds !== null) {
      await tx.opportunitySignal.deleteMany({
        where: { opportunityId }
      });
    }

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

    if (signalIds && signalIds.length > 0) {
      await tx.opportunitySignal.createMany({
        data: signalIds.map((signalId) => ({
          opportunityId,
          signalId
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

  async createDraft(draft: DraftV1, tx: PrismaTransaction = this.prisma) {
    await tx.draft.create({
      data: {
        id: draft.id,
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

  async persistSignalGraph(params: {
    sourceItem: NormalizedSourceItem;
    rawTextExpiresAt: Date | null;
    signal: EditorialSignal;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.upsertSourceItem(params.sourceItem, params.rawTextExpiresAt, tx);
      await this.upsertSignal(params.signal, tx);
      await this.replaceSignalRelations(params.signal.id, params.signal.evidence, params.signal.sourceItemIds, tx);
    });
  }

  async persistOpportunityGraph(opportunity: ContentOpportunity, signalIds: string[]) {
    return this.prisma.$transaction(async (tx) => {
      await this.upsertOpportunity(opportunity, tx);
      await this.replaceOpportunityRelations(opportunity.id, opportunity.evidence, opportunity.primaryEvidence.id, signalIds, tx);
    });
  }

  async persistDraftGraph(draft: DraftV1, opportunity: ContentOpportunity) {
    return this.prisma.$transaction(async (tx) => {
      await this.createDraft(draft, tx);
      await this.upsertOpportunity(opportunity, tx);
    });
  }

  async listSignalsForClustering() {
    return this.prisma.signal.findMany({
      include: {
        evidence: true
      }
    });
  }

  async listOpportunitiesForDigest() {
    return this.prisma.opportunity.findMany({
      where: {
        status: {
          in: ["To review", "Ready for V1", "V1 generated"]
        }
      },
      include: opportunityInclude,
      orderBy: {
        updatedAt: "desc"
      }
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

  async listProfiles() {
    const [bases, learnedLayers] = await Promise.all([
      this.prisma.profileBase.findMany(),
      this.prisma.profileLearnedLayer.findMany()
    ]);

    return { bases, learnedLayers };
  }

  async countDraftsForProfileToday(profileId: string, startOfDay: Date, endOfDay: Date) {
    return this.prisma.draft.count({
      where: {
        profileId,
        createdAt: {
          gte: startOfDay,
          lt: endOfDay
        }
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

  async markOpportunitiesDigested(opportunityIds: string[], digestedAt: Date) {
    if (opportunityIds.length === 0) {
      return [];
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.opportunity.updateMany({
        where: {
          id: {
            in: opportunityIds
          }
        },
        data: {
          lastDigestAt: digestedAt
        }
      });

      return tx.opportunity.findMany({
        where: {
          id: {
            in: opportunityIds
          }
        },
        include: opportunityInclude,
        orderBy: {
          updatedAt: "desc"
        }
      });
    });
  }

  async listOpportunitiesForEvidenceRepairBatch(params: { afterId?: string; take: number }) {
    return this.prisma.opportunity.findMany({
      ...(params.afterId
        ? {
            cursor: { id: params.afterId },
            skip: 1
          }
        : {}),
      take: params.take,
      include: {
        ...opportunityInclude,
        relatedSignals: {
          include: {
            signal: {
              include: {
                evidence: true
              }
            }
          }
        }
      },
      orderBy: {
        id: "asc"
      }
    });
  }

  async repairOpportunityEvidence(params: {
    opportunityId: string;
    evidence: EvidenceReference[];
    primaryEvidenceId: string;
    supportingEvidenceCount: number;
    evidenceFreshness: number;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.opportunity.update({
        where: { id: params.opportunityId },
        data: {
          supportingEvidenceCount: params.supportingEvidenceCount,
          evidenceFreshness: params.evidenceFreshness
        }
      });
      await this.replaceOpportunityRelations(
        params.opportunityId,
        params.evidence,
        params.primaryEvidenceId,
        null,
        tx
      );

      return tx.opportunity.findUniqueOrThrow({
        where: { id: params.opportunityId },
        include: opportunityInclude
      });
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
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function nullableJson(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  return value === null ? Prisma.JsonNull : toJson(value);
}

function mapDigestDispatch(dispatch: {
  digestKey: string;
  status: string;
  channel: string;
  opportunityIdsJson: unknown;
  slackMessageTs: string | null;
  sentAt: Date | null;
  leaseExpiresAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}): DigestDispatch {
  return {
    digestKey: dispatch.digestKey,
    status: dispatch.status as DigestDispatch["status"],
    channel: dispatch.channel,
    opportunityIds: expectStringArray(dispatch.opportunityIdsJson),
    slackMessageTs: dispatch.slackMessageTs ?? undefined,
    sentAt: dispatch.sentAt?.toISOString(),
    leaseExpiresAt: dispatch.leaseExpiresAt?.toISOString(),
    error: dispatch.error ?? undefined,
    createdAt: dispatch.createdAt.toISOString(),
    updatedAt: dispatch.updatedAt.toISOString()
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

function expectStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("Expected persisted JSON array");
  }

  return value.map((item) => String(item));
}
