import {
  loadConnectorConfigs,
  loadMarketResearchRuntimeConfig
} from "./config/loaders.js";
import type { AppEnv } from "./config/env.js";
import { createConnectorRegistry } from "./connectors/index.js";
import { getPrisma } from "./db/client.js";
import { RepositoryBundle, sourceItemDbId } from "./db/repositories.js";
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
import { NotionService } from "./services/notion.js";
import { computeRawTextExpiry } from "./services/retention.js";
import { ensureConvergenceFoundation } from "./services/convergence.js";
import { runIntelligencePipeline } from "./services/intelligence.js";
import { runMarketResearch } from "./services/market-research.js";
import { findSupportingEvidence, assessDraftReadiness, deriveProvenanceType, computeReadinessTier, generateOperatorGuidance } from "./services/evidence-pack.js";

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

  constructor(
    private readonly env: AppEnv,
    private readonly logger: LoggerLike,
    deps: Partial<{
      prisma: ReturnType<typeof getPrisma>;
      repositories: RepositoryBundle;
      llmClient: LlmClient;
      notion: NotionService;
    }> = {}
  ) {
    this.prisma = deps.prisma ?? getPrisma();
    this.repositories = deps.repositories ?? new RepositoryBundle(this.prisma);
    this.llmClient = deps.llmClient ?? new LlmClient(env, logger);
    this.notion =
      deps.notion ??
      new NotionService(env.NOTION_TOKEN ?? "", env.NOTION_PARENT_PAGE_ID ?? "", {
        bindings: this.repositories,
        onWarning: (warning) => this.logger.warn?.({ warning }, "Notion self-heal warning")
      });
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

    await ensureConvergenceFoundation(this.repositories, this.env, this.notion);

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
      case "setup:notion":
        return this.setupNotion();
      case "selection:scan":
        return this.scanSelections(context);
      case "cleanup:retention":
        return this.cleanupRetention(context);
      case "backfill:evidence":
        return this.backfillEvidence(context);
      default:
        throw new Error(`Unsupported command: ${command satisfies never}`);
    }
  }

  private async setupNotion() {
    const result = await this.notion.ensureSchema();
    this.logger.info({ databases: result.databases, views: result.viewSpecs }, "Notion schema ensured");
  }

  private async ingestRun(context: RunContext) {
    const run = createRun("ingest:run");
    if (!context.dryRun) {
      await this.repositories.createSyncRun(run);
    }

    try {
      const company = await this.getActiveCompany(context);
      const staticInputs = await this.loadStaticInputs(context);
      const registry = createConnectorRegistry(this.env);
      const sourceMaxCursor = new Map<string, string | null>();

      for (const config of staticInputs.configs.filter((entry) => entry.enabled)) {
        const rawItems = await this.fetchSourceItems(config, registry[config.source], context, company.id);
        run.counters.fetched += rawItems.length;
        const sortedItems = [...rawItems].sort((left, right) => compareCursors(left.cursor, right.cursor));
        const maxCursor = sortedItems.reduce<string | null>(
          (current, item) => maxCursorValue(current, item.cursor),
          await this.repositories.getCursor(config.source, company.id)
        );

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

        sourceMaxCursor.set(config.source, maxCursor);
      }

      if (!context.dryRun) {
        for (const [source, cursor] of sourceMaxCursor.entries()) {
          await this.repositories.setCursor(source, cursor, this.prisma, company.id);
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
      await this.repositories.createSyncRun(run);
    }

    try {
      const inputs = await this.loadIntelligenceInputs(company.id);
      const rows = await this.repositories.listPendingSourceItems({
        companyId: company.id,
        take: 100
      });
      const items = rows.map((row) => this.mapStoredSourceItem(row));

      const opportunityRows = await this.repositories.listRecentActiveOpportunities({
        companyId: company.id,
        take: 40
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
        recentOpportunities
      });

      for (const event of pipelineResult.usageEvents) {
        this.recordUsage(run, costs, event.usage, event.step, fallbackSteps);
      }

      if (!context.dryRun) {
        // Save screening results
        const screeningEntries = [...pipelineResult.screeningResults.entries()].map(([externalId, result]) => ({
          id: sourceItemDbId(company.id, externalId),
          result
        }));
        if (screeningEntries.length > 0) {
          await this.repositories.saveScreeningResults(screeningEntries);
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

          const syncedOpportunity: ContentOpportunity = {
            ...opp,
            evidence: allEvidence,
            enrichmentLog: [...opp.enrichmentLog, packLogEntry],
            supportingEvidenceCount: opp.supportingEvidenceCount + supportEvidence.length,
            evidenceExcerpts: allEvidence.map(e => e.excerpt)
          };

          const ownerDisplayName = opp.ownerUserId
            ? inputs.users.find(u => u.id === opp.ownerUserId)?.displayName
            : undefined;
          const opportunitySync = await this.notion.syncOpportunity(syncedOpportunity, null, {
            ownerDisplayName,
            provenanceType,
            draftReadiness: { tier: readiness.readinessTier, guidance: readiness.operatorGuidance }
          });
          if (opportunitySync) {
            run.counters[opportunitySync.action === "created" ? "notionCreates" : "notionUpdates"] += 1;
            await this.repositories.updateOpportunityNotionSync(opp.id, opportunitySync.notionPageId, opp.notionPageFingerprint);
          }
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

          // Compute draft readiness for enriched opportunities
          const enrichedReadiness = assessDraftReadiness(enriched.opportunity, enriched.opportunity.evidence, {
            sourceItems: enrichedSourceItems
          });
          const enrichedOwnerDisplayName = enriched.opportunity.ownerUserId
            ? inputs.users.find(u => u.id === enriched.opportunity.ownerUserId)?.displayName
            : undefined;
          const opportunitySync = await this.notion.syncOpportunity(enriched.opportunity, null, {
            ownerDisplayName: enrichedOwnerDisplayName,
            draftReadiness: { tier: enrichedReadiness.readinessTier, guidance: enrichedReadiness.operatorGuidance }
          });
          if (opportunitySync) {
            run.counters[opportunitySync.action === "created" ? "notionCreates" : "notionUpdates"] += 1;
            await this.repositories.updateOpportunityNotionSync(enriched.opportunity.id, opportunitySync.notionPageId, enriched.opportunity.notionPageFingerprint);
          }
        }

        // Reassess readiness for recent active opportunities not already synced in this run
        const syncedOppIds = new Set([
          ...pipelineResult.created.map((o) => o.id),
          ...pipelineResult.enriched.map((e) => e.opportunity.id)
        ]);

        // Hydrate source items for reassessment
        const reassessSourceItemIds = [...new Set(
          recentOpportunities
            .filter(opp => !syncedOppIds.has(opp.id))
            .flatMap(opp => opp.evidence.map(e => e.sourceItemId))
        )];
        const reassessSourceItemRows = await this.repositories.listSourceItemsByIds(reassessSourceItemIds);
        const reassessSourceItems = reassessSourceItemRows.map(row => this.mapStoredSourceItem(row));

        for (const opp of recentOpportunities) {
          if (syncedOppIds.has(opp.id)) continue;
          const readiness = assessDraftReadiness(opp, opp.evidence, {
            sourceItems: reassessSourceItems
          });
          const ownerDisplayName = opp.ownerUserId
            ? inputs.users.find(u => u.id === opp.ownerUserId)?.displayName
            : undefined;
          const syncResult = await this.notion.syncOpportunity(opp, null, {
            ownerDisplayName,
            draftReadiness: { tier: readiness.readinessTier, guidance: readiness.operatorGuidance }
          });
          if (syncResult) {
            run.counters[syncResult.action === "created" ? "notionCreates" : "notionUpdates"] += 1;
            await this.repositories.updateOpportunityNotionSync(opp.id, syncResult.notionPageId, opp.notionPageFingerprint);
          }
        }

        // Mark processed
        const dbIds = pipelineResult.processedSourceItemIds.map((externalId) =>
          sourceItemDbId(company.id, externalId)
        );
        await this.repositories.markSourceItemsProcessed(dbIds, context.now);

        // Sync users to Notion Profiles database
        for (const user of inputs.users) {
          await this.notion.syncUser({
            displayName: user.displayName,
            type: user.type,
            language: user.language,
            baseProfile: user.baseProfile,
            notionPageFingerprint: hashParts([company.id, user.id])
          });
        }
      }

      this.applyFallbackThresholds(run, fallbackSteps);
      const finished = finalizeRun(run, "completed", `Intelligence completed for ${rows.length} source items`);
      await this.finishRun(finished, costs, context);
    } catch (error) {
      const failed = finalizeRun(run, "failed", error instanceof Error ? error.message : "Unknown intelligence error");
      await this.finishRun(failed, costs, context);
      throw error;
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

      const editorialNotes = opportunity.notionPageId
        ? await this.notion.getEditorialNotes(opportunity.notionPageId)
        : "";

      const result = await generateDraft({
        opportunity,
        user: authorUser,
        llmClient: this.llmClient,
        sensitivityRulesMarkdown: inputs.sensitivityMarkdown,
        doctrineMarkdown: inputs.doctrineMarkdown,
        editorialNotes,
        layer3Defaults: inputs.layer3Defaults
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
        const draftSourceItemIds = [...new Set(opportunity.evidence.map(e => e.sourceItemId))];
        const draftSourceItemRows = await this.repositories.listSourceItemsByIds(draftSourceItemIds);
        const draftSourceItems = draftSourceItemRows.map(row => this.mapStoredSourceItem(row));
        const draftReadiness = assessDraftReadiness(opportunity, opportunity.evidence, {
          sourceItems: draftSourceItems
        });
        const ownerDisplayName = opportunity.ownerUserId
          ? inputs.users.find(u => u.id === opportunity.ownerUserId)?.displayName
          : undefined;
        const syncResult = await this.notion.syncOpportunity(opportunity, result.draft, {
          ownerDisplayName,
          draftReadiness: { tier: draftReadiness.readinessTier, guidance: draftReadiness.operatorGuidance }
        });
        if (syncResult) {
          run.counters[syncResult.action === "created" ? "notionCreates" : "notionUpdates"] += 1;
          await this.repositories.updateOpportunityNotionSync(opportunity.id, syncResult.notionPageId, opportunity.notionPageFingerprint);
          await this.notion.writeDraftToPageBody(syncResult.notionPageId, result.draft);
        }
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

          const editorialNotes = opportunity.notionPageId
            ? await this.notion.getEditorialNotes(opportunity.notionPageId)
            : "";

          const result = await generateDraft({
            opportunity,
            user: authorUser,
            llmClient: this.llmClient,
            sensitivityRulesMarkdown: inputs.sensitivityMarkdown,
            doctrineMarkdown: inputs.doctrineMarkdown,
            editorialNotes,
            layer3Defaults: inputs.layer3Defaults
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
            const ownerDisplayName = opportunity.ownerUserId
              ? inputs.users.find(u => u.id === opportunity.ownerUserId)?.displayName
              : undefined;
            const readiness = assessDraftReadiness(opportunity, opportunity.evidence, { sourceItems });
            const syncResult = await this.notion.syncOpportunity(opportunity, result.draft, {
              ownerDisplayName,
              draftReadiness: { tier: readiness.readinessTier, guidance: readiness.operatorGuidance }
            });
            if (syncResult) {
              run.counters[syncResult.action === "created" ? "notionCreates" : "notionUpdates"] += 1;
              await this.repositories.updateOpportunityNotionSync(opportunity.id, syncResult.notionPageId, opportunity.notionPageFingerprint);
              await this.notion.writeDraftToPageBody(syncResult.notionPageId, result.draft);
            }
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
          await this.repositories.markOpportunitySelected(opportunity.id, candidate.editorialOwner);
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

      // Load users for owner display names in Notion sync
      const users = await this.repositories.listUsers(company.id);

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

        const allEvidence = [...opp.evidence, ...supportEvidence];
        const sourceItemIds = [...new Set(allEvidence.map((e) => e.sourceItemId))];
        const sourceItemRows = await this.repositories.listSourceItemsByIds(sourceItemIds);
        const sourceItems = sourceItemRows.map((row) => this.mapStoredSourceItem(row));
        const readiness = assessDraftReadiness(opp, allEvidence, { sourceItems });

        const ownerDisplayName = opp.ownerUserId
          ? users.find((u) => u.id === opp.ownerUserId)?.displayName
          : undefined;
        const syncResult = await this.notion.syncOpportunity(
          { ...opp, evidence: allEvidence, enrichmentLog: [...opp.enrichmentLog, logEntry], supportingEvidenceCount: opp.supportingEvidenceCount + supportEvidence.length, evidenceExcerpts: allEvidence.map((e) => e.excerpt) },
          null,
          { ownerDisplayName, draftReadiness: { tier: readiness.readinessTier, guidance: readiness.operatorGuidance } }
        );
        if (syncResult) {
          run.counters[syncResult.action === "created" ? "notionCreates" : "notionUpdates"] += 1;
          await this.repositories.updateOpportunityNotionSync(opp.id, syncResult.notionPageId, opp.notionPageFingerprint);
        }

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

  private async loadIntelligenceInputs(companyId: string) {
    const [editorialConfig, users] = await Promise.all([
      this.repositories.getLatestEditorialConfig(companyId),
      this.repositories.listUsers(companyId)
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
      layer3Defaults: layer3.defaults ?? [],
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
    const configs = await loadConnectorConfigs();
    return { configs };
  }

  private async fetchSourceItems(
    config: ConnectorConfig,
    connector: ReturnType<typeof createConnectorRegistry>[ConnectorConfig["source"]],
    context: RunContext,
    companyId?: string
  ) {
    const cursor = await this.repositories.getCursor(config.source, companyId);
    return connector.fetchSince(cursor, config as never, context);
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
        model: this.env.LLM_MODEL ?? "unknown",
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
    companyId?: string;
    sourceFingerprint: string;
    title: string;
    ownerProfile: string | null;
    ownerUserId?: string | null;
    narrativePillar: string | null;
    angle: string;
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

    const primaryEvidence = row.primaryEvidence
      ? mapStoredEvidence(row.primaryEvidence)
      : selectPrimaryEvidence(allEvidence, {
          id: effectivePrimaryId ?? undefined,
          signature: effectivePrimaryId
            ? evidenceSignature(allEvidence.find((item) => item.id === effectivePrimaryId) ?? row.evidence[0] ?? { sourceItemId: "", excerptHash: "" })
            : undefined
        });
    if (!primaryEvidence) {
      throw new Error(`Opportunity ${row.id} is missing evidence`);
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
      angle: row.angle,
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
