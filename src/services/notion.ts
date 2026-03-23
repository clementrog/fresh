import { Client } from "@notionhq/client";

import { notionSelectionRowSchema } from "../config/schema.js";
import type {
  ContentOpportunity,
  DraftV1,
  EnrichmentLogEntry,
  NotionSelectionRow,
  NotionSyncResult,
  SyncRun
} from "../domain/types.js";

export const REQUIRED_DATABASES = [
  "Content Opportunities",
  "Claap Review",
  "Linear Review",
  "Profiles",
  "Sync Runs"
] as const;

type RequiredDatabase = (typeof REQUIRED_DATABASES)[number];
type NotionClientLike = Client;

export type NotionBindingStore = {
  getNotionDatabaseBinding(parentPageId: string, name: RequiredDatabase): Promise<{ databaseId: string } | null>;
  upsertNotionDatabaseBinding(parentPageId: string, name: RequiredDatabase, databaseId: string): Promise<unknown>;
  clearNotionDatabaseBinding(parentPageId: string, name: RequiredDatabase): Promise<unknown>;
};

export class NotionService {
  private readonly client: NotionClientLike | null;
  private readonly databaseCache = new Map<RequiredDatabase, string>();
  private readonly schemaPatchedCache = new Set<string>();
  private readonly bindings?: NotionBindingStore;
  private readonly warningSink?: (warning: string) => void;
  private readonly parentPageId: string;

  constructor(
    private readonly token: string,
    parentPageId: string,
    options: {
      client?: NotionClientLike;
      bindings?: NotionBindingStore;
      onWarning?: (warning: string) => void;
    } = {}
  ) {
    this.client = options.client ?? (token ? new Client({ auth: token }) : null);
    this.bindings = options.bindings;
    this.warningSink = options.onWarning;
    this.parentPageId = normalizeNotionId(parentPageId);
  }

  isEnabled() {
    return Boolean(this.client && this.parentPageId);
  }

  async ensureSchema() {
    if (!this.client || !this.parentPageId) {
      return {
        databases: [] as string[],
        viewSpecs: manualReviewViewSpecs()
      };
    }

    const databases: string[] = [];
    for (const name of REQUIRED_DATABASES) {
      const id = await this.ensureDatabase(name);
      databases.push(id);
    }

    await this.ensureOperationsGuide();

    return {
      databases,
      viewSpecs: manualReviewViewSpecs()
    };
  }

  async syncOpportunity(
    opportunity: ContentOpportunity,
    draft?: DraftV1 | null,
    options?: { ownerDisplayName?: string; provenanceType?: string; draftReadiness?: { tier: string; guidance: string[] }; reframingNote?: string }
  ): Promise<NotionSyncResult | null> {
    const ownerDisplay = options?.ownerDisplayName ?? opportunity.ownerProfile ?? "";
    const enrichmentLogText = formatEnrichmentLog(opportunity.enrichmentLog);
    const readinessSelect = mapReadinessTierToSelect(options?.draftReadiness?.tier);
    const whatsMissing = formatOperatorGuidance(options?.draftReadiness?.guidance ?? []);
    return this.upsertDatabasePage({
      databaseName: "Content Opportunities",
      notionPageId: opportunity.notionPageId,
      fingerprintProperty: "Opportunity fingerprint",
      fingerprint: opportunity.notionPageFingerprint,
      properties: {
        Title: titleProperty(opportunity.title),
        "Owner profile": richTextProperty(ownerDisplay),
        "Narrative pillar": richTextProperty(opportunity.narrativePillar ?? ""),
        Angle: richTextProperty(opportunity.angle),
        "Why now": richTextProperty(opportunity.whyNow),
        "What it is about": richTextProperty(opportunity.whatItIsAbout),
        "What it is not about": richTextProperty(opportunity.whatItIsNotAbout),
        "Source of origin": richTextProperty(opportunity.primaryEvidence.source),
        "Suggested format": richTextProperty(opportunity.suggestedFormat),
        "Hook suggestion 1": richTextProperty(""),
        "Hook suggestion 2": richTextProperty(""),
        "Format rationale": richTextProperty(""),
        "Source URL": richTextProperty(opportunity.primaryEvidence.sourceUrl),
        "Provenance type": richTextProperty(options?.provenanceType ?? opportunity.primaryEvidence.source),
        "Draft readiness": selectProperty(readinessSelect),
        "What's missing": richTextProperty(whatsMissing),
        "Reframing note": richTextProperty(options?.reframingNote ?? ""),
        "Evidence count": numberProperty(opportunity.evidence.length),
        "Primary evidence": richTextProperty(opportunity.primaryEvidence.excerpt),
        "Supporting evidence count": numberProperty(Math.max(0, opportunity.evidence.length - 1)),
        "Evidence freshness": numberProperty(opportunity.evidenceFreshness),
        "Evidence excerpts": richTextProperty(opportunity.evidenceExcerpts.join("\n\n")),
        "Enrichment log": richTextProperty(enrichmentLogText),
        "V1 draft": richTextProperty(draft ? `V1 generated on ${new Date().toISOString().slice(0, 10)}` : ""),
        "Selected at": opportunity.selectedAt ? dateProperty(opportunity.selectedAt) : emptyDateProperty(),
        "Editorial owner": richTextProperty(ownerDisplay),
        "Opportunity fingerprint": richTextProperty(opportunity.notionPageFingerprint)
      },
      createOnlyProperties: {
        Status: selectProperty(opportunity.status),
        "Editorial notes": richTextProperty("")
      }
    });
  }

