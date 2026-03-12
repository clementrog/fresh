import { endOfDay, startOfDay, subDays } from "date-fns";

import { loadConnectorConfigs, loadDoctrineMarkdown, loadProfileBases, loadSensitivityMarkdown } from "./config/loaders.js";
import type { AppEnv } from "./config/env.js";
import { createConnectorRegistry } from "./connectors/index.js";
import { getPrisma } from "./db/client.js";
import { RepositoryBundle } from "./db/repositories.js";
import type {
  ConnectorConfig,
  ContentOpportunity,
  EditorialSignal,
  EvidenceReference,
  NormalizedSourceItem,
  ProfileBase,
  ProfileSnapshot,
  RunContext,
  RunType,
  SyncRun
} from "./domain/types.js";
import { hashParts } from "./lib/ids.js";
import {
  buildEvidenceReferences,
  dedupeEvidenceReferences,
  evidenceSignature,
  scopeEvidenceReferences,
  selectPrimaryEvidence
} from "./services/evidence.js";
import { maybeGenerateDraft } from "./services/drafts.js";
import { buildThemeClusters, markObviousDuplicates } from "./services/dedupe.js";
import type { LlmUsage } from "./services/llm.js";
import { LlmClient } from "./services/llm.js";
import { buildSpikeWarnings, createCostEntry, createRun, finalizeRun } from "./services/observability.js";
import { NotionService } from "./services/notion.js";
import { maybeCreateOpportunity, qualifyDraftCandidate } from "./services/opportunities.js";
import { buildDailyLearnedLayer, buildWeeklyLearnedLayer, mergeProfileSnapshot } from "./services/profiles.js";
import { computeRawTextExpiry } from "./services/retention.js";
import { assessSensitivity } from "./services/sensitivity.js";
import { SlackService } from "./services/slack.js";
import { extractSignalFromItem } from "./services/signal-extractor.js";
import { resolveTerritory } from "./services/territory.js";

