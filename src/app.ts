import {
  loadConnectorConfigs,
  loadDoctrineMarkdown,
  loadExtractionProfilesMarkdown,
  loadGtmFoundationMarkdown,
  loadMarketResearchRuntimeConfig
} from "./config/loaders.js";
import type { AppEnv } from "./config/env.js";
import { createConnectorRegistry } from "./connectors/index.js";
import { getPrisma } from "./db/client.js";
import { RepositoryBundle, sourceItemDbId, ConcurrentRunError } from "./db/repositories.js";
import type {
  ConnectorConfig,
  ContentOpportunity,
  EnrichmentLogEntry,
  EvidenceReference,
  NormalizedSourceItem,
  RunContext,
  RunType,
  SyncRun,
  UserRecord
} from "./domain/types.js";
import { normalizeGtmFields } from "./domain/types.js";
import { hashParts } from "./lib/ids.js";
import {
  dedupeEvidenceReferences,
  evidenceSignature,
  scopeEvidenceReferences,
  selectPrimaryEvidence
} from "./services/evidence.js";
import { generateDraft } from "./services/drafts.js";
import { NotFoundError, ForbiddenError, UnprocessableError } from "./lib/errors.js";
import type { LlmUsage } from "./services/llm.js";
import { LlmClient } from "./services/llm.js";
import { buildSpikeWarnings, createCostEntry, createRun, finalizeRun } from "./services/observability.js";
import { computeRawTextExpiry } from "./services/retention.js";
import { ensureConvergenceFoundation, normalizeLayer3Defaults, resolveProfileId } from "./services/convergence.js";
import { runIntelligencePipeline, DEDUP_CANDIDATE_WINDOW } from "./services/intelligence.js";
import { runMarketResearch } from "./services/market-research.js";
import { findSupportingEvidence, assessDraftReadiness, deriveProvenanceType } from "./services/evidence-pack.js";
import { fetchHubSpotSignalItems, type BridgeRepositories } from "./connectors/hubspot-signals.js";