  async syncClaapReviewItem(item: {
    signalTitle: string;
    publishabilityRisk: "reframeable" | "harmful";
    originalSignalSummary: string;
    keyExcerpts: string[];
    whyBlocked: string;
    reframingSuggestion?: string;
    transcriptLink: string;
    occurredAt: string;
    reviewFingerprint: string;
    claapSourceItemId: string;
    notionPageId?: string;
  }): Promise<NotionSyncResult | null> {
    if (!this.client) {
      return null;
    }

    const databaseId = await this.ensureDatabase("Claap Review");
    let existingPage = item.notionPageId
      ? await this.retrievePage(item.notionPageId)
      : null;

    if (!existingPage) {
      existingPage = await this.findPageByFingerprintWithProperties(databaseId, "Review fingerprint", item.reviewFingerprint);
    }

    const existingDecision = existingPage
      ? getSelectPropertyName(existingPage, "Decision")
      : "";
    const existingTitle = existingPage
      ? getTitlePropertyText(existingPage, "Signal title")
      : "";
    const existingRisk = existingPage
      ? getSelectPropertyName(existingPage, "Publishability risk")
      : "";
    const existingSummary = existingPage
      ? getRichTextPropertyText(existingPage, "Original signal summary")
      : "";
    const existingSuggestion = existingPage
      ? getRichTextPropertyText(existingPage, "Reframing suggestion")
      : "";
    const materialChange = Boolean(
      existingPage
      && (
        existingTitle !== item.signalTitle
        || existingRisk !== item.publishabilityRisk
        || existingSummary !== item.originalSignalSummary
        || existingSuggestion !== (item.reframingSuggestion ?? "")
      )
    );

    const properties = compactProperties({
      "Signal title": titleProperty(item.signalTitle),
      "Publishability risk": selectProperty(item.publishabilityRisk),
      "Original signal summary": richTextProperty(item.originalSignalSummary),
      "Key excerpts": richTextProperty(item.keyExcerpts.join("\n\n")),
      "Why blocked": richTextProperty(item.whyBlocked),
      "Reframing suggestion": richTextProperty(item.reframingSuggestion ?? ""),
      "Transcript link": urlProperty(item.transcriptLink),
      Decision: materialChange
        ? emptySelectProperty()
        : existingDecision
          ? selectProperty(existingDecision)
          : existingPage ? undefined : emptySelectProperty(),
      "Occurred at": dateProperty(item.occurredAt),
      "Review fingerprint": richTextProperty(item.reviewFingerprint),
      "Claap source item id": richTextProperty(item.claapSourceItemId)
    });

    if (existingPage) {
      const pageId = getPageId(existingPage);
      if (!pageId) {
        throw new Error("Claap review page is missing an id");
      }
      await this.client.pages.update({
        page_id: pageId,
        archived: false,
        properties: properties as any
      });
      return {
        notionPageId: pageId,
        action: "updated"
      };
    }

    const created = await this.client.pages.create({
      parent: { database_id: databaseId },
      properties: properties as any
    });
    return {
      notionPageId: created.id,
      action: "created"
    };
  }

  async syncLinearReviewItem(item: {
    itemTitle: string;
    classification: "manual-review-needed";
    rationale: string;
    customerVisibility: string;
    sensitivityLevel: string;
    evidenceStrength: number;
    reviewNote?: string;
    linearLink: string;
    itemType: string;
    stateName?: string;
    teamName?: string;
    priority?: number;
    labels?: string;
    occurredAt: string;
    reviewFingerprint: string;
    linearSourceItemId: string;
    notionPageId?: string;
  }): Promise<NotionSyncResult | null> {
    if (!this.client) {
      return null;
    }

    const databaseId = await this.ensureDatabase("Linear Review");
    let existingPage = item.notionPageId
      ? await this.retrievePage(item.notionPageId)
      : null;

    if (!existingPage) {
      existingPage = await this.findPageByFingerprintWithProperties(databaseId, "Review fingerprint", item.reviewFingerprint);
    }

    const existingDecision = existingPage
      ? getSelectPropertyName(existingPage, "Decision")
      : "";
    const existingTitle = existingPage
      ? getTitlePropertyText(existingPage, "Item title")
      : "";
    const existingClassification = existingPage
      ? getSelectPropertyName(existingPage, "Classification")
      : "";
    const existingRationale = existingPage
      ? getRichTextPropertyText(existingPage, "Rationale")
      : "";
    const existingCustomerVisibility = existingPage
      ? getSelectPropertyName(existingPage, "Customer visibility")
      : "";
    const existingSensitivityLevel = existingPage
      ? getSelectPropertyName(existingPage, "Sensitivity level")
      : "";
    const materialChange = Boolean(
      existingPage
      && (
        existingTitle !== item.itemTitle
        || existingClassification !== item.classification
        || existingRationale !== item.rationale
        || existingCustomerVisibility !== item.customerVisibility
        || existingSensitivityLevel !== item.sensitivityLevel
      )
    );

    const properties = compactProperties({
      "Item title": titleProperty(item.itemTitle),
      Classification: selectProperty(item.classification),
      Rationale: richTextProperty(item.rationale),
      "Customer visibility": selectProperty(item.customerVisibility),
      "Sensitivity level": selectProperty(item.sensitivityLevel),
      "Evidence strength": numberProperty(item.evidenceStrength),
      "Review note": richTextProperty(item.reviewNote ?? ""),
      "Linear link": urlProperty(item.linearLink),
      "Item type": richTextProperty(item.itemType),
      State: richTextProperty(item.stateName ?? ""),
      Team: richTextProperty(item.teamName ?? ""),
      Priority: numberProperty(item.priority ?? 0),
      Labels: richTextProperty(item.labels ?? ""),
      "Occurred at": dateProperty(item.occurredAt),
      Decision: materialChange
        ? emptySelectProperty()
        : existingDecision
          ? selectProperty(existingDecision)
          : existingPage ? undefined : emptySelectProperty(),
      "Review fingerprint": richTextProperty(item.reviewFingerprint),
      "Linear source item id": richTextProperty(item.linearSourceItemId)
    });

    if (existingPage) {
      const pageId = getPageId(existingPage);
      if (!pageId) {
        throw new Error("Linear review page is missing an id");
      }
      await this.client.pages.update({
        page_id: pageId,
        archived: false,
        properties: properties as any
      });
      return {
        notionPageId: pageId,
        action: "updated"
      };
    }

    const created = await this.client.pages.create({
      parent: { database_id: databaseId },
      properties: properties as any
    });
    return {
      notionPageId: created.id,
      action: "created"
    };
  }