type LoggerLike = {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

export class EditorialSignalEngineApp {
  private readonly prisma;
  private readonly repositories;
  private readonly llmClient: LlmClient;
  private readonly notion: NotionService;
  private readonly slack: SlackService;

  constructor(
    private readonly env: AppEnv,
    private readonly logger: LoggerLike,
    deps: Partial<{
      prisma: ReturnType<typeof getPrisma>;
      repositories: RepositoryBundle;
      llmClient: LlmClient;
      notion: NotionService;
      slack: SlackService;
    }> = {}
  ) {
    this.prisma = deps.prisma ?? getPrisma();
    this.repositories = deps.repositories ?? new RepositoryBundle(this.prisma);
    this.llmClient = deps.llmClient ?? new LlmClient(env, logger);
    this.notion =
      deps.notion ??
      new NotionService(env.NOTION_TOKEN, env.NOTION_PARENT_PAGE_ID, {
        bindings: this.repositories,
        onWarning: (warning) => this.logger.warn?.({ warning }, "Notion self-heal warning")
      });
    this.slack = deps.slack ?? new SlackService(env);
  }

  async run(command: RunType, options: { dryRun?: boolean } = {}) {
    const context: RunContext = {
      dryRun: options.dryRun ?? false,
      now: new Date()
    };

    switch (command) {
      case "setup:notion":
        return this.setupNotion();
      case "sync:daily":
        return this.syncDaily(context);
      case "digest:send":
        return this.sendDigest(context);
      case "selection:scan":
        return this.scanSelections(context);
      case "profile:weekly-recompute":
        return this.recomputeProfiles(context);
      case "cleanup:retention":
        return this.cleanupRetention(context);
      case "backfill":
        return this.backfill(context);
      case "repair:opportunity-evidence":
        return this.repairOpportunityEvidence(context);
      default:
        throw new Error(`Unsupported command: ${command satisfies never}`);
    }
  }

  private async setupNotion() {
    const result = await this.notion.ensureSchema();
    this.logger.info({ databases: result.databases, views: result.viewSpecs }, "Notion schema ensured");
  }

  private async syncDaily(context: RunContext) {
    const run = createRun("sync:daily");
    const costs: Array<ReturnType<typeof createCostEntry>> = [];
    const fallbackSteps = new Set<string>();
    if (!context.dryRun) {
      await this.repositories.createSyncRun(run);
    }

    try {
      const staticInputs = await this.loadStaticInputs(context);
      const registry = createConnectorRegistry(this.env);
      const normalizedById = new Map<string, NormalizedSourceItem>();
      const sourceMaxCursor = new Map<string, string | null>();
      const discoveredSignals: EditorialSignal[] = [];

      for (const config of staticInputs.configs.filter((entry) => entry.enabled)) {
        const rawItems = await this.fetchSourceItems(config, registry[config.source], context);
        run.counters.fetched += rawItems.length;
        const sortedItems = [...rawItems].sort((left, right) => compareCursors(left.cursor, right.cursor));
        const maxCursor = sortedItems.reduce<string | null>(
          (current, item) => maxCursorValue(current, item.cursor),
          await this.repositories.getCursor(config.source)
        );

        for (const rawItem of sortedItems) {
          const normalized = await registry[config.source].normalize(rawItem, config as never, context);
          normalizedById.set(normalized.externalId, normalized);
          run.counters.normalized += 1;

          const evidence = buildEvidenceReferences(normalized);
          const sensitivity = await assessSensitivity(normalized, staticInputs.sensitivityMarkdown, this.llmClient);
          this.recordUsage(run, costs, sensitivity.usage, `${config.source}:sensitivity`, fallbackSteps);

          const extracted = await extractSignalFromItem(normalized, evidence, this.llmClient, staticInputs.doctrineMarkdown);
          this.recordUsage(run, costs, extracted.usage, `${config.source}:signal`, fallbackSteps);

          const signal: EditorialSignal = {
            ...extracted.signal,
            sensitivity: sensitivity.assessment,
            status: sensitivity.assessment.blocked || sensitivity.assessment.categories.length > 0 ? "Sensitive review" : extracted.signal.status
          };

          if (signal.sensitivity.blocked) {
            run.counters.sensitivityBlocked += 1;
          }

          discoveredSignals.push(signal);
        }

        sourceMaxCursor.set(config.source, maxCursor);
      }

      const dedupedSignals = markObviousDuplicates(discoveredSignals);
      const clusters = buildThemeClusters(dedupedSignals);
      const clusterConflictKeys = new Set(clusters.filter((cluster) => cluster.signalIds.length > 1).map((cluster) => cluster.key));

      if (!context.dryRun) {
        for (const cluster of clusters) {
          await this.repositories.upsertThemeCluster(cluster);
        }
      }

      const opportunities: ContentOpportunity[] = [];
      for (const signal of dedupedSignals) {
        signal.themeClusterKey = signal.themeClusterKey ?? clusters.find((cluster) => cluster.signalIds.includes(signal.id))?.key;
        const normalized = normalizedById.get(signal.sourceItemIds[0] ?? "");
        if (!normalized) {
          continue;
        }

        if (!context.dryRun) {
          await this.repositories.persistSignalGraph({
            sourceItem: normalized,
            rawTextExpiresAt: computeRawTextExpiry(this.findConfig(staticInputs.configs, normalized.source), context.now),
            signal
          });

          const signalSync = await this.notion.syncSignal(signal);
          if (signalSync) {
            run.counters[signalSync.action === "created" ? "notionCreates" : "notionUpdates"] += 1;
            await this.repositories.updateSignalNotionSync(signal.id, signalSync.notionPageId, signal.notionPageFingerprint);
          }

          if (normalized.source === "market-findings") {
            const findingSync = await this.notion.syncMarketFinding({
              title: normalized.title,
              theme: String(normalized.metadata.theme ?? "General"),
              source: String(normalized.metadata.source ?? normalized.sourceUrl),
              confidence: Number(normalized.metadata.confidence ?? 0.6),
              possibleOwner: normalized.metadata.possibleOwner ? String(normalized.metadata.possibleOwner) : null,
              editorialAngle: String(normalized.metadata.editorialAngle ?? ""),
              status: String(normalized.metadata.status ?? "New"),
              notionPageFingerprint: normalized.sourceFingerprint
            });
            if (findingSync) {
              run.counters[findingSync.action === "created" ? "notionCreates" : "notionUpdates"] += 1;
              await this.repositories.updateSourceItemNotionSync(normalized.externalId, findingSync.notionPageId, normalized.sourceFingerprint);
            }
          }
        }
        run.counters.signalsCreated += 1;

        const territory = await resolveTerritory(signal, this.llmClient);
        this.recordUsage(run, costs, territory.usage, `${signal.id}:territory`, fallbackSteps);

        const opportunity = maybeCreateOpportunity({
          signal,
          assignment: territory.assignment,
          clusterConflict: Boolean(signal.themeClusterKey && clusterConflictKeys.has(signal.themeClusterKey))
        });

        if (!opportunity) {
          continue;
        }

        const qualified = qualifyDraftCandidate(opportunity, Boolean(signal.themeClusterKey && clusterConflictKeys.has(signal.themeClusterKey)));
        opportunities.push(qualified);
        if (!context.dryRun) {
          await this.repositories.persistOpportunityGraph(qualified, [signal.id]);
          const opportunitySync = await this.notion.syncOpportunity(qualified, null);
          if (opportunitySync) {
            run.counters[opportunitySync.action === "created" ? "notionCreates" : "notionUpdates"] += 1;
            await this.repositories.updateOpportunityNotionSync(qualified.id, opportunitySync.notionPageId, qualified.notionPageFingerprint);
          }
        }
        run.counters.opportunitiesCreated += 1;
      }

      const profileSnapshots = await this.refreshProfiles(staticInputs.profileBases, false, context);
      for (const opportunity of opportunities) {
        if (!opportunity.ownerProfile) {
          continue;
        }
        const profile = profileSnapshots.get(opportunity.ownerProfile);
        if (!profile) {
          continue;
        }

        const todayStart = startOfDay(context.now);
        const todayEnd = endOfDay(context.now);
        const draftCount = context.dryRun
          ? opportunities.filter((item) => item.ownerProfile === opportunity.ownerProfile && item.readiness === "V1 generated").length
          : await this.repositories.countDraftsForProfileToday(opportunity.ownerProfile, todayStart, todayEnd);
        if (draftCount >= 2) {
          continue;
        }

        if (opportunity.primaryEvidence.excerpt.length === 0) {
          continue;
        }

        const draft = await maybeGenerateDraft({
          opportunity,
          profile,
          llmClient: this.llmClient,
          clusterConflict: false,
          sensitivityRulesMarkdown: staticInputs.sensitivityMarkdown,
          doctrine: staticInputs.doctrineMarkdown
        }).catch((error) => {
          this.logger.error({ error, opportunityId: opportunity.id }, "Draft generation failed");
          return {
            draft: null,
            usageEvents: [
              {
                step: "draft-generation" as const,
                usage: {
                  mode: "fallback" as const,
                  promptTokens: 0,
                  completionTokens: 0,
                  estimatedCostUsd: 0,
                  error: error instanceof Error ? error.message : "Unknown draft generation error"
                }
              }
            ]
          };
        });

        for (const usageEvent of draft.usageEvents) {
          this.recordUsage(run, costs, usageEvent.usage, `${opportunity.id}:${usageEvent.step}`, fallbackSteps);
        }
        if (!draft.draft) {
          continue;
        }

        opportunity.readiness = "V1 generated";
        opportunity.status = "V1 generated";
        opportunity.v1History = [...opportunity.v1History, draft.draft.firstDraftText];

        if (!context.dryRun) {
          await this.repositories.persistDraftGraph(draft.draft, opportunity);
          const syncResult = await this.notion.syncOpportunity(opportunity, draft.draft);
          if (syncResult) {
            run.counters[syncResult.action === "created" ? "notionCreates" : "notionUpdates"] += 1;
            await this.repositories.updateOpportunityNotionSync(opportunity.id, syncResult.notionPageId, opportunity.notionPageFingerprint);
          }
        }
        run.counters.draftsCreated += 1;
      }

      if (!context.dryRun) {
        for (const [source, cursor] of sourceMaxCursor.entries()) {
          await this.repositories.setCursor(source, cursor);
        }
      }

      this.applyFallbackThresholds(run, fallbackSteps);
      run.warnings = [...run.warnings, ...buildSpikeWarnings(run.counters)];
      const finished = finalizeRun(run, "completed", context.dryRun ? "Daily sync dry-run completed" : "Daily sync completed");
      await this.finishRun(finished, costs, context);
      this.logger.info({ run: finished }, "Daily sync completed");
    } catch (error) {
      const failed = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown error");
      await this.finishRun(failed, costs, context);
      this.logger.error({ error }, "Daily sync failed");
      throw error;
    }
  }

  private async sendDigest(context: RunContext) {
    const run = createRun("digest:send");
    if (!context.dryRun) {
      await this.repositories.createSyncRun(run);
    }

    try {
      const channelId = context.dryRun ? null : await this.slack.resolveDigestChannelId();
      if (!context.dryRun && !channelId) {
        throw new Error("Slack digest could not resolve a delivery channel.");
      }

      const blockedOpportunityIds = channelId ? await this.recoverDigestDispatches(channelId, run, context) : new Set<string>();
      const opportunityRows = await this.repositories.listOpportunitiesForDigest();
      const digestCandidates = opportunityRows
        .filter((opportunity) => opportunity.routingStatus !== "Needs routing" && opportunity.status !== "Selected")
        .filter((row) => !blockedOpportunityIds.has(row.id))
        .map((row) => ({
          row,
          opportunity: this.mapOpportunityRow(row)
        }));
      const missingNotion = digestCandidates
        .filter(({ opportunity }) => !opportunity.notionPageId)
        .map(({ opportunity }) => opportunity.id);
      if (missingNotion.length > 0) {
        run.warnings.push(`Digest skipped ${missingNotion.length} opportunities without Notion pages`);
      }

      const deliveryEntries = pickDigestDeliverySet(
        digestCandidates.filter(({ opportunity, row }) => Boolean(opportunity.notionPageId) && (!row.lastDigestAt || row.updatedAt > row.lastDigestAt))
      );
      const deliveryOpportunities = deliveryEntries.map(({ opportunity }) => opportunity);

      if (!context.dryRun && channelId && deliveryEntries.length > 0) {
        const digestKey = buildDigestKey(
          deliveryEntries.map(({ row }) => ({
            id: row.id,
            updatedAt: row.updatedAt.toISOString()
          })),
          channelId
        );
        const dispatchAttempt = await this.repositories.acquireDigestDispatch({
          digestKey,
          channel: channelId,
          opportunityIds: deliveryOpportunities.map((opportunity) => opportunity.id),
          now: context.now,
          leaseMs: 10 * 60 * 1000
        });

        if (dispatchAttempt.action === "already_sent") {
          const finished = finalizeRun(run, "completed", `Digest ${digestKey} already sent`);
          await this.finishRun(finished, [], context);
          return;
        }

        if (dispatchAttempt.action === "inflight") {
          run.warnings.push(`Digest ${digestKey} is already pending in another worker`);
          const finished = finalizeRun(run, "completed", `Digest ${digestKey} skipped because another worker holds the lease`);
          await this.finishRun(finished, [], context);
          return;
        }

        let digestedRows: Awaited<ReturnType<RepositoryBundle["finalizeDigestDispatch"]>>["opportunities"] | null = null;
        const reconciled = await this.slack.findRecentDigestByKey({
          channelId,
          digestKey
        });
        if (reconciled) {
          try {
            const finalized = await this.repositories.finalizeDigestDispatch({
              digestKey,
              slackMessageTs: reconciled.ts,
              sentAt: context.now,
              opportunityIds: deliveryOpportunities.map((opportunity) => opportunity.id)
            });
            digestedRows = finalized.opportunities;
            run.warnings.push(`Digest ${digestKey} was reconciled from Slack history after a previous incomplete write-back`);
          } catch (error) {
            this.logger.error({ error, digestKey }, "Digest reconciliation failed after Slack history match");
            run.warnings.push(`Digest ${digestKey} was already sent to Slack but DB reconciliation still failed`);
            await this.sendOperationalAlertSafely(
              `Digest ${digestKey} was found in Slack history but DB reconciliation failed. Manual check recommended.`
            );
          }
        } else {
          let slackResult: Awaited<ReturnType<SlackService["sendDigest"]>> | null = null;
          try {
            slackResult = await this.slack.sendDigest({
              channelId,
              digestKey,
              opportunities: deliveryOpportunities
            });
            if (!slackResult || !slackResult.ts) {
              throw new Error("Slack digest send did not return a Slack message timestamp.");
            }
          } catch (error) {
            await this.repositories.markDigestDispatchFailed(
              digestKey,
              error instanceof Error ? error.message : "Slack digest send failed"
            );
            throw error;
          }

          try {
            const finalized = await this.repositories.finalizeDigestDispatch({
              digestKey,
              slackMessageTs: slackResult.ts,
              sentAt: context.now,
              opportunityIds: deliveryOpportunities.map((opportunity) => opportunity.id)
            });
            digestedRows = finalized.opportunities;
          } catch (error) {
            this.logger.error({ error, digestKey }, "Slack digest sent but DB reconciliation failed");
            run.warnings.push(`Digest ${digestKey} was sent to Slack but DB reconciliation failed`);
            await this.sendOperationalAlertSafely(
              `Digest ${digestKey} was sent, but DB reconciliation failed. The next run will reconcile from Slack history.`
            );
          }
        }

        await this.syncDigestedOpportunityRows(digestedRows ?? [], run);
      }
      const finished = finalizeRun(run, "completed", `Digest prepared for ${deliveryOpportunities.length} opportunities`);
      await this.finishRun(finished, [], context);
    } catch (error) {
      const failed = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown digest error");
      await this.finishRun(failed, [], context);
      throw error;
    }
  }

  private async scanSelections(context: RunContext) {
    const run = createRun("selection:scan");
    if (!context.dryRun) {
      await this.repositories.createSyncRun(run);
    }

    try {
      const selected = await this.notion.listSelectedOpportunities();
      for (const candidate of selected) {
        const opportunity = await this.repositories.findOpportunityByNotionPageId(candidate.notionPageId);
        if (!opportunity || opportunity.status === "Selected") {
          continue;
        }

        if (!context.dryRun) {
          const updated = await this.repositories.markOpportunitySelected(opportunity.id, candidate.editorialOwner);
          await this.slack.notifySelection(this.mapOpportunityRow(updated));
        }
      }

      const finished = finalizeRun(run, "completed", `Selection scan processed ${selected.length} candidates`);
      await this.finishRun(finished, [], context);
    } catch (error) {
      const failed = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown selection scan error");
      await this.finishRun(failed, [], context);
      throw error;
    }
  }

  private async recomputeProfiles(context: RunContext) {
    const run = createRun("profile:weekly-recompute");
    if (!context.dryRun) {
      await this.repositories.createSyncRun(run);
    }

    try {
      const profileBases = await loadProfileBases();
      await this.refreshProfiles(profileBases, true, context);
      const finished = finalizeRun(run, "completed", "Weekly profile recompute completed");
      await this.finishRun(finished, [], context);
    } catch (error) {
      const failed = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown recompute error");
      await this.finishRun(failed, [], context);
      throw error;
    }
  }

  private async cleanupRetention(context: RunContext) {
    const run = createRun("cleanup:retention");
    if (!context.dryRun) {
      await this.repositories.createSyncRun(run);
    }

    try {
      const candidates = await this.repositories.listCleanupCandidates(new Date());
      if (!context.dryRun) {
        for (const candidate of candidates) {
          await this.repositories.cleanupSourceItemRawText(candidate.id);
        }
      }
      const finished = finalizeRun(run, "completed", `Retention cleanup scanned ${candidates.length} items`);
      await this.finishRun(finished, [], context);
    } catch (error) {
      const failed = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown retention cleanup error");
      await this.finishRun(failed, [], context);
      throw error;
    }
  }

  private async repairOpportunityEvidence(context: RunContext) {
    const run = createRun("repair:opportunity-evidence");
    if (!context.dryRun) {
      await this.repositories.createSyncRun(run);
    }

    try {
      let scanned = 0;
      let candidates = 0;
      let repaired = 0;
      let skipped = 0;
      let clonedEvidenceRows = 0;
      let lastSeenId: string | undefined;
      const unrecoverable: string[] = [];
      let validationFailures = 0;

      while (true) {
        const rows = await this.repositories.listOpportunitiesForEvidenceRepairBatch({
          afterId: lastSeenId,
          take: 50
        });
        if (rows.length === 0) {
          break;
        }

        for (const row of rows) {
          lastSeenId = row.id;
          scanned += 1;
          const needsRepair = !isOpportunityEvidenceAlreadyRepaired(row);
          if (!needsRepair) {
            skipped += 1;
            continue;
          }

          candidates += 1;

          if (!canRebuildOpportunityEvidence(row)) {
            unrecoverable.push(row.id);
            this.logger.warn?.({ opportunityId: row.id }, "Opportunity evidence repair skipped because no source evidence could be rebuilt");
            continue;
          }

          const rebuiltSourceEvidence = dedupeEvidenceReferences(
            row.relatedSignals.flatMap((item) => item.signal.evidence.map(mapStoredEvidence))
          );
          const rebuiltEvidence = scopeEvidenceReferences("opportunity", row.id, rebuiltSourceEvidence);
          clonedEvidenceRows += rebuiltEvidence.length;
          const preferredPrimarySignature = row.primaryEvidence
            ? evidenceSignature(mapStoredEvidence(row.primaryEvidence))
            : row.evidence[0]
              ? evidenceSignature(mapStoredEvidence(row.evidence[0]))
              : undefined;
          const primaryEvidence = selectPrimaryEvidence(rebuiltEvidence, {
            signature: preferredPrimarySignature
          });
          if (!primaryEvidence) {
            unrecoverable.push(row.id);
            validationFailures += 1;
            this.logger.warn?.({ opportunityId: row.id }, "Opportunity evidence repair skipped because no primary evidence could be selected");
            continue;
          }

          repaired += 1;
          if (context.dryRun) {
            continue;
          }

          const repairedRow = await this.repositories.repairOpportunityEvidence({
            opportunityId: row.id,
            evidence: rebuiltEvidence,
            primaryEvidenceId: primaryEvidence.id,
            supportingEvidenceCount: Math.max(0, rebuiltEvidence.length - 1),
            evidenceFreshness: primaryEvidence.freshnessScore
          });

          if (repairedRow.notionPageId) {
            const opportunity = this.mapOpportunityRow(repairedRow);
            const syncResult = await this.notion.syncOpportunity(opportunity);
            if (syncResult) {
              run.counters[syncResult.action === "created" ? "notionCreates" : "notionUpdates"] += 1;
              await this.repositories.updateOpportunityNotionSync(opportunity.id, syncResult.notionPageId, opportunity.notionPageFingerprint);
            }
          }

          if (!isOpportunityEvidenceAlreadyRepaired(repairedRow)) {
            throw new Error(`Opportunity ${row.id} failed post-repair validation.`);
          }
        }
      }

      if (unrecoverable.length > 0) {
        run.warnings.push(`Opportunity evidence repair could not rebuild ${unrecoverable.length} opportunities`);
      }
      this.logger.info(
        {
          scanned,
          candidates,
          repaired,
          skipped,
          clonedEvidenceRows,
          unrecoverable: unrecoverable.length,
          validationFailures,
          dryRun: context.dryRun
        },
        "Opportunity evidence repair summary"
      );

      const finished = finalizeRun(
        run,
        "completed",
        `Opportunity evidence repair scanned ${scanned} opportunities and repaired ${repaired}`
      );
      await this.finishRun(finished, [], context);
    } catch (error) {
      const failed = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown repair error");
      await this.finishRun(failed, [], context);
      throw error;
    }
  }

  private async backfill(context: RunContext) {
    return this.syncDaily({
      ...context,
      now: subDays(context.now, 0)
    });
  }

  private async loadStaticInputs(context: RunContext) {
    const [configs, sensitivityMarkdown, doctrineMarkdown, profileBases] = await Promise.all([
      loadConnectorConfigs(),
      loadSensitivityMarkdown(),
      loadDoctrineMarkdown(),
      loadProfileBases()
    ]);

    if (!context.dryRun) {
      for (const profileBase of profileBases) {
        await this.repositories.upsertProfileBase(profileBase);
      }
    }

    return {
      configs,
      sensitivityMarkdown,
      doctrineMarkdown,
      profileBases
    };
  }

  private async fetchSourceItems(config: ConnectorConfig, connector: ReturnType<typeof createConnectorRegistry>[ConnectorConfig["source"]], context: RunContext) {
    const cursor = await this.repositories.getCursor(config.source);
    return connector.fetchSince(cursor, config as never, context);
  }

  private async refreshProfiles(profileBasesInput?: ProfileBase[], weekly = false, context?: RunContext) {
    const profileBases = profileBasesInput ?? (await loadProfileBases());
    const snapshots = new Map<string, ProfileSnapshot>();
    const { learnedLayers } = await this.repositories.listProfiles();
    const signalRows = await this.prisma.signal.findMany({
      where: {
        status: {
          not: "Sensitive review"
        }
      },
      include: {
        evidence: true
      }
    });

    for (const base of profileBases) {
      const profileSignals = signalRows.filter((signal) => signal.probableOwnerProfile === base.profileId);
      const recentExcerpts = profileSignals.flatMap((signal) => signal.evidence.map((item) => item.excerpt));
      const previous = learnedLayers.find((layer) => layer.profileId === base.profileId);
      const learned = weekly
        ? buildWeeklyLearnedLayer(base, recentExcerpts)
        : buildDailyLearnedLayer(
            base,
            recentExcerpts,
            previous
              ? {
                  profileId: previous.profileId as typeof base.profileId,
                  recurringPhrases: expectStringArray(previous.recurringPhrasesJson),
                  structuralPatterns: expectStringArray(previous.structuralPatternsJson),
                  evidenceExcerptIds: expectStringArray(previous.evidenceExcerptIdsJson),
                  lastIncrementalUpdateAt: previous.lastIncrementalUpdateAt.toISOString(),
                  lastWeeklyRecomputeAt: previous.lastWeeklyRecomputeAt?.toISOString()
                }
              : undefined
          );
      learned.evidenceExcerptIds = profileSignals.flatMap((signal) => signal.evidence.map((item) => item.id));
      if (!context?.dryRun) {
        await this.repositories.upsertProfileLearnedLayer(learned);
      }
      const snapshot = mergeProfileSnapshot(base, learned);
      snapshots.set(base.profileId, snapshot);
      if (!context?.dryRun) {
        const syncResult = await this.notion.syncProfile(snapshot);
        if (syncResult) {
          await this.repositories.updateProfileBaseNotionSync(base.profileId, syncResult.notionPageId, snapshot.notionPageFingerprint);
        }
      }
    }

    return snapshots;
  }

  private async recoverDigestDispatches(channelId: string, run: SyncRun, context: RunContext) {
    const blockedOpportunityIds = new Set<string>();
    const dispatches = await this.repositories.listRecoverableDigestDispatches(channelId, context.now, 20);

    for (const dispatch of dispatches) {
      const trackBlocked = () => {
        for (const opportunityId of dispatch.opportunityIds) {
          blockedOpportunityIds.add(opportunityId);
        }
      };

      const reconciled = await this.slack.findRecentDigestByKey({
        channelId,
        digestKey: dispatch.digestKey
      });
      if (reconciled) {
        try {
          const finalized = await this.repositories.finalizeDigestDispatch({
            digestKey: dispatch.digestKey,
            slackMessageTs: reconciled.ts,
            sentAt: context.now,
            opportunityIds: dispatch.opportunityIds
          });
          run.warnings.push(`Recovered digest ${dispatch.digestKey} from Slack history before sending a new digest`);
          await this.syncDigestedOpportunityRows(finalized.opportunities, run);
          continue;
        } catch (error) {
          this.logger.error({ error, digestKey: dispatch.digestKey }, "Digest recovery reconciliation failed");
          run.warnings.push(`Digest ${dispatch.digestKey} was found in Slack history but DB reconciliation still failed`);
          trackBlocked();
          await this.sendOperationalAlertSafely(
            `Digest ${dispatch.digestKey} was found in Slack history but DB reconciliation failed during recovery.`
          );
          continue;
        }
      }

      const leaseActive = dispatch.status === "pending" && dispatch.leaseExpiresAt && new Date(dispatch.leaseExpiresAt) > context.now;
      if (leaseActive) {
        trackBlocked();
        continue;
      }

      const recoveryRows = await this.repositories.findOpportunitiesByIds(dispatch.opportunityIds);
      const foundIds = new Set(recoveryRows.map((row) => row.id));
      const missingIds = dispatch.opportunityIds.filter((opportunityId) => !foundIds.has(opportunityId));
      if (missingIds.length > 0) {
        await this.repositories.markDigestDispatchFailed(
          dispatch.digestKey,
          `Recovery skipped because opportunities are missing: ${missingIds.join(", ")}`
        );
        run.warnings.push(`Digest ${dispatch.digestKey} could not be recovered because some opportunities no longer exist`);
        trackBlocked();
        await this.sendOperationalAlertSafely(
          `Digest ${dispatch.digestKey} could not be recovered because opportunities are missing: ${missingIds.join(", ")}`
        );
        continue;
      }

      const rowsById = new Map(recoveryRows.map((row) => [row.id, row]));
      const orderedRows = dispatch.opportunityIds.map((opportunityId) => rowsById.get(opportunityId)).filter(Boolean);
      const invalidRows = orderedRows.filter((row) => !row?.notionPageId);
      if (invalidRows.length > 0) {
        await this.repositories.markDigestDispatchFailed(
          dispatch.digestKey,
          `Recovery skipped because opportunities are missing Notion pages: ${invalidRows.map((row) => row!.id).join(", ")}`
        );
        run.warnings.push(`Digest ${dispatch.digestKey} could not be recovered because some opportunities are missing Notion pages`);
        trackBlocked();
        await this.sendOperationalAlertSafely(
          `Digest ${dispatch.digestKey} could not be recovered because opportunities are missing Notion pages: ${invalidRows.map((row) => row!.id).join(", ")}`
        );
        continue;
      }

      try {
        const slackResult = await this.slack.sendDigest({
          channelId,
          digestKey: dispatch.digestKey,
          opportunities: orderedRows.map((row) => this.mapOpportunityRow(row!))
        });
        if (!slackResult || !slackResult.ts) {
          throw new Error("Slack digest recovery send did not return a Slack message timestamp.");
        }

        const finalized = await this.repositories.finalizeDigestDispatch({
          digestKey: dispatch.digestKey,
          slackMessageTs: slackResult.ts,
          sentAt: context.now,
          opportunityIds: dispatch.opportunityIds
        });
        run.warnings.push(`Retried digest ${dispatch.digestKey} from the recovery queue before building a new digest`);
        await this.syncDigestedOpportunityRows(finalized.opportunities, run);
      } catch (error) {
        await this.repositories.markDigestDispatchFailed(
          dispatch.digestKey,
          error instanceof Error ? error.message : "Digest recovery resend failed"
        );
        trackBlocked();
        this.logger.error({ error, digestKey: dispatch.digestKey }, "Digest recovery resend failed");
        run.warnings.push(`Digest ${dispatch.digestKey} recovery resend failed`);
        await this.sendOperationalAlertSafely(
          `Digest ${dispatch.digestKey} recovery resend failed and will stay blocked until the next run.`
        );
      }
    }

    return blockedOpportunityIds;
  }

  private async syncDigestedOpportunityRows(
    rows: Awaited<ReturnType<RepositoryBundle["findOpportunitiesByIds"]>>,
    run: SyncRun
  ) {
    const notionFailures: string[] = [];
    for (const row of rows) {
      try {
        const opportunity = this.mapOpportunityRow(row);
        const syncResult = await this.notion.syncOpportunity(opportunity);
        if (syncResult) {
          run.counters[syncResult.action === "created" ? "notionCreates" : "notionUpdates"] += 1;
          await this.repositories.updateOpportunityNotionSync(opportunity.id, syncResult.notionPageId, opportunity.notionPageFingerprint);
        }
      } catch (error) {
        this.logger.error({ error, opportunityId: row.id }, "Opportunity digest write-back failed");
        notionFailures.push(row.id);
      }
    }

    if (notionFailures.length > 0) {
      run.warnings.push(`Notion digest sync failed for opportunities: ${notionFailures.join(", ")}`);
    }
  }

  private async sendOperationalAlertSafely(text: string) {
    try {
      await this.slack.sendOperationalAlert(text);
    } catch (error) {
      this.logger.error({ error, text }, "Slack operational alert failed");
    }
  }

  private recordUsage(run: SyncRun, costs: Array<ReturnType<typeof createCostEntry>>, usage: LlmUsage, step: string, fallbackSteps: Set<string>) {
    if (usage.skipped) {
      return;
    }

    const stats = run.llmStats.byStep[step] ?? {
      calls: 0,
      fallbacks: 0,
      validationFailures: 0
    };
    stats.calls += 1;
    run.llmStats.byStep[step] = stats;
    run.llmStats.totalCalls += 1;

    if (usage.mode === "fallback") {
      run.counters.llmFallbacks += 1;
      run.llmStats.totalFallbacks += 1;
      stats.fallbacks += 1;
      fallbackSteps.add(step);
    }
    if (usage.error) {
      run.counters.llmValidationFailures += 1;
      run.llmStats.totalValidationFailures += 1;
      stats.validationFailures += 1;
    }
    costs.push(
      createCostEntry({
        step,
        model: this.env.LLM_MODEL,
        mode: usage.mode,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        estimatedCostUsd: usage.estimatedCostUsd,
        runId: run.id
      })
    );
  }

  private applyFallbackThresholds(run: SyncRun, fallbackSteps: Set<string>) {
    const totalLlmCalls = run.llmStats.totalCalls;
    const fallbackRate = totalLlmCalls === 0 ? 0 : run.llmStats.totalFallbacks / totalLlmCalls;
    if (run.llmStats.totalFallbacks > 5 || fallbackRate > 0.2) {
      run.warnings.push("LLM fallback threshold exceeded");
      const dangerousFallback = [...fallbackSteps].some((step) => step.includes("draft") || step.includes("sensitivity"));
      if (dangerousFallback) {
        throw new Error("Run aborted because fallback threshold was exceeded during a sensitive step.");
      }
    }
  }

  private async finishRun(run: SyncRun, costs: Array<ReturnType<typeof createCostEntry>>, context: RunContext) {
    if (context.dryRun) {
      this.logger.info({ run, costs }, "Dry-run complete");
      return;
    }

    await this.repositories.updateSyncRun(run);
    await this.repositories.addCostEntries(costs);
    const notionSync = await this.notion.syncRun(run);
    if (notionSync) {
      run.counters[notionSync.action === "created" ? "notionCreates" : "notionUpdates"] += 1;
      run.notionPageId = notionSync.notionPageId;
      await this.repositories.updateSyncRunNotionSync(run.id, notionSync.notionPageId, run.notionPageFingerprint);
      await this.repositories.updateSyncRun(run);
    }
  }

  private findConfig(configs: ConnectorConfig[], source: NormalizedSourceItem["source"]) {
    const config = configs.find((entry) => entry.source === source);
    if (!config) {
      throw new Error(`Missing config for source ${source}`);
    }
    return config;
  }

  private mapOpportunityRow(row: {
    id: string;
    sourceFingerprint: string;
    title: string;
    ownerProfile: string | null;
    narrativePillar: string;
    angle: string;
    whyNow: string;
    whatItIsAbout: string;
    whatItIsNotAbout: string;
    routingStatus: string;
    readiness: string;
    status: string;
    suggestedFormat: string;
    supportingEvidenceCount: number;
    evidenceFreshness: number;
    editorialOwner: string | null;
    selectedAt: Date | null;
    lastDigestAt: Date | null;
    updatedAt: Date;
    primaryEvidenceId: string | null;
    v1HistoryJson: unknown;
    notionPageId?: string | null;
    notionPageFingerprint?: string;
    primaryEvidence?: {
      id: string;
      source: string;
      sourceItemId: string;
      sourceUrl: string;
      timestamp: Date;
      excerpt: string;
      excerptHash: string;
      speakerOrAuthor: string | null;
      freshnessScore: number;
    } | null;
    relatedSignals: Array<{
      signalId: string;
    }>;
    evidence: Array<{
      id: string;
      source: string;
      sourceItemId: string;
      sourceUrl: string;
      timestamp: Date;
      excerpt: string;
      excerptHash: string;
      speakerOrAuthor: string | null;
      freshnessScore: number;
    }>;
  }): ContentOpportunity {
    const evidence = row.evidence.map(mapStoredEvidence);
    const primaryEvidence = row.primaryEvidence
      ? mapStoredEvidence(row.primaryEvidence)
      : selectPrimaryEvidence(evidence, {
          id: row.primaryEvidenceId ?? undefined,
          signature: row.primaryEvidenceId
            ? evidenceSignature(evidence.find((item) => item.id === row.primaryEvidenceId) ?? row.evidence[0] ?? { sourceItemId: "", excerptHash: "" })
            : undefined
        });
    if (!primaryEvidence) {
      throw new Error(`Opportunity ${row.id} is missing evidence`);
    }

    return {
      id: row.id,
      sourceFingerprint: row.sourceFingerprint,
      title: row.title,
      ownerProfile: row.ownerProfile as ContentOpportunity["ownerProfile"],
      narrativePillar: row.narrativePillar,
      angle: row.angle,
      whyNow: row.whyNow,
      whatItIsAbout: row.whatItIsAbout,
      whatItIsNotAbout: row.whatItIsNotAbout,
      relatedSignalIds: row.relatedSignals.map((item) => item.signalId),
      evidence,
      primaryEvidence,
      supportingEvidenceCount: Math.max(0, evidence.length - 1),
      evidenceFreshness: row.evidenceFreshness,
      evidenceExcerpts: evidence.map((item) => item.excerpt),
      routingStatus: row.routingStatus as ContentOpportunity["routingStatus"],
      readiness: row.readiness as ContentOpportunity["readiness"],
      status: row.status as ContentOpportunity["status"],
      suggestedFormat: row.suggestedFormat,
      editorialOwner: row.editorialOwner ?? undefined,
      selectedAt: row.selectedAt?.toISOString(),
      lastDigestAt: row.lastDigestAt?.toISOString(),
      v1History: expectStringArray(row.v1HistoryJson),
      notionPageId: row.notionPageId ?? undefined,
      notionPageFingerprint: row.notionPageFingerprint ?? hashParts([row.id, row.sourceFingerprint])
    };
  }
}

function compareCursors(left: string, right: string) {
  return normalizeCursorValue(left).localeCompare(normalizeCursorValue(right));
}

function maxCursorValue(current: string | null, candidate: string | null) {
  if (!candidate) return current;
  if (!current) return candidate;
  return compareCursors(current, candidate) >= 0 ? current : candidate;
}

function normalizeCursorValue(cursor: string) {
  if (/^\d+(\.\d+)?$/.test(cursor)) {
    return cursor.padStart(32, "0");
  }
  return cursor;
}

function expectStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("Expected persisted JSON array");
  }
  return value.map((item) => String(item));
}