type LoggerLike = {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

export class EditorialSignalEngineApp {
  private readonly prisma;
  private readonly repositories;
  private readonly llmClient: LlmClient;

  constructor(
    private readonly env: AppEnv,
    private readonly logger: LoggerLike,
    deps: Partial<{
      prisma: ReturnType<typeof getPrisma>;
      repositories: RepositoryBundle;
      llmClient: LlmClient;
    }> = {}
  ) {
    this.prisma = deps.prisma ?? getPrisma();
    this.repositories = deps.repositories ?? new RepositoryBundle(this.prisma);
    this.llmClient = deps.llmClient ?? new LlmClient(env, logger);
  }

  async run(
    command: RunType,
    options: {
      dryRun?: boolean;
      companySlug?: string;
      opportunityId?: string;
      port?: number;
    } = {}
  ) {
    const context: RunContext = {
      dryRun: options.dryRun ?? false,
      now: new Date(),
      companySlug: options.companySlug,
      opportunityId: options.opportunityId,
      port: options.port
    };

    await ensureConvergenceFoundation(this.repositories, this.env);

    switch (command) {
      case "ingest:run":
        return this.ingestRun(context);
      case "market-research:run":
        return this.marketResearchRun(context);
      case "intelligence:run":
        return this.intelligenceRun(context);
      case "draft:generate":
        return this.generateDraftOnDemand(context);
      case "draft:generate-ready":
        return this.generateDraftsForReady(context);
      case "server:start":
        throw new Error("Use `pnpm server:start` to launch the HTTP server entrypoint.");
      case "cleanup:retention":
        return this.cleanupRetention(context);
      case "backfill:evidence":
        return this.backfillEvidence(context);
      case "cleanup:claap-publishability":
        return this.cleanupClaapPublishability(context);
      case "tone:inspect":
        return this.inspectToneProfiles();
      case "sales:sync":
      case "sales:extract":
      case "sales:detect":
      case "sales:match":
      case "sales:cleanup":
        throw new Error(`${command} is a Sales command. Use \`pnpm ${command}\` instead.`);
      default:
        throw new Error(`Unsupported command: ${command satisfies never}`);
    }
  }

  private async inspectToneProfiles() {
    const databaseId = this.env.NOTION_TONE_OF_VOICE_DB_ID;
    if (!databaseId) {
      console.log("[tone:inspect] NOTION_TONE_OF_VOICE_DB_ID is not set — nothing to inspect.");
      return;
    }

    const { Client } = await import("@notionhq/client");
    const { readToneOfVoiceProfiles } = await import("./lib/tone.js");
    const client = new Client({ auth: this.env.NOTION_TOKEN });
    const toneProfiles = await readToneOfVoiceProfiles(client, databaseId);
    if (toneProfiles.length === 0) {
      console.log("[tone:inspect] No tone-of-voice profiles found in database.");
      return;
    }

    for (const tp of toneProfiles) {
      const profileId = resolveProfileId(tp.profileName);
      const truncate = (s: string, max = 200) => s.length > max ? `${s.slice(0, max)}...` : s;

      console.log(`\nProfile "${tp.profileName}" → ${profileId ?? "(unmatched)"} (source: ${tp.source})`);
      console.log(`  voiceSummary: ${truncate(tp.voiceSummary) || "(empty)"}`);
      console.log(`  preferredPatterns: ${truncate(tp.preferredPatterns) || "(empty)"}`);
      console.log(`  avoid: ${truncate(tp.avoid) || "(empty)"}`);
    }
  }

  private async ingestRun(context: RunContext) {
    const company = await this.getActiveCompany(context);
    const run = createRun("ingest:run");
    run.companyId = company.id;
    if (!context.dryRun) {
      await this.repositories.createSyncRun(run);
    }

    try {
      const staticInputs = await this.loadStaticInputs(context);
      const registry = createConnectorRegistry(this.env, this.llmClient, staticInputs.doctrineMarkdown);
      const sourceMaxCursor = new Map<string, string | null>();

      const enabledConfigs = staticInputs.configs.filter((entry) => entry.enabled);
      this.logger.info({ sources: enabledConfigs.map(c => c.source) }, "Enabled sources");

      for (const config of enabledConfigs) {
        this.logger.info({ source: config.source }, "Fetching source items");
        const fetchResult = await this.fetchSourceItems(config, registry[config.source], context, company.id);
        this.logger.info({ source: config.source, fetched: fetchResult.items.length, warnings: fetchResult.warnings, partial: fetchResult.partialCompletion }, "Fetch result");
        run.counters.fetched += fetchResult.items.length;

        for (const w of fetchResult.warnings) {
          run.warnings.push(`[${config.source}] ${w}`);
        }
        if (fetchResult.partialCompletion) {
          run.warnings.push(`[${config.source}] Partial completion: not all items were fetched (cap hit, partition failure, or rate-limit exhaustion)`);
        }

        const sortedItems = [...fetchResult.items].sort((left, right) => compareCursors(left.cursor, right.cursor));

        for (const rawItem of sortedItems) {
          const normalized = await registry[config.source].normalize(rawItem, config as never, context);
          run.counters.normalized += 1;
          if (!context.dryRun) {
            await this.repositories.upsertSourceItem(
              normalized,
              computeRawTextExpiry(this.findConfig(staticInputs.configs, normalized.source), context.now),
              this.prisma,
              company.id
            );
          }
        }

        // Cursor advancement: use connector's authoritative cursor if provided,
        // otherwise fall back to deriving from items (legacy behavior).
        if (fetchResult.nextCursor !== null) {
          sourceMaxCursor.set(config.source, fetchResult.nextCursor);
        } else {
          const existingCursor = await this.repositories.getCursor(config.source, company.id);
          const derivedCursor = sortedItems.reduce<string | null>(
            (current, item) => maxCursorValue(current, item.cursor),
            existingCursor
          );
          sourceMaxCursor.set(config.source, derivedCursor);
        }
      }

      if (!context.dryRun) {
        for (const [source, cursor] of sourceMaxCursor.entries()) {
          await this.repositories.setCursor(source, cursor, this.prisma, company.id);
        }
      }

      // HubSpot signals bridge — reads from Sales DB tables, not external API.
      // Non-fatal: if sales tables are missing or the bridge fails, log and continue.
      if (!context.dryRun) {
        try {
          const bridgeRepos = this.buildBridgeRepositories();
          const hubspotCursor = await this.repositories.getCursor("hubspot-signals", company.id);
          const bridgeResult = await fetchHubSpotSignalItems({
            companyId: company.id,
            repos: bridgeRepos,
            cursor: hubspotCursor,
            now: context.now,
          });

          this.logger.info({
            bridge: "hubspot-signals",
            stats: bridgeResult.stats,
            itemCount: bridgeResult.items.length,
            previousCursor: hubspotCursor,
            newCursor: bridgeResult.newCursor,
          }, "HubSpot signals bridge completed");

          for (const item of bridgeResult.items) {
            await this.repositories.upsertSourceItem(item, null, this.prisma, company.id);
            run.counters.normalized += 1;
          }

          if (bridgeResult.newCursor && bridgeResult.newCursor !== hubspotCursor) {
            await this.repositories.setCursor("hubspot-signals", bridgeResult.newCursor, this.prisma, company.id);
          }
        } catch (bridgeError) {
          this.logger.warn?.({ err: bridgeError }, "HubSpot signals bridge failed — skipping");
        }
      }

      const finished = finalizeRun(run, "completed", `Ingestion completed for ${run.counters.normalized} source items`);
      await this.finishRun(finished, [], context);
    } catch (error) {
      const failed = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown ingestion error");
      await this.finishRun(failed, [], context);
      throw error;
    }
  }

  private async marketResearchRun(context: RunContext) {
    const company = await this.getActiveCompany(context);
    const run = createRun("market-research:run", "market-research");
    run.companyId = company.id;
    const costs: Array<ReturnType<typeof createCostEntry>> = [];
    const fallbackSteps = new Set<string>();
    if (!context.dryRun) {
      await this.repositories.createSyncRun(run);
    }

    try {
      const runtimeConfig = await loadMarketResearchRuntimeConfig();
      if (!runtimeConfig.enabled) {
        const finished = finalizeRun(run, "completed", "Market research disabled in runtime config");
        await this.finishRun(finished, [], context);
        return [];
      }

      const inputs = await this.loadMarketResearchInputs(company.id);
      const marketQueries = await this.repositories.listActiveMarketQueries(company.id);
      if (marketQueries.length === 0) {
        const finished = finalizeRun(run, "completed", `No active market queries for company ${company.slug}`);
        await this.finishRun(finished, [], context);
        return [];
      }

      const result = await runMarketResearch({
        companyId: company.id,
        marketQueries,
        doctrineMarkdown: inputs.doctrineMarkdown,
        runtimeConfig,
        now: context.now,
        llmClient: this.llmClient,
        tavilyApiKey: this.env.TAVILY_API_KEY,
        findExistingSourceItem: (params) => this.repositories.findSourceItemBySourceKey(params)
      });

      run.counters.fetched += result.fetchedResultsCount;
      run.counters.normalized += result.items.length;
      for (const event of result.usageEvents) {
        this.recordUsage(run, costs, event.usage, event.step, fallbackSteps);
      }

      if (!context.dryRun) {
        for (const item of result.items) {
          await this.repositories.upsertSourceItem(
            item,
            computeRawTextExpiry(runtimeConfig, context.now),
            this.prisma,
            company.id
          );
        }
      }

      this.applyFallbackThresholds(run, fallbackSteps);
      const finished = finalizeRun(
        run,
        "completed",
        `Market research created ${result.items.length} source items, skipped ${result.skippedUnchanged} unchanged and ${result.skippedEmpty} empty queries`
      );
      await this.finishRun(finished, costs, context);
      return result.items;
    } catch (error) {
      const failed = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown market research error");
      await this.finishRun(failed, costs, context);
      throw error;
    }
  }

  private async intelligenceRun(context: RunContext) {
    const company = await this.getActiveCompany(context);
    const run = createRun("intelligence:run");
    run.companyId = company.id;
    const costs: Array<ReturnType<typeof createCostEntry>> = [];
    const fallbackSteps = new Set<string>();
    if (!context.dryRun) {
      await this.repositories.acquireRunLease(run);
    }

    // Renew the lease periodically so long-running batches are never mistaken
    // for abandoned runs.  The timer fires every LEASE_RENEWAL_MS (2 min) and
    // pushes leaseExpiresAt forward by LEASE_DURATION_MS (5 min).  Cleared in
    // the finally block regardless of outcome.
    const leaseTimer = !context.dryRun
      ? setInterval(() => { this.repositories.renewRunLease(run.id).catch(() => {}); },
          RepositoryBundle.LEASE_RENEWAL_MS)
      : undefined;

    try {
      // Snapshot pre-run violation count for publishability invariant
      let preRunViolationCount = 0;
      if (!context.dryRun) {
        preRunViolationCount = await this.countPublishabilityViolations();
      }

      const inputs = await this.loadIntelligenceInputs(company.id);
      const rows = await this.repositories.listPendingSourceItems({
        companyId: company.id,
        take: 100
      });
      const items = rows.map((row) => this.mapStoredSourceItem(row));

      const opportunityRows = await this.repositories.listRecentActiveOpportunities({
        companyId: company.id,
        take: DEDUP_CANDIDATE_WINDOW
      });
      const recentOpportunities = opportunityRows.map((row) => this.mapOpportunityRow(row));

      const pipelineResult = await runIntelligencePipeline({
        items,
        companyId: company.id,
        llmClient: this.llmClient,
        doctrineMarkdown: inputs.doctrineMarkdown,
        sensitivityMarkdown: inputs.sensitivityMarkdown,
        userDescriptions: inputs.userDescriptions,
        users: inputs.users,
        layer2Defaults: inputs.layer2Defaults,
        layer3Defaults: inputs.layer3Defaults,
        gtmFoundationMarkdown: inputs.gtmFoundationMarkdown,
        extractionProfilesMarkdown: inputs.extractionProfilesMarkdown,
        recentOpportunities,
        checkOriginDedupe: async (siDbId) =>
          this.repositories.findActiveOpportunityByOriginSourceItem({
            sourceItemId: siDbId,
            companyId: company.id
          })
      });

      for (const event of pipelineResult.usageEvents) {
        this.recordUsage(run, costs, event.usage, event.step, fallbackSteps);
      }

      // Log dedup events separately from usage/cost telemetry
      if (pipelineResult.dedupEvents.length > 0) {
        this.logger.info?.({
          dedupEvents: pipelineResult.dedupEvents,
          summary: {
            total: pipelineResult.dedupEvents.length,
            warnings: pipelineResult.dedupEvents.filter(e => e.action === "create-with-warning").length,
            originHits: pipelineResult.dedupEvents.filter(e => e.action === "origin-dedup-hit" || e.action === "enrich-by-origin").length,
            llmEnrich: pipelineResult.dedupEvents.filter(e => e.action === "enrich-by-llm").length,
            cleanCreates: pipelineResult.dedupEvents.filter(e => e.action === "create-clean").length
          }
        }, "Dedup decision audit trail");
      }

      // Log angle quality events
      if (pipelineResult.angleQualityEvents.length > 0) {
        const aqe = pipelineResult.angleQualityEvents;
        this.logger.info?.({
          summary: {
            total: aqe.length,
            passed: aqe.filter(e => e.action === "passed").length,
            warned: aqe.filter(e => e.action === "warned").length,
            blockedSkip: aqe.filter(e => e.action === "blocked-skip").length,
            blockedEnrich: aqe.filter(e => e.action === "blocked-enrich").length,
            enrichNoSubstance: aqe.filter(e => e.action === "enrich-no-substance").length,
            gateMode: aqe[0]?.gateMode
          }
        }, "Angle quality audit trail");
      }

      // Log speaker context events
      if (pipelineResult.speakerContextEvents.length > 0) {
        const sce = pipelineResult.speakerContextEvents;
        this.logger.info?.({
          summary: {
            total: sce.length,
            resolved: sce.filter(e => e.resolved).length,
            resolvedByIdentity: sce.filter(e => e.resolved?.source === "identity").length,
            resolvedByHint: sce.filter(e => e.resolved?.source === "content-hint").length,
            unresolved: sce.filter(e => !e.resolved).length,
            promptModified: sce.filter(e => e.promptModified).length,
            depthMode: sce[0]?.depthMode,
          },
          // Capped per-item sample for auditing correctness on real runs.
          // Includes all resolved events (to verify identity/hint accuracy) plus
          // up to 5 unresolved events (to spot missed aliases). Cap at 20 total.
          sample: [
            ...sce.filter(e => e.resolved),
            ...sce.filter(e => !e.resolved).slice(0, 5)
          ].slice(0, 20).map(e => ({
            sourceItemId: e.sourceItemId,
            speakerName: e.speakerName ?? null,
            profileHint: e.profileHint ?? null,
            resolved: e.resolved ?? null,
            promptModified: e.promptModified,
          }))
        }, "Speaker context audit trail");
      }

      if (!context.dryRun) {
        // Save screening results
        const screeningEntries = [...pipelineResult.screeningResults.entries()].map(([externalId, result]) => ({
          id: sourceItemDbId(company.id, externalId),
          result
        }));
        if (screeningEntries.length > 0) {
          const { missingIds } = await this.repositories.saveScreeningResults(screeningEntries);
          if (missingIds.length > 0) {
            run.warnings.push(`Screening write skipped ${missingIds.length} missing SourceItem(s): ${missingIds.join(", ")}`);
          }
        }

        // Persist Linear enrichment classifications to DB
        const linearPersistFailedIds = new Set<string>();
        for (const [externalId, classification] of pipelineResult.linearClassifications) {
          const dbId = sourceItemDbId(company.id, externalId);
          try {
            const storedItem = await this.prisma.sourceItem.findUnique({ where: { id: dbId } });
            if (storedItem) {
              const existingMeta = isRecord(storedItem.metadataJson) ? storedItem.metadataJson : {};
              await this.prisma.sourceItem.update({
                where: { id: dbId },
                data: {
                  metadataJson: {
                    ...existingMeta,
                    linearEnrichmentClassification: classification.classification,
                    linearEnrichmentRationale: classification.rationale,
                    linearCustomerVisibility: classification.customerVisibility,
                    linearSensitivityLevel: classification.sensitivityLevel,
                    linearEvidenceStrength: classification.evidenceStrength,
                    linearReviewNote: classification.reviewNote
                  }
                }
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            this.logger.error({ externalId, error: message }, "Failed to persist Linear classification");
            linearPersistFailedIds.add(externalId);
          }
        }

        // Exclude Linear items whose classification persistence failed from the processed set
        // so they remain pending for retry on the next run
        if (linearPersistFailedIds.size > 0) {
          pipelineResult.processedSourceItemIds = pipelineResult.processedSourceItemIds.filter(
            (id) => !linearPersistFailedIds.has(id)
          );
          run.warnings.push(`Linear classification persistence failed for ${linearPersistFailedIds.size} item(s): ${[...linearPersistFailedIds].join(", ")}`);
        }

        // Persist GitHub enrichment classifications to DB
        const githubPersistFailedIds = new Set<string>();
        for (const [externalId, classification] of pipelineResult.githubClassifications) {
          const dbId = sourceItemDbId(company.id, externalId);
          try {
            const storedItem = await this.prisma.sourceItem.findUnique({ where: { id: dbId } });
            if (storedItem) {
              const existingMeta = isRecord(storedItem.metadataJson) ? storedItem.metadataJson : {};
              await this.prisma.sourceItem.update({
                where: { id: dbId },
                data: {
                  metadataJson: {
                    ...existingMeta,
                    githubEnrichmentClassification: classification.classification,
                    githubEnrichmentRationale: classification.rationale,
                    githubCustomerVisibility: classification.customerVisibility,
                    githubSensitivityLevel: classification.sensitivityLevel,
                    githubEvidenceStrength: classification.evidenceStrength,
                    githubReviewNote: classification.reviewNote
                  }
                }
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            this.logger.error({ externalId, error: message }, "Failed to persist GitHub classification");
            githubPersistFailedIds.add(externalId);
          }
        }

        if (githubPersistFailedIds.size > 0) {
          pipelineResult.processedSourceItemIds = pipelineResult.processedSourceItemIds.filter(
            (id) => !githubPersistFailedIds.has(id)
          );
          run.warnings.push(`GitHub classification persistence failed for ${githubPersistFailedIds.size} item(s): ${[...githubPersistFailedIds].join(", ")}`);
        }

        // Persist created opportunities + evidence-pack enrichment
        for (const opp of pipelineResult.created) {
          await this.prisma.$transaction(async (tx) => {
            await this.repositories.createOpportunityOnly(opp, tx);
            await this.repositories.persistStandaloneEvidence(
              {
                evidence: opp.evidence,
                companyId: company.id,
                opportunityId: opp.id,
                primaryEvidenceId: opp.primaryEvidence.id,
                supportingEvidenceCount: opp.supportingEvidenceCount,
                evidenceFreshness: opp.evidenceFreshness,
                relevanceNote: "Created by intelligence pipeline"
              },
              tx
            );
          });

          // --- Evidence pack enrichment ---
          const originDbIds = opp.evidence.map((e) => e.sourceItemId);
          const candidateRows = await this.repositories.listCandidateSourceItems({
            companyId: company.id,
            excludeIds: originDbIds,
            take: 200
          });
          const candidateItems = candidateRows.map((row) => this.mapStoredSourceItem(row));

          const { evidence: supportEvidence, sources: supportSources } = findSupportingEvidence(
            opp, candidateItems, company.id
          );

          // Derive provenance from the originating source item
          const originItem = items.find((i) =>
            opp.evidence.some((e) => e.sourceItemId === sourceItemDbId(company.id, i.externalId))
          );
          const provenanceType = originItem ? deriveProvenanceType(originItem) : opp.primaryEvidence.source;

          if (supportEvidence.length > 0) {
            await this.repositories.persistStandaloneEvidence(
              {
                evidence: supportEvidence,
                companyId: company.id,
                opportunityId: opp.id,
                primaryEvidenceId: opp.primaryEvidence.id,
                supportingEvidenceCount: opp.supportingEvidenceCount + supportEvidence.length,
                evidenceFreshness: opp.evidenceFreshness,
                relevanceNote: "Supporting evidence from evidence-pack enrichment"
              },
              this.prisma
            );
          }

          const allEvidence = [...opp.evidence, ...supportEvidence];
          const createdSourceItemIds = [...new Set(allEvidence.map(e => e.sourceItemId))];
          const createdSourceItemRows = await this.repositories.listSourceItemsByIds(createdSourceItemIds);
          const createdSourceItems = createdSourceItemRows.map(row => this.mapStoredSourceItem(row));
          const readiness = assessDraftReadiness(opp, allEvidence, {
            sourceItems: createdSourceItems
          });

          const packLogEntry: EnrichmentLogEntry = {
            createdAt: new Date().toISOString(),
            rawSourceItemId: opp.primaryEvidence.sourceItemId,
            evidenceIds: supportEvidence.map((e) => e.id),
            contextComment: supportEvidence.length > 0
              ? `Evidence pack: added ${supportEvidence.length} supporting items from ${[...new Set(supportSources.map((s) => s.source))].join(", ")}`
              : "Evidence pack: no additional supporting evidence found",
            provenanceType,
            originSourceUrl: opp.primaryEvidence.sourceUrl,
            originExcerpts: opp.evidence.map((e) => e.excerpt),
            confidence: readiness.status === "ready" ? 0.8 : 0.4,
            reason: `Draft readiness: ${readiness.status}. ${readiness.missingElements.length > 0 ? "Missing: " + readiness.missingElements.join("; ") : "All checks passed."}`
          };

          await this.repositories.enrichOpportunity({
            opportunityId: opp.id,
            enrichmentLogJson: [packLogEntry],
            newEvidence: [],
            primaryEvidenceId: opp.primaryEvidence.id,
            supportingEvidenceCount: opp.supportingEvidenceCount + supportEvidence.length,
            evidenceFreshness: opp.evidenceFreshness,
            companyId: company.id,
            relevanceNote: "Evidence pack provenance record"
          });

          run.counters.opportunitiesCreated += 1;
        }

        // Batch-hydrate source items for enriched opportunities
        const enrichedSourceItemIds = [...new Set(
          pipelineResult.enriched.flatMap(e => e.opportunity.evidence.map(ev => ev.sourceItemId))
        )];
        const enrichedSourceItemRows = await this.repositories.listSourceItemsByIds(enrichedSourceItemIds);
        const enrichedSourceItems = enrichedSourceItemRows.map(row => this.mapStoredSourceItem(row));

        // Persist enriched opportunities
        for (const enriched of pipelineResult.enriched) {
          // Stamp provenanceType on enrichment log for Linear-classified items
          const enrichSourceItem = items.find(i =>
            i.externalId === enriched.logEntry.rawSourceItemId
          );
          if (enrichSourceItem?.source === "linear"
            && (enrichSourceItem.metadata?.linearEnrichmentClassification === "enrich-worthy"
              || enrichSourceItem.metadata?.linearEnrichmentClassification === "editorial-lead")) {
            enriched.logEntry.provenanceType = "linear-enrichment-policy";
          }
          if (enrichSourceItem?.source === "github"
            && (enrichSourceItem.metadata?.githubEnrichmentClassification === "shipped-feature"
              || enrichSourceItem.metadata?.githubEnrichmentClassification === "customer-fix"
              || enrichSourceItem.metadata?.githubEnrichmentClassification === "proof-point")) {
            enriched.logEntry.provenanceType = "github-enrichment-policy";
          }

          await this.repositories.enrichOpportunity({
            opportunityId: enriched.opportunity.id,
            enrichmentLogJson: enriched.opportunity.enrichmentLog,
            newEvidence: enriched.addedEvidence,
            primaryEvidenceId: enriched.opportunity.primaryEvidence.id,
            supportingEvidenceCount: enriched.opportunity.supportingEvidenceCount,
            evidenceFreshness: enriched.opportunity.evidenceFreshness,
            companyId: company.id,
            relevanceNote: enriched.logEntry.contextComment
          });

        }

        // Mark processed
        const dbIds = pipelineResult.processedSourceItemIds.map((externalId) =>
          sourceItemDbId(company.id, externalId)
        );
        await this.repositories.markSourceItemsProcessed(dbIds, context.now);
      }

      if (!context.dryRun) {
        await this.checkPublishabilityInvariant(run, { preRunCount: preRunViolationCount, mode: "intelligence" });
      }

      this.applyFallbackThresholds(run, fallbackSteps);
      const finished = finalizeRun(run, "completed", `Intelligence completed for ${rows.length} source items`);
      await this.finishRun(finished, costs, context);
    } catch (error) {
      const failed = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown intelligence error");
      await this.finishRun(failed, costs, context);
      throw error;
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
    }
  }

  private async generateDraftOnDemand(context: RunContext) {
    if (!context.opportunityId) {
      throw new UnprocessableError("Missing --opportunity-id for draft:generate");
    }

    const company = await this.getActiveCompany(context);
    const run = createRun("draft:generate");
    run.companyId = company.id;
    const costs: Array<ReturnType<typeof createCostEntry>> = [];
    if (!context.dryRun) {
      await this.repositories.createSyncRun(run);
    }

    try {
      const row = await this.repositories.findOpportunityById(context.opportunityId);
      if (!row) {
        throw new NotFoundError(`Opportunity ${context.opportunityId} not found`);
      }

      const opportunity = this.mapOpportunityRow(row);

      if (opportunity.companyId && opportunity.companyId !== company.id) {
        throw new ForbiddenError(`Opportunity ${opportunity.id} does not belong to company ${company.slug}`);
      }

      if (opportunity.evidence.length === 0 || opportunity.primaryEvidence.excerpt.length === 0) {
        throw new UnprocessableError(`Opportunity ${opportunity.id} has insufficient evidence for draft generation`);
      }

      const inputs = await this.loadIntelligenceInputs(company.id);

      const authorUser = inputs.users.find((u) => u.id === opportunity.ownerUserId)
        ?? inputs.users.find((u) => u.displayName === opportunity.ownerProfile);
      if (!authorUser) {
        throw new UnprocessableError(`No matching user found for opportunity ${opportunity.id}`);
      }

      const result = await generateDraft({
        opportunity,
        user: authorUser,
        llmClient: this.llmClient,
        sensitivityRulesMarkdown: inputs.sensitivityMarkdown,
        doctrineMarkdown: inputs.doctrineMarkdown,
        editorialNotes: opportunity.editorialNotes ?? "",
        layer3Defaults: inputs.layer3Defaults,
        gtmFoundationMarkdown: inputs.gtmFoundationMarkdown
      });

      for (const usageEvent of result.usageEvents) {
        this.recordUsage(run, costs, usageEvent.usage, `${opportunity.id}:${usageEvent.step}`, new Set<string>());
      }

      if (result.blocked || !result.draft) {
        throw new UnprocessableError(
          `Opportunity ${opportunity.id} blocked by sensitivity check: ${result.blockRationale ?? "unknown"}`
        );
      }

      opportunity.readiness = "V1 generated";
      opportunity.status = "V1 generated";
      opportunity.v1History = [...(opportunity.v1History ?? []), result.draft.firstDraftText];

      if (!context.dryRun) {
        await this.repositories.persistDraftGraph(result.draft, opportunity, company.id);
      }

      run.counters.draftsCreated += 1;
      const finished = finalizeRun(run, "completed", `Draft generated for ${opportunity.id}`);
      await this.finishRun(finished, costs, context);
      return result.draft;
    } catch (error) {
      const failed = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown draft generation error");
      await this.finishRun(failed, costs, context);
      throw error;
    }
  }

  private async generateDraftsForReady(context: RunContext) {
    const company = await this.getActiveCompany(context);
    const run = createRun("draft:generate-ready");
    run.companyId = company.id;
    const costs: Array<ReturnType<typeof createCostEntry>> = [];
    if (!context.dryRun) {
      await this.repositories.createSyncRun(run);
    }

    try {
      const inputs = await this.loadIntelligenceInputs(company.id);
      const recentOpps = await this.repositories.listRecentActiveOpportunities({ companyId: company.id, take: 200 });
      const opportunities = recentOpps.map((row) => this.mapOpportunityRow(row));

      // Compute readiness and filter to "ready" opportunities without existing drafts
      const sourceItemIds = [...new Set(opportunities.flatMap(o => o.evidence.map(e => e.sourceItemId)))];
      const sourceItemRows = await this.repositories.listSourceItemsByIds(sourceItemIds);
      const sourceItems = sourceItemRows.map(row => this.mapStoredSourceItem(row));

      const readyOpps = opportunities.filter(opp => {
        if (opp.status === "V1 generated" || opp.status === "Selected") return false;
        if (opp.evidence.length === 0 || opp.primaryEvidence.excerpt.length === 0) return false;
        const readiness = assessDraftReadiness(opp, opp.evidence, { sourceItems });
        return readiness.readinessTier === "ready";
      });

      this.logger.info?.({ count: readyOpps.length }, "Opportunities ready for draft generation");

      let generated = 0;
      let failed = 0;
      for (const opportunity of readyOpps) {
        try {
          const authorUser = inputs.users.find(u => u.id === opportunity.ownerUserId)
            ?? inputs.users.find(u => u.displayName === opportunity.ownerProfile);
          if (!authorUser) {
            this.logger.warn?.({ opportunityId: opportunity.id }, "No matching user, skipping");
            continue;
          }

          const result = await generateDraft({
            opportunity,
            user: authorUser,
            llmClient: this.llmClient,
            sensitivityRulesMarkdown: inputs.sensitivityMarkdown,
            doctrineMarkdown: inputs.doctrineMarkdown,
            editorialNotes: opportunity.editorialNotes ?? "",
            layer3Defaults: inputs.layer3Defaults,
            gtmFoundationMarkdown: inputs.gtmFoundationMarkdown
          });

          for (const usageEvent of result.usageEvents) {
            this.recordUsage(run, costs, usageEvent.usage, `${opportunity.id}:${usageEvent.step}`, new Set<string>());
          }

          if (result.blocked || !result.draft) {
            this.logger.warn?.({ opportunityId: opportunity.id, reason: result.blockRationale }, "Draft blocked by sensitivity");
            failed += 1;
            continue;
          }

          opportunity.readiness = "V1 generated";
          opportunity.status = "V1 generated";
          opportunity.v1History = [...(opportunity.v1History ?? []), result.draft.firstDraftText];

          if (!context.dryRun) {
            await this.repositories.persistDraftGraph(result.draft, opportunity, company.id);
          }

          generated += 1;
          run.counters.draftsCreated += 1;
          this.logger.info?.({ opportunityId: opportunity.id, owner: opportunity.ownerProfile }, "Draft generated");
        } catch (error) {
          this.logger.error?.({ opportunityId: opportunity.id, error: error instanceof Error ? error.message : "unknown" }, "Draft generation failed");
          failed += 1;
        }
      }

      const finished = finalizeRun(run, "completed", `Batch draft: ${generated} generated, ${failed} failed, ${readyOpps.length} candidates`);
      await this.finishRun(finished, costs, context);
    } catch (error) {
      const failedRun = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown batch draft error");
      await this.finishRun(failedRun, costs, context);
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

  private async backfillEvidence(context: RunContext) {
    const company = await this.getActiveCompany(context);
    const run = createRun("backfill:evidence");
    run.companyId = company.id;
    if (!context.dryRun) {
      await this.repositories.createSyncRun(run);
    }

    try {
      const opportunityRows = await this.repositories.listRecentActiveOpportunities({
        companyId: company.id,
        take: 500
      });
      const opportunities = opportunityRows.map((row) => this.mapOpportunityRow(row));

      const candidateRows = await this.repositories.listCandidateSourceItems({
        companyId: company.id,
        take: 500
      });
      const candidateItems = candidateRows.map((row) => this.mapStoredSourceItem(row));

      let enrichedCount = 0;
      let skippedCount = 0;

      for (const opp of opportunities) {
        const { evidence: supportEvidence, sources: supportSources } = findSupportingEvidence(
          opp, candidateItems, company.id
        );

        if (supportEvidence.length === 0) {
          skippedCount += 1;
          continue;
        }

        const logEntry: EnrichmentLogEntry = {
          createdAt: new Date().toISOString(),
          rawSourceItemId: opp.primaryEvidence.sourceItemId,
          evidenceIds: supportEvidence.map((e) => e.id),
          contextComment: `Backfill: added ${supportEvidence.length} supporting items from ${[...new Set(supportSources.map((s) => s.source))].join(", ")}`,
          confidence: 0.6,
          reason: "Evidence backfill enrichment"
        };

        if (context.dryRun) {
          this.logger.info(
            { opportunityId: opp.id, title: opp.title, newEvidence: supportEvidence.length },
            `[dry-run] Would add ${supportEvidence.length} evidence items`
          );
          enrichedCount += 1;
          continue;
        }

        await this.repositories.persistStandaloneEvidence(
          {
            evidence: supportEvidence,
            companyId: company.id,
            opportunityId: opp.id,
            primaryEvidenceId: opp.primaryEvidence.id,
            supportingEvidenceCount: opp.supportingEvidenceCount + supportEvidence.length,
            evidenceFreshness: opp.evidenceFreshness,
            relevanceNote: "Evidence backfill enrichment"
          },
          this.prisma
        );

        await this.repositories.enrichOpportunity({
          opportunityId: opp.id,
          enrichmentLogJson: [...opp.enrichmentLog, logEntry],
          newEvidence: [],
          primaryEvidenceId: opp.primaryEvidence.id,
          supportingEvidenceCount: opp.supportingEvidenceCount + supportEvidence.length,
          evidenceFreshness: opp.evidenceFreshness,
          companyId: company.id,
          relevanceNote: logEntry.contextComment
        });

        enrichedCount += 1;
      }

      const finished = finalizeRun(
        run,
        "completed",
        `Evidence backfill: enriched ${enrichedCount}, skipped ${skippedCount} (already sufficient)`
      );
      await this.finishRun(finished, [], context);
    } catch (error) {
      const failed = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown backfill error");
      await this.finishRun(failed, [], context);
      throw error;
    }
  }

  private async cleanupClaapPublishability(context: RunContext) {
    const company = await this.getActiveCompany(context);
    const run = createRun("cleanup:claap-publishability");
    run.companyId = company.id;
    if (!context.dryRun) {
      await this.repositories.createSyncRun(run);
    }

    try {
      const inputs = await this.loadIntelligenceInputs(company.id);

      // 1. Load claap source items that need review:
      //    - signalKind "claap-signal" (not yet assessed)
      //    - OR already reclassified as harmful/reframeable (may need opportunity archival on re-run)
      const allClaapSignals = await this.prisma.sourceItem.findMany({
        where: {
          companyId: company.id,
          source: "claap",
          OR: [
            { metadataJson: { path: ["signalKind"], equals: "claap-signal" } },
            { metadataJson: { path: ["publishabilityRisk"], equals: "harmful" } },
            { metadataJson: { path: ["publishabilityRisk"], equals: "reframeable" } }
          ]
        }
      });

      let reclassified = 0;
      let archived = 0;
      let safe = 0;

      for (const sourceItem of allClaapSignals) {
        const existingMeta = isRecord(sourceItem.metadataJson) ? sourceItem.metadataJson : {};
        const existingRisk = typeof existingMeta.publishabilityRisk === "string" ? existingMeta.publishabilityRisk : undefined;
        let reviewMetadata: Record<string, unknown> = existingMeta;

        // Already reclassified — skip LLM, jump straight to opportunity archival
        let risk: string;
        if (existingRisk === "harmful" || existingRisk === "reframeable") {
          risk = existingRisk;
        } else {
          const rawText = sourceItem.rawText ?? sourceItem.text ?? "";
          if (rawText.length < 100) {
            safe += 1;
            continue;
          }

          // Run brand safety review with slim schema
          const { claapPublishabilityReviewSchema } = await import("./config/schema.js");

          const safeFallback = () => ({
            publishabilityRisk: "safe" as const,
            rationale: "Fallback: could not assess publishability"
          });

          const response = await this.llmClient.generateStructured({
            step: "claap-publishability-reclassification",
            system: `You are a brand safety reviewer for a LinkedIn content pipeline. Re-evaluate this previously extracted signal for publishability risk.

${inputs.doctrineMarkdown ? `## Company Doctrine\n${inputs.doctrineMarkdown}\n` : ""}
## Brand Safety

Assess whether this content would damage the company's brand if published on LinkedIn.

Set publishabilityRisk to one of:
- "safe": Can be published without brand risk.
- "reframeable": Useful substance but current framing would damage the brand. Provide reframingSuggestion explaining how to reframe it safely.
- "harmful": Would damage the brand even if reframed (e.g., customer saying they don't trust the product, complaints about core reliability, negative competitive comparison).

Calibration examples:
- Customer says "your compliance automation saved us 40 hours/month" → safe
- Customer says "we had doubts about accuracy but after testing it works" → reframeable
- Customer says "they don't trust the accuracy" or "DSN is the huge blocking point" → harmful

When in doubt, choose harmful.

Provide a rationale explaining your assessment.`,
            prompt: `Content to review:\n\n${rawText.slice(0, 8000)}`,
            schema: claapPublishabilityReviewSchema,
            allowFallback: true,
            fallback: safeFallback
          });

          risk = response.output.publishabilityRisk;

          if (risk === "safe") {
            safe += 1;
            continue;
          }

          // Reclassify: update source item metadata
          const updatedMetadata = {
            ...existingMeta,
            publishabilityRisk: risk,
            signalKind: risk === "reframeable" ? "claap-signal-reframeable" : existingMeta.signalKind
          };
          if (response.output.reframingSuggestion) {
            (updatedMetadata as Record<string, unknown>).reframingSuggestion = response.output.reframingSuggestion;
          }
          if (response.output.rationale) {
            (updatedMetadata as Record<string, unknown>).publishabilityRationale = response.output.rationale;
            (updatedMetadata as Record<string, unknown>).reviewWhyBlocked = response.output.rationale;
          }
          if (!(updatedMetadata as Record<string, unknown>).reviewTitle) {
            (updatedMetadata as Record<string, unknown>).reviewTitle = sourceItem.title;
          }
          if (!(updatedMetadata as Record<string, unknown>).reviewSummary) {
            (updatedMetadata as Record<string, unknown>).reviewSummary = sourceItem.summary;
          }
          if (getStringArray((updatedMetadata as Record<string, unknown>).reviewExcerpts).length === 0) {
            (updatedMetadata as Record<string, unknown>).reviewExcerpts = getStringArray(sourceItem.chunksJson);
          }
          reviewMetadata = updatedMetadata;

          if (!context.dryRun) {
            await this.prisma.sourceItem.update({
              where: { id: sourceItem.id },
              data: { metadataJson: updatedMetadata }
            });
          }
          reclassified += 1;
        }

        // Find opportunities linked to this source item via direct FK or junction table
        const affectedOpportunities = await this.prisma.opportunity.findMany({
          where: {
            OR: [
              { evidence: { some: { sourceItemId: sourceItem.id } } },
              { linkedEvidence: { some: { evidence: { sourceItemId: sourceItem.id } } } }
            ]
          },
          include: {
            evidence: true
          }
        });

        for (const opp of affectedOpportunities) {
          if (context.dryRun) {
            this.logger.info({ opportunityId: opp.id, risk }, `[dry-run] Would archive opportunity`);
            continue;
          }

          // Archive in DB
          const existingLog = Array.isArray(opp.enrichmentLogJson) ? opp.enrichmentLogJson : [];
          const archivalEntry = {
            createdAt: new Date().toISOString(),
            rawSourceItemId: sourceItem.id,
            evidenceIds: [],
            contextComment: `Archived: source item reclassified as ${risk} by brand safety review`,
            confidence: 0,
            reason: `Brand safety: publishabilityRisk=${risk}`
          };

          await this.prisma.opportunity.update({
            where: { id: opp.id },
            data: {
              status: "Archived",
              enrichmentLogJson: [...existingLog, archivalEntry]
            }
          });

          // Detach evidence
          await this.repositories.replaceOpportunityRelations(opp.id, [], null, opp.companyId);

          archived += 1;
        }
      }

      if (!context.dryRun) {
        await this.checkPublishabilityInvariant(run, { mode: "cleanup" });
      }

      const finished = finalizeRun(
        run,
        "completed",
        `Claap publishability cleanup: ${reclassified} reclassified, ${archived} opportunities archived, ${safe} safe`
      );
      await this.finishRun(finished, [], context);
    } catch (error) {
      const failed = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown cleanup error");
      await this.finishRun(failed, [], context);
      throw error;
    }
  }

  private async loadIntelligenceInputs(companyId: string) {
    const [editorialConfig, users, gtmFoundationMarkdown, extractionProfilesMarkdown] = await Promise.all([
      this.repositories.getLatestEditorialConfig(companyId),
      this.repositories.listUsers(companyId),
      loadGtmFoundationMarkdown(),
      loadExtractionProfilesMarkdown()
    ]);
    if (!editorialConfig) throw new Error("No editorial config. Run convergence foundation first.");
    const layer1 = editorialConfig.layer1CompanyLens as { doctrineMarkdown?: string; sensitivityMarkdown?: string };
    const layer2 = editorialConfig.layer2ContentPhilosophy as { defaults?: string[] };
    const layer3 = editorialConfig.layer3LinkedInCraft as { defaults?: string[] };
    const userDescriptions = users.map((u) => {
      const bp = u.baseProfile as Record<string, unknown>;
      return `- ${u.displayName} (${u.type}, ${u.language}): territories=${JSON.stringify(bp.contentTerritories ?? [])}`;
    }).join("\n");
    return {
      doctrineMarkdown: layer1.doctrineMarkdown ?? "",
      sensitivityMarkdown: layer1.sensitivityMarkdown ?? "",
      layer2Defaults: layer2.defaults ?? [],
      layer3Defaults: normalizeLayer3Defaults(layer3.defaults ?? []),
      gtmFoundationMarkdown,
      extractionProfilesMarkdown,
      userDescriptions,
      users: users.map(mapUserRecord)
    };
  }

  private async loadMarketResearchInputs(companyId: string) {
    const editorialConfig = await this.repositories.getLatestEditorialConfig(companyId);
    if (!editorialConfig) throw new Error("No editorial config. Run convergence foundation first.");
    const layer1 = editorialConfig.layer1CompanyLens as { doctrineMarkdown?: string };
    return {
      doctrineMarkdown: layer1.doctrineMarkdown ?? ""
    };
  }

  private async loadStaticInputs(context: RunContext) {
    const [configs, doctrineMarkdown] = await Promise.all([
      loadConnectorConfigs(),
      loadDoctrineMarkdown().catch(() => "")
    ]);
    return { configs, doctrineMarkdown };
  }

  private async fetchSourceItems(
    config: ConnectorConfig,
    connector: ReturnType<typeof createConnectorRegistry>[ConnectorConfig["source"]],
    context: RunContext,
    companyId?: string
  ): Promise<import("./domain/types.js").FetchResult> {
    const cursor = await this.repositories.getCursor(config.source, companyId);
    if (connector.fetchSinceV2) {
      return connector.fetchSinceV2(cursor, config as never, context);
    }
    const items = await connector.fetchSince(cursor, config as never, context);
    return { items, nextCursor: null, warnings: [], partialCompletion: false };
  }

  private async getActiveCompany(context: RunContext) {
    const companySlug = context.companySlug ?? this.env.DEFAULT_COMPANY_SLUG ?? "default";
    const company = await this.repositories.getCompanyBySlug(companySlug);
    if (!company) {
      throw new Error(`Company ${companySlug} is not initialized`);
    }
    return company;
  }

  private mapStoredSourceItem(row: {
    source: string;
    sourceItemId: string;
    externalId: string;
    fingerprint: string;
    sourceUrl: string;
    title: string;
    text: string;
    summary: string;
    authorName: string | null;
    speakerName: string | null;
    occurredAt: Date;
    ingestedAt: Date;
    metadataJson: unknown;
    rawPayloadJson: unknown;
    rawText: string | null;
    chunksJson: unknown;
  }): NormalizedSourceItem {
    return {
      source: row.source as NormalizedSourceItem["source"],
      sourceItemId: row.sourceItemId,
      externalId: row.externalId,
      sourceFingerprint: row.fingerprint,
      sourceUrl: row.sourceUrl,
      title: row.title,
      text: row.text,
      summary: row.summary,
      authorName: row.authorName ?? undefined,
      speakerName: row.speakerName ?? undefined,
      occurredAt: row.occurredAt.toISOString(),
      ingestedAt: row.ingestedAt.toISOString(),
      metadata: isRecord(row.metadataJson) ? row.metadataJson : {},
      rawPayload: isRecord(row.rawPayloadJson) ? row.rawPayloadJson : {},
      rawText: row.rawText,
      chunks: Array.isArray(row.chunksJson) ? row.chunksJson.map((item) => String(item)) : undefined
    };
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
        model: usage.model ?? this.env.LLM_MODEL ?? "unknown",
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

  private async countPublishabilityViolations(): Promise<number> {
    const result = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(DISTINCT o.id)::bigint as count
       FROM "Opportunity" o
       WHERE o.status != 'Archived'
         AND (
           EXISTS (
             SELECT 1 FROM "EvidenceReference" e
             JOIN "SourceItem" s ON s.id = e."sourceItemId"
             WHERE e."opportunityId" = o.id
             AND s.source = 'claap'
             AND (s."metadataJson"->>'publishabilityRisk' = 'harmful'
               OR s."metadataJson"->>'publishabilityRisk' = 'reframeable')
           )
           OR EXISTS (
             SELECT 1 FROM "OpportunityEvidence" oe
             JOIN "EvidenceReference" e ON e.id = oe."evidenceId"
             JOIN "SourceItem" s ON s.id = e."sourceItemId"
             WHERE oe."opportunityId" = o.id
             AND s.source = 'claap'
             AND (s."metadataJson"->>'publishabilityRisk' = 'harmful'
               OR s."metadataJson"->>'publishabilityRisk' = 'reframeable')
           )
         )`
    );
    return Number(result[0]?.count ?? 0);
  }

  /**
   * Invariant: no non-archived opportunity should have evidence from a blocked source item.
   *
   * For cleanup:claap-publishability — warning now, promote to hard failure after stable period.
   * For intelligence:run — fail hard if the run increased the count, warning-only for pre-existing drift.
   */
  private async checkPublishabilityInvariant(
    run: SyncRun,
    opts: { preRunCount?: number; mode: "cleanup" | "intelligence" }
  ) {
    const count = await this.countPublishabilityViolations();
    if (count === 0) return;

    const message = `Publishability invariant violation: ${count} non-archived opportunity(s) linked to blocked claap evidence`;
    run.warnings.push(message);
    this.logger.error({ count, runType: run.runType }, message);

    if (opts.mode === "intelligence" && opts.preRunCount !== undefined) {
      const newViolations = count - opts.preRunCount;
      if (newViolations > 0) {
        throw new Error(`${message}. This run introduced ${newViolations} new violation(s) — aborting.`);
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
  }

  private buildBridgeRepositories(): BridgeRepositories {
    const prisma = this.prisma;
    return {
      async listSignalsPage(companyId, fromTimestamp, afterId, limit) {
        const tsFilter = fromTimestamp
          ? afterId
            // Same-class keyset: (detectedAt > T) OR (detectedAt = T AND id > afterId)
            ? { OR: [
                { detectedAt: { gt: fromTimestamp } },
                { detectedAt: fromTimestamp, id: { gt: afterId } },
              ] }
            // Cross-class GTE: detectedAt >= T
            : { detectedAt: { gte: fromTimestamp } }
          : {};
        return prisma.salesSignal.findMany({
          where: { companyId, ...tsFilter },
          include: { deal: { select: { dealName: true, stage: true } } },
          orderBy: [{ detectedAt: "asc" }, { id: "asc" }],
          take: limit,
        });
      },
      async listStandaloneEligibleFactsPage(companyId, fromTimestamp, afterId, limit) {
        const tsFilter = fromTimestamp
          ? afterId
            ? { OR: [
                { createdAt: { gt: fromTimestamp } },
                { createdAt: fromTimestamp, id: { gt: afterId } },
              ] }
            : { createdAt: { gte: fromTimestamp } }
          : {};
        return prisma.salesExtractedFact.findMany({
          where: {
            companyId,
            category: "requested_capability",
            confidence: { gte: 0.7 },
            NOT: { extractedValue: "" },
            ...tsFilter,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limit,
        });
      },
      async listExtractionsForDeal(dealId) {
        return prisma.salesExtractedFact.findMany({
          where: { dealId },
          orderBy: { createdAt: "desc" },
        });
      },
      async getDeal(dealId) {
        return prisma.salesDeal.findUnique({
          where: { id: dealId },
          select: { dealName: true, stage: true },
        });
      },
    };
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
    companyId?: string;
    sourceFingerprint: string;
    title: string;
    ownerProfile: string | null;
    ownerUserId?: string | null;
    narrativePillar: string | null;
    targetSegment?: string | null;
    editorialPillar?: string | null;
    awarenessTarget?: string | null;
    buyerFriction?: string | null;
    contentMotion?: string | null;
    angle: string;
    editorialClaim?: string | null;
    whyNow: string;
    whatItIsAbout: string;
    whatItIsNotAbout: string;
    routingStatus: string | null;
    readiness: string | null;
    status: string;
    suggestedFormat: string;
    supportingEvidenceCount: number;
    evidenceFreshness: number;
    editorialOwner: string | null;
    editorialNotes?: string | null;
    dedupFlag?: string | null;
    notionEditsPending?: boolean;
    selectedAt: Date | null;
    lastDigestAt?: Date | null;
    updatedAt: Date;
    primaryEvidenceId: string | null;
    enrichmentLogJson?: unknown;
    v1HistoryJson?: unknown;
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
    linkedEvidence?: Array<{
      evidence: {
        id: string;
        source: string;
        sourceItemId: string;
        sourceUrl: string;
        timestamp: Date;
        excerpt: string;
        excerptHash: string;
        speakerOrAuthor: string | null;
        freshnessScore: number;
      };
    }>;
  }): ContentOpportunity {
    const fkEvidence = row.evidence.map(mapStoredEvidence);
    const junctionEvidence = (row.linkedEvidence ?? []).map((link) => mapStoredEvidence(link.evidence));
    const allEvidence = dedupeEvidenceReferences([...fkEvidence, ...junctionEvidence]);

    // Resolve primaryEvidenceId with dedupe preservation
    let effectivePrimaryId = row.primaryEvidenceId;
    if (effectivePrimaryId && !allEvidence.some((e) => e.id === effectivePrimaryId)) {
      const dropped = [...fkEvidence, ...junctionEvidence].find((e) => e.id === effectivePrimaryId);
      if (dropped) {
        const sig = evidenceSignature(dropped);
        const replacement = allEvidence.find((e) => evidenceSignature(e) === sig);
        if (replacement) effectivePrimaryId = replacement.id;
      }
    }

    let primaryEvidence = row.primaryEvidence
      ? mapStoredEvidence(row.primaryEvidence)
      : selectPrimaryEvidence(allEvidence, {
          id: effectivePrimaryId ?? undefined,
          signature: effectivePrimaryId
            ? evidenceSignature(allEvidence.find((item) => item.id === effectivePrimaryId) ?? row.evidence[0] ?? { sourceItemId: "", excerptHash: "" })
            : undefined
        });
    if (!primaryEvidence) {
      if (row.status === "Archived") {
        primaryEvidence = { id: "", source: "claap" as const, sourceItemId: "", sourceUrl: "", timestamp: "", excerpt: "[archived]", excerptHash: "", freshnessScore: 0 };
      } else {
        throw new Error(`Opportunity ${row.id} is missing evidence`);
      }
    }

    const enrichmentLog = parseEnrichmentLog(row.enrichmentLogJson);

    return {
      id: row.id,
      companyId: row.companyId ?? undefined,
      sourceFingerprint: row.sourceFingerprint,
      title: row.title,
      ownerProfile: row.ownerProfile as ContentOpportunity["ownerProfile"],
      ownerUserId: row.ownerUserId ?? undefined,
      narrativePillar: row.narrativePillar ?? "",
      ...normalizeGtmFields({
        targetSegment: row.targetSegment,
        editorialPillar: row.editorialPillar,
        awarenessTarget: row.awarenessTarget,
        buyerFriction: row.buyerFriction,
        contentMotion: row.contentMotion,
      }),
      angle: row.angle,
      editorialClaim: row.editorialClaim || undefined,
      whyNow: row.whyNow,
      whatItIsAbout: row.whatItIsAbout,
      whatItIsNotAbout: row.whatItIsNotAbout,
      evidence: allEvidence,
      primaryEvidence,
      supportingEvidenceCount: Math.max(0, allEvidence.length - 1),
      evidenceFreshness: row.evidenceFreshness,
      evidenceExcerpts: allEvidence.map((item) => item.excerpt),
      routingStatus: (row.routingStatus ?? "Routed") as ContentOpportunity["routingStatus"],
      readiness: (row.readiness ?? "Opportunity only") as ContentOpportunity["readiness"],
      status: row.status as ContentOpportunity["status"],
      suggestedFormat: row.suggestedFormat,
      enrichmentLog,
      editorialOwner: row.editorialOwner ?? undefined,
      editorialNotes: row.editorialNotes ?? "",
      dedupFlag: row.dedupFlag || undefined,
      notionEditsPending: row.notionEditsPending ?? false,
      selectedAt: row.selectedAt?.toISOString(),
      v1History: expectStringArray(row.v1HistoryJson ?? []),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function parseEnrichmentLog(value: unknown): EnrichmentLogEntry[] {
  if (!Array.isArray(value)) return [];
  return value as EnrichmentLogEntry[];
}

function mapUserRecord(row: {
  id: string;
  companyId: string;
  displayName: string;
  type: string;
  language: string;
  baseProfile: unknown;
  createdAt: Date;
  updatedAt: Date;
}): UserRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    displayName: row.displayName,
    type: row.type as "human" | "corporate",
    language: row.language,
    baseProfile: isRecord(row.baseProfile) ? row.baseProfile : {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}