  async archiveLinearReviewItem(notionPageId: string): Promise<void> {
    if (!this.client) return;
    await this.client.pages.update({
      page_id: notionPageId,
      archived: true
    } as any);
  }

  /** Write draft content into the page body, replacing any existing draft section. */
  async writeDraftToPageBody(notionPageId: string, draft: DraftV1): Promise<void> {
    if (!this.client) return;

    // Clear existing page content
    const existing = await this.client.blocks.children.list({ block_id: notionPageId, page_size: 100 });
    for (const block of existing.results) {
      if ("type" in block) {
        await this.client.blocks.delete({ block_id: block.id });
      }
    }

    // Build blocks for the draft
    const blocks: any[] = [];

    blocks.push({
      type: "heading_2",
      heading_2: { rich_text: [{ text: { content: "Draft V1" } }] }
    });

    // Hook as a plain paragraph (first line of the post)
    if (draft.hook) {
      blocks.push({
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: draft.hook.slice(0, 2000) } }] }
      });
    }

    // Main draft text as paragraphs (split on double newlines, respect 2000 char limit)
    const paragraphs = draft.firstDraftText.split(/\n{2,}/);
    for (const para of paragraphs) {
      if (!para.trim()) continue;
      // Notion rich_text limit is 2000 chars per element
      for (let i = 0; i < para.length; i += 2000) {
        blocks.push({
          type: "paragraph",
          paragraph: { rich_text: [{ text: { content: para.slice(i, i + 2000) } }] }
        });
      }
    }

    blocks.push({ type: "divider", divider: {} });

    // Visual idea
    if (draft.visualIdea) {
      blocks.push({
        type: "heading_3",
        heading_3: { rich_text: [{ text: { content: "Visual idea" } }] }
      });
      blocks.push({
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: draft.visualIdea.slice(0, 2000) } }] }
      });
    }

    // Summary
    if (draft.summary) {
      blocks.push({
        type: "heading_3",
        heading_3: { rich_text: [{ text: { content: "Summary" } }] }
      });
      blocks.push({
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: draft.summary.slice(0, 2000) } }] }
      });
    }

    // Append all blocks (Notion allows max 100 per call)
    for (let i = 0; i < blocks.length; i += 100) {
      await this.client.blocks.children.append({
        block_id: notionPageId,
        children: blocks.slice(i, i + 100)
      });
    }
  }

  /** Sync a User record to the Profiles database. */
  async syncUser(user: {
    displayName: string;
    type: string;
    language: string;
    baseProfile: Record<string, unknown>;
    notionPageFingerprint: string;
  }): Promise<NotionSyncResult | null> {
    const bp = user.baseProfile;
    const str = (key: string) => typeof bp[key] === "string" ? bp[key] as string : "";
    const arr = (key: string) => Array.isArray(bp[key]) ? (bp[key] as string[]) : [];
    return this.upsertDatabasePage({
      databaseName: "Profiles",
      fingerprintProperty: "Profile fingerprint",
      fingerprint: user.notionPageFingerprint,
      properties: {
        "Profile name": titleProperty(user.displayName),
        Role: richTextProperty(user.type),
        "Language preference": richTextProperty(user.language),
        "Tone summary": richTextProperty(str("toneSummary")),
        "Preferred structure": richTextProperty(str("preferredStructure")),
        "Typical phrases": richTextProperty(arr("typicalPhrases").join(", ")),
        "Avoid rules": richTextProperty(arr("avoidRules").join("\n")),
        "Content territories": richTextProperty(arr("contentTerritories").join(", ")),
        "Weak-fit territories": richTextProperty(arr("weakFitTerritories").join(", ")),
        "Sample excerpts": richTextProperty(arr("sampleExcerpts").join("\n\n")),
        "Last refreshed": dateProperty(new Date().toISOString()),
        "Profile fingerprint": richTextProperty(user.notionPageFingerprint)
      }
    });
  }

  async syncRun(run: SyncRun): Promise<NotionSyncResult | null> {
    return this.upsertDatabasePage({
      databaseName: "Sync Runs",
      notionPageId: run.notionPageId,
      fingerprintProperty: "Run fingerprint",
      fingerprint: run.notionPageFingerprint,
      properties: {
        "Run date": titleProperty(run.startedAt),
        Source: richTextProperty(run.source ?? ""),
        Status: selectProperty(run.status),
        "Items fetched": numberProperty(run.counters.fetched),
        "Items processed": numberProperty(run.counters.normalized),
        Errors: richTextProperty(run.status === "failed" ? run.notes ?? "Unknown failure" : ""),
        Notes: richTextProperty(run.notes ?? ""),
        "Run type": richTextProperty(run.runType),
        "Started at": dateProperty(run.startedAt),
        "Finished at": run.finishedAt ? dateProperty(run.finishedAt) : emptyDateProperty(),
        "Step-level counts": richTextProperty(JSON.stringify(run.counters)),
        "Warning flags": richTextProperty(run.warnings.join(", ")),
        "Token and cost totals": richTextProperty(JSON.stringify(run.llmStats)),
        "Run fingerprint": richTextProperty(run.notionPageFingerprint)
      }
    });
  }

  async archiveOpportunityInNotion(notionPageId: string): Promise<void> {
    if (!this.client) return;
    await this.client.pages.update({
      page_id: notionPageId,
      properties: {
        Status: selectProperty("Archived")
      } as any
    });
  }

  async archiveClaapReviewItem(notionPageId: string): Promise<void> {
    if (!this.client) return;
    await this.client.pages.update({
      page_id: notionPageId,
      archived: true
    } as any);
  }

  async getEditorialNotes(notionPageId: string): Promise<string> {
    if (!this.client) return "";
    try {
      const page = await this.client.pages.retrieve({ page_id: notionPageId });
      const typedPage = page as any;
      const editorialNotesValue = typedPage.properties?.["Editorial notes"];
      if (editorialNotesValue?.type === "rich_text") {
        return editorialNotesValue.rich_text
          .map((entry: { plain_text: string }) => entry.plain_text)
          .join("");
      }
      return "";
    } catch (error) {
      if (isNotionObjectNotFoundError(error)) {
        return "";
      }
      throw error;
    }
  }

  async readToneOfVoiceProfiles(databaseId: string): Promise<Array<{
    pageId: string;
    profileName: string;
    voiceSummary: string;
    preferredPatterns: string;
    avoid: string;
    source: "properties" | "body";
  }>> {
    if (!this.client || !databaseId) return [];

    const results: Array<{ pageId: string; profileName: string; voiceSummary: string; preferredPatterns: string; avoid: string; source: "properties" | "body" }> = [];
    let startCursor: string | undefined;

    do {
      const response = await this.client.databases.query({
        database_id: databaseId,
        start_cursor: startCursor
      });

      for (const page of response.results.filter((r) => r.object === "page")) {
        const p = page as any;
        const text = (prop: string) => {
          const val = p.properties[prop];
          if (val?.type === "rich_text") return val.rich_text.map((t: { plain_text: string }) => t.plain_text).join("");
          if (val?.type === "title") return val.title.map((t: { plain_text: string }) => t.plain_text).join("");
          return "";
        };

        let voiceSummary = text("Voice summary");
        let preferredPatterns = text("Preferred patterns");
        let avoid = text("Avoid");
        let source: "properties" | "body" = "properties";

        const propertiesEmpty = !voiceSummary && !preferredPatterns && !avoid;
        if (propertiesEmpty) {
          const sections = await this.readPageBodySections(p.id);
          const parsed = parseToneBodySections(sections);
          voiceSummary = parsed.voiceSummary;
          preferredPatterns = parsed.preferredPatterns;
          avoid = parsed.avoid;
          source = "body";
        }

        results.push({
          pageId: p.id,
          profileName: text("Profile"),
          voiceSummary,
          preferredPatterns,
          avoid,
          source
        });
      }

      startCursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (startCursor);

    return results;
  }

  async listSelectedOpportunities(): Promise<NotionSelectionRow[]> {
    if (!this.client) return [];
    const databaseId = await this.ensureDatabase("Content Opportunities");
    const rows: NotionSelectionRow[] = [];
    let startCursor: string | undefined;

    do {
      const response = await this.client.databases.query({
        database_id: databaseId,
        start_cursor: startCursor,
        filter: {
          property: "Status",
          select: {
            equals: "Ready for V1"
          }
        }
      });

      for (const page of response.results.filter((result) => result.object === "page")) {
        const typedPage = page as any;
        const fingerprintValue = typedPage.properties["Opportunity fingerprint"];
        const editorialOwnerValue = typedPage.properties["Editorial owner"];
        const fingerprint =
          fingerprintValue?.type === "rich_text"
            ? fingerprintValue.rich_text.map((entry: { plain_text: string }) => entry.plain_text).join("")
            : "";
        const editorialOwner =
          editorialOwnerValue?.type === "rich_text"
            ? editorialOwnerValue.rich_text.map((entry: { plain_text: string }) => entry.plain_text).join("")
            : "";
        const row = notionSelectionRowSchema.parse({
          notionPageId: typedPage.id,
          fingerprint,
          editorialOwner
        });
        rows.push(row);
      }

      startCursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (startCursor);

    return rows;
  }

  private async upsertDatabasePage(params: {
    databaseName: RequiredDatabase;
    notionPageId?: string;
    fingerprintProperty: string;
    fingerprint: string;
    properties: Record<string, unknown>;
    createOnlyProperties?: Record<string, unknown>;
  }): Promise<NotionSyncResult | null> {
    if (!this.client) {
      return null;
    }
    let knownPageId = params.notionPageId;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const databaseId = await this.ensureDatabase(params.databaseName);

      try {
        if (knownPageId) {
          try {
            await this.client.pages.update({
              page_id: knownPageId,
              properties: params.properties as any
            });
            return {
              notionPageId: knownPageId,
              action: "updated"
            };
          } catch (error) {
            if (!isNotionObjectNotFoundError(error)) {
              throw error;
            }

            this.emitWarning(`Stale Notion page reference detected for ${params.databaseName}; recreating the page.`);
            knownPageId = undefined;
          }
        }

        const existing = await this.findPageByFingerprint(databaseId, params.fingerprintProperty, params.fingerprint);
        if (existing) {
          await this.client.pages.update({
            page_id: existing,
            properties: params.properties as any
          });
          return {
            notionPageId: existing,
            action: "updated"
          };
        }

        const allCreateProperties = params.createOnlyProperties
          ? { ...params.properties, ...params.createOnlyProperties }
          : params.properties;
        const created = await this.client.pages.create({
          parent: { database_id: databaseId },
          properties: allCreateProperties as any
        });
        return {
          notionPageId: created.id,
          action: "created"
        };
      } catch (error) {
        if (attempt === 0 && isNotionDatabaseNotFoundError(error)) {
          await this.clearBinding(params.databaseName, `Stale Notion database binding recovered for ${params.databaseName}.`);
          knownPageId = undefined;
          continue;
        }

        throw error;
      }
    }

    throw new Error(`Notion upsert failed for database ${params.databaseName}.`);
  }

  private async findPageByFingerprint(databaseId: string, propertyName: string, fingerprint: string) {
    if (!this.client) {
      return null;
    }

    const response = await this.client.databases.query({
      database_id: databaseId,
      filter: {
        property: propertyName,
        rich_text: {
          equals: fingerprint
        }
      }
    } as any);

    const page = response.results.find((result) => result.object === "page");
    return page?.id ?? null;
  }

  private async findPageByFingerprintWithProperties(databaseId: string, propertyName: string, fingerprint: string) {
    if (!this.client) {
      return null;
    }

    const response = await this.client.databases.query({
      database_id: databaseId,
      filter: {
        property: propertyName,
        rich_text: {
          equals: fingerprint
        }
      }
    } as any);

    return response.results.find((result) => result.object === "page") ?? null;
  }

  private async retrievePage(pageId: string) {
    if (!this.client) {
      return null;
    }

    try {
      return await this.client.pages.retrieve({ page_id: pageId });
    } catch (error) {
      if (isNotionObjectNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async ensureDatabase(name: RequiredDatabase) {
    if (!this.client) {
      return "";
    }

    const cached = this.databaseCache.get(name);
    if (cached) {
      if (!this.schemaPatchedCache.has(cached)) {
        await this.patchDatabaseProperties(cached, name);
        this.schemaPatchedCache.add(cached);
      }
      return cached;
    }

    const bound = this.bindings ? await this.bindings.getNotionDatabaseBinding(this.parentPageId, name) : null;
    if (bound?.databaseId) {
      const state = await this.verifyDatabaseBinding(name, bound.databaseId);
      if (state === "valid") {
        this.databaseCache.set(name, bound.databaseId);
        if (!this.schemaPatchedCache.has(bound.databaseId)) {
          await this.patchDatabaseProperties(bound.databaseId, name);
          this.schemaPatchedCache.add(bound.databaseId);
        }
        return bound.databaseId;
      }
      if (state === "stale") {
        await this.clearBinding(name, `Stale Notion database binding recovered for ${name}.`);
      }
    }

    const matches = await this.findDatabasesUnderParent(name);
    if (matches.length > 1) {
      throw new Error(`Multiple Notion databases named "${name}" were found under the configured parent page.`);
    }

    if (matches.length === 1) {
      const existing = matches[0];
      this.databaseCache.set(name, existing.id);
      await this.bindings?.upsertNotionDatabaseBinding(this.parentPageId, name, existing.id);
      if (!this.schemaPatchedCache.has(existing.id)) {
        await this.patchDatabaseProperties(existing.id, name);
        this.schemaPatchedCache.add(existing.id);
      }
      return existing.id;
    }

    const created = await this.client.databases.create({
      parent: { type: "page_id", page_id: this.parentPageId },
      title: [
        {
          type: "text",
          text: { content: name }
        }
      ],
      properties: getDatabaseProperties(name) as any
    });

    this.databaseCache.set(name, created.id);
    this.schemaPatchedCache.add(created.id);
    await this.bindings?.upsertNotionDatabaseBinding(this.parentPageId, name, created.id);
    return created.id;
  }

  private async patchDatabaseProperties(databaseId: string, name: RequiredDatabase) {
    if (!this.client) return;
    const expected = getDatabaseProperties(name);
    const current = await this.client.databases.retrieve({ database_id: databaseId });
    const currentProps = (current as any).properties ?? {};
    const missing: Record<string, unknown> = {};
    for (const [key, definition] of Object.entries(expected)) {
      if (!currentProps[key]) {
        missing[key] = definition;
      }
    }
    if (Object.keys(missing).length > 0) {
      await this.client.databases.update({
        database_id: databaseId,
        properties: missing as any
      });
    }
  }

  private async ensureOperationsGuide() {
    if (!this.client) return;
    const title = "Editorial Signal Engine Operations Guide";
    const response = await this.client.search({
      query: title,
      filter: {
        value: "page",
        property: "object"
      }
    });
    if (response.results.some((result) => result.object === "page" && isUnderParentPage(result, this.parentPageId))) {
      return;
    }

    try {
      await this.client.pages.create({
        parent: { page_id: this.parentPageId },
        properties: {
          title: titleProperty(title)
        },
        children: manualReviewViewSpecs().map((spec) => ({
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: `${spec.name}: ${spec.description}`
                }
              }
            ]
          }
        }))
      });
    } catch (error) {
      if (isNotionObjectNotFoundError(error)) {
        this.emitWarning("Skipping Operations Guide creation because the configured Notion parent cannot accept child pages.");
        return;
      }
      throw error;
    }
  }

  private async verifyDatabaseBinding(name: RequiredDatabase, databaseId: string) {
    if (!this.client) {
      return "stale" as const;
    }

    try {
      const result = await this.client.databases.retrieve({
        database_id: databaseId
      });
      return isExactDatabaseName(result, name) && isUnderParentPage(result, this.parentPageId) ? ("valid" as const) : ("stale" as const);
    } catch (error) {
      if (isNotionDatabaseNotFoundError(error)) {
        return "stale" as const;
      }
      throw error;
    }
  }

  private async findDatabasesUnderParent(name: RequiredDatabase) {
    if (!this.client) {
      return [];
    }

    const response = await this.client.search({
      query: name,
      filter: {
        value: "database",
        property: "object"
      }
    });

    return response.results.filter((result) => isExactDatabaseName(result, name) && isUnderParentPage(result, this.parentPageId));
  }

  private async clearBinding(name: RequiredDatabase, warning: string) {
    this.databaseCache.delete(name);
    await this.bindings?.clearNotionDatabaseBinding(this.parentPageId, name);
    this.emitWarning(warning);
  }

  async readPageBodySections(pageId: string): Promise<Map<string, string>> {
    if (!this.client) return new Map();

    const sections = new Map<string, string>();
    let currentHeading = "";

    const collectBlocks = async (blockId: string, depth: number) => {
      let startCursor: string | undefined;

      do {
        const response = await this.client!.blocks.children.list({
          block_id: blockId,
          page_size: 100,
          start_cursor: startCursor
        });

        for (const block of response.results) {
          if (!("type" in block)) continue;
          const b = block as any;
          const type: string = b.type;

          const richText = b[type]?.rich_text;
          const text = Array.isArray(richText)
            ? richText.map((t: { plain_text: string }) => t.plain_text ?? "").join("").trim()
            : "";

          if (type.startsWith("heading_")) {
            currentHeading = text.toLowerCase();
            if (currentHeading && !sections.has(currentHeading)) {
              sections.set(currentHeading, "");
            }
          } else if (text) {
            const existing = sections.get(currentHeading) ?? "";
            sections.set(currentHeading, existing ? `${existing}\n${text}` : text);
          }

          if (b.has_children && depth < 2) {
            await collectBlocks(b.id, depth + 1);
          }
        }

        startCursor = response.has_more ? response.next_cursor ?? undefined : undefined;
      } while (startCursor);
    };

    await collectBlocks(pageId, 0);
    return sections;
  }

  private emitWarning(warning: string) {
    this.warningSink?.(warning);
  }
}