function mapStoredEvidence(row: {
  id: string;
  source: string;
  sourceItemId: string;
  sourceUrl: string;
  timestamp: Date;
  excerpt: string;
  excerptHash: string;
  speakerOrAuthor: string | null;
  freshnessScore: number;
}): EvidenceReference {
  return {
    id: row.id,
    source: row.source as EvidenceReference["source"],
    sourceItemId: row.sourceItemId,
    sourceUrl: row.sourceUrl,
    timestamp: row.timestamp.toISOString(),
    excerpt: row.excerpt,
    excerptHash: row.excerptHash,
    speakerOrAuthor: row.speakerOrAuthor ?? undefined,
    freshnessScore: row.freshnessScore
  };
}

function buildDigestKey(items: Array<{ id: string; updatedAt: string }>, channel: string) {
  return hashParts([
    channel,
    ...items
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((item) => [item.id, item.updatedAt])
  ]);
}

function pickDigestDeliverySet<TEntry extends { row: { id: string; ownerProfile: string | null; updatedAt: Date } }>(entries: TEntry[]) {
  const grouped = new Map<string, TEntry[]>();
  for (const entry of entries) {
    const key = entry.row.ownerProfile ?? "unassigned";
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, profileEntries]) =>
      profileEntries
        .slice()
        .sort((left, right) => {
          const updatedAtDiff = right.row.updatedAt.getTime() - left.row.updatedAt.getTime();
          if (updatedAtDiff !== 0) {
            return updatedAtDiff;
          }
          return left.row.id.localeCompare(right.row.id);
        })
        .slice(0, 5)
    );
}

function isOpportunityEvidenceAlreadyRepaired(row: {
  id: string;
  primaryEvidenceId: string | null;
  supportingEvidenceCount: number;
  evidence: Array<{
    id: string;
    source: string;
    sourceItemId: string;
    sourceUrl: string;
    timestamp: Date;
    excerpt: string;
    excerptHash: string;
    speakerOrAuthor: string | null;
    freshnessScore: number;
  }>;
  primaryEvidence?: {
    id: string;
  } | null;
}) {
  if (row.evidence.length === 0 || !row.primaryEvidenceId || !row.primaryEvidence || row.primaryEvidence.id !== row.primaryEvidenceId) {
    return false;
  }

  if (row.supportingEvidenceCount + 1 !== row.evidence.length) {
    return false;
  }

  const mappedEvidence = row.evidence.map(mapStoredEvidence);
  const expectedIds = new Set(scopeEvidenceReferences("opportunity", row.id, mappedEvidence).map((item) => item.id));
  return mappedEvidence.every((item) => expectedIds.has(item.id));
}

function canRebuildOpportunityEvidence(row: {
  relatedSignals: Array<{
    signal: {
      evidence: Array<{
        id: string;
        source: string;
        sourceItemId: string;
        sourceUrl: string;
        timestamp: Date;
        excerpt: string;
        excerptHash: string;
        speakerOrAuthor: string | null;
        freshnessScore: number;
      }>;
    };
  }>;
}) {
  return row.relatedSignals.some((item) => item.signal.evidence.length > 0);
}