export function manualReviewViewSpecs() {
  return [
    { name: "Content Opportunities / To review", description: "Filter where Status = To review" },
    { name: "Content Opportunities / Picked", description: "Filter where Status = Selected" },
    { name: "Content Opportunities / Draft ready", description: "Filter where Status = V1 generated" },
    { name: "Content Opportunities / Rejected or Archived", description: "Filter where Status = Rejected or Archived" },
    { name: "Claap Review / Needs review", description: "Filter where Decision is empty" },
    { name: "Claap Review / Needs rewrite", description: "Filter where Decision = needs rewrite" },
    { name: "Claap Review / Rejected", description: "Filter where Decision = reject" },
    { name: "Claap Review / Approved", description: "Filter where Decision = approve" },
    { name: "Linear Review / Needs review", description: "Filter where Decision is empty" },
    { name: "Linear Review / Approved", description: "Filter where Decision = approve" },
    { name: "Linear Review / Rejected", description: "Filter where Decision = reject" },
    { name: "Sync Runs / Recent", description: "Sort by Started at descending" }
  ];
}

function getDatabaseProperties(name: RequiredDatabase) {
  switch (name) {
    case "Content Opportunities":
      return {
        Title: { title: {} },
        "Owner profile": { rich_text: {} },
        "Narrative pillar": { rich_text: {} },
        Angle: { rich_text: {} },
        "Why now": { rich_text: {} },
        "What it is about": { rich_text: {} },
        "What it is not about": { rich_text: {} },
        "Source of origin": { rich_text: {} },
        "Source URL": { rich_text: {} },
        "Provenance type": { rich_text: {} },
        "Draft readiness": { select: {} },
        "What's missing": { rich_text: {} },
        "Reframing note": { rich_text: {} },
        "Evidence count": { number: { format: "number" } },
        "Suggested format": { rich_text: {} },
        "Hook suggestion 1": { rich_text: {} },
        "Hook suggestion 2": { rich_text: {} },
        "Format rationale": { rich_text: {} },
        "V1 draft": { rich_text: {} },
        Status: { select: {} },
        "Editorial notes": { rich_text: {} },
        "Primary evidence": { rich_text: {} },
        "Supporting evidence count": { number: { format: "number" } },
        "Evidence freshness": { number: { format: "number" } },
        "Evidence excerpts": { rich_text: {} },
        "Enrichment log": { rich_text: {} },
        "Editorial owner": { rich_text: {} },
        "Selected at": { date: {} },
        "Last digest at": { date: {} },
        "Opportunity fingerprint": { rich_text: {} }
      };
    case "Claap Review":
      return {
        "Signal title": { title: {} },
        "Publishability risk": { select: {} },
        "Original signal summary": { rich_text: {} },
        "Key excerpts": { rich_text: {} },
        "Why blocked": { rich_text: {} },
        "Reframing suggestion": { rich_text: {} },
        "Transcript link": { url: {} },
        Decision: { select: {} },
        "Occurred at": { date: {} },
        "Review fingerprint": { rich_text: {} },
        "Claap source item id": { rich_text: {} }
      };
    case "Linear Review":
      return {
        "Item title": { title: {} },
        Classification: { select: {} },
        Rationale: { rich_text: {} },
        "Customer visibility": { select: {} },
        "Sensitivity level": { select: {} },
        "Evidence strength": { number: { format: "number" } },
        "Review note": { rich_text: {} },
        "Linear link": { url: {} },
        "Item type": { rich_text: {} },
        State: { rich_text: {} },
        Team: { rich_text: {} },
        Priority: { number: { format: "number" } },
        Labels: { rich_text: {} },
        "Occurred at": { date: {} },
        Decision: { select: {} },
        "Review fingerprint": { rich_text: {} },
        "Linear source item id": { rich_text: {} }
      };
    case "Profiles":
      return {
        "Profile name": { title: {} },
        Role: { rich_text: {} },
        "Language preference": { rich_text: {} },
        "Tone summary": { rich_text: {} },
        "Preferred structure": { rich_text: {} },
        "Typical phrases": { rich_text: {} },
        "Avoid rules": { rich_text: {} },
        "Content territories": { rich_text: {} },
        "Weak-fit territories": { rich_text: {} },
        "Sample excerpts": { rich_text: {} },
        "Last refreshed": { date: {} },
        "Profile fingerprint": { rich_text: {} }
      };
    case "Sync Runs":
      return {
        "Run date": { title: {} },
        Source: { rich_text: {} },
        Status: { select: {} },
        "Items fetched": { number: { format: "number" } },
        "Items processed": { number: { format: "number" } },
        Errors: { rich_text: {} },
        Notes: { rich_text: {} },
        "Run type": { rich_text: {} },
        "Started at": { date: {} },
        "Finished at": { date: {} },
        "Step-level counts": { rich_text: {} },
        "Warning flags": { rich_text: {} },
        "Token and cost totals": { rich_text: {} },
        "Run fingerprint": { rich_text: {} }
      };
  }
}

export function mapReadinessTierToSelect(tier?: string): string {
  switch (tier) {
    case "ready": return "Ready to draft";
    case "promising": return "Promising — needs help";
    default: return "Needs more proof";
  }
}

export type ToneSectionField = "voiceSummary" | "preferredPatterns" | "avoid";

export function classifyToneSection(heading: string): ToneSectionField | null {
  const h = heading.toLowerCase();
  if (!h) return null;

  // Avoid bucket — check first (most specific patterns)
  if (/anti[- ]?mod[eè]le|ne\s+(dit|faut)\s+(jamais|pas)|ne\s+faut\s+pas|r[eè]gles|[àa]\s+[ée]viter|avoid/.test(h)) return "avoid";

  // Preferred patterns bucket
  if (/structur|lexique|adaptation|format|conversion|oral.*[ée]crit|preferred|pattern/.test(h)) return "preferredPatterns";

  // Voice summary bucket
  if (/qui\s+est|voix|d[eé]finit|voice|summary|tone\b|profil/.test(h)) return "voiceSummary";

  return null;
}

export function normalizeToneText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-•*]\s+/, ""))
    .map((line) => line.replace(/ {2,}/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseToneBodySections(sections: Map<string, string>): {
  voiceSummary: string;
  preferredPatterns: string;
  avoid: string;
} {
  const buckets: Record<ToneSectionField, string[]> = {
    voiceSummary: [],
    preferredPatterns: [],
    avoid: []
  };

  for (const [heading, content] of sections) {
    const field = classifyToneSection(heading);
    if (field && content.trim()) {
      buckets[field].push(content);
    }
  }

  return {
    voiceSummary: normalizeToneText(buckets.voiceSummary.join("\n\n")),
    preferredPatterns: normalizeToneText(buckets.preferredPatterns.join("\n\n")),
    avoid: normalizeToneText(buckets.avoid.join("\n\n"))
  };
}

function formatOperatorGuidance(guidance: string[]): string {
  if (guidance.length === 0) return "";
  return guidance.map((g) => `• ${g}`).join("\n");
}

function formatEnrichmentLog(entries: EnrichmentLogEntry[]): string {
  if (!entries || entries.length === 0) return "";
  const display = entries.slice(-5);
  const prefix = entries.length > 5 ? `[${entries.length - 5} earlier entries]\n` : "";
  const lines = display.map((entry) => {
    const date = entry.createdAt.slice(0, 10);
    const evidenceCount = entry.evidenceIds.length;
    return `[${date}] +${evidenceCount} evidence, confidence ${entry.confidence}: "${entry.contextComment}"`;
  });
  return prefix + lines.join("\n");
}

function titleProperty(value: string) {
  const chunks = chunkText(value, 1);
  return {
    title: chunks.map((chunk) => ({
      text: {
        content: chunk
      }
    }))
  };
}

function richTextProperty(value: string) {
  const chunks = chunkText(value, 10);
  return {
    rich_text: chunks.map((chunk) => ({
      text: {
        content: chunk
      }
    }))
  };
}

function chunkText(value: string, maxChunks: number) {
  if (!value) {
    return [""];
  }

  const chunks: string[] = [];
  for (let index = 0; index < value.length && chunks.length < maxChunks; index += 1900) {
    chunks.push(value.slice(index, index + 1900));
  }

  if (value.length > maxChunks * 1900 && chunks.length > 0) {
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1].slice(0, 1888)}[truncated]`;
  }

  return chunks;
}

function dateProperty(value: string) {
  return {
    date: {
      start: value
    }
  };
}

function emptyDateProperty() {
  return {
    date: null
  };
}

function isExactDatabaseName(result: unknown, name: RequiredDatabase) {
  if (!result || typeof result !== "object" || (result as { object?: string }).object !== "database") {
    return false;
  }

  const typedResult = result as { title?: Array<{ plain_text?: string }> };
  const title = typedResult.title?.map((entry) => entry.plain_text ?? "").join("") ?? "";
  return title === name;
}

function isUnderParentPage(result: unknown, parentPageId: string) {
  if (!result || typeof result !== "object") {
    return false;
  }

  const parent = (result as { parent?: { type?: string; page_id?: string } }).parent;
  return parent?.type === "page_id" && normalizeNotionId(parent.page_id ?? "") === normalizeNotionId(parentPageId);
}

function normalizeNotionId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  const hyphenatedMatch = trimmed.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (hyphenatedMatch) {
    return hyphenatedMatch[0].toLowerCase();
  }

  const compactMatch = trimmed.match(/([0-9a-fA-F]{32})(?:\b|$)/);
  if (!compactMatch) {
    return trimmed;
  }

  const compact = compactMatch[1].toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function isNotionObjectNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const typedError = error as {
    status?: number;
    code?: string;
    body?: string;
    message?: string;
  };
  const status = typedError.status;
  const code = typedError.code;
  const details = `${typedError.message ?? ""} ${typedError.body ?? ""}`.toLowerCase();
  return code === "object_not_found" || status === 404 || (status === 400 && details.includes("not found"));
}

function isNotionDatabaseNotFoundError(error: unknown) {
  if (!isNotionObjectNotFoundError(error)) {
    return false;
  }

  const typedError = error as {
    body?: string;
    message?: string;
  };
  const details = `${typedError.message ?? ""} ${typedError.body ?? ""}`.toLowerCase();
  return details.length === 0 || details.includes("database") || details.includes("object not found");
}

function selectProperty(value: string) {
  return {
    select: {
      name: value.slice(0, 100)
    }
  };
}

function emptySelectProperty() {
  return {
    select: null
  };
}

function numberProperty(value: number) {
  return { number: value };
}

function urlProperty(value: string) {
  return {
    url: value || null
  };
}

function compactProperties(properties: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined)
  );
}

function getPageProperties(page: unknown) {
  if (!page || typeof page !== "object") return {};
  return ((page as { properties?: Record<string, unknown> }).properties ?? {});
}

function getPageId(page: unknown) {
  if (!page || typeof page !== "object") return "";
  return String((page as { id?: string }).id ?? "");
}

function getRichTextPropertyText(page: unknown, propertyName: string) {
  const value = getPageProperties(page)[propertyName] as { type?: string; rich_text?: Array<{ plain_text?: string }> } | undefined;
  if (value?.type !== "rich_text") return "";
  return value.rich_text?.map((entry) => entry.plain_text ?? "").join("") ?? "";
}

function getTitlePropertyText(page: unknown, propertyName: string) {
  const value = getPageProperties(page)[propertyName] as { type?: string; title?: Array<{ plain_text?: string }> } | undefined;
  if (value?.type !== "title") return "";
  return value.title?.map((entry) => entry.plain_text ?? "").join("") ?? "";
}

function getSelectPropertyName(page: unknown, propertyName: string) {
  const value = getPageProperties(page)[propertyName] as { type?: string; select?: { name?: string | null } | null } | undefined;
  if (value?.type !== "select") return "";
  return value.select?.name ?? "";
}
