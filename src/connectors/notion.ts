import { Client } from "@notionhq/client";

import type { AppEnv } from "../config/env.js";
import type {
  ProfileId,
  NormalizedSourceItem,
  NotionSourceConfig,
  RawSourceItem,
  RunContext
} from "../domain/types.js";
import { hashParts } from "../lib/ids.js";
import { BaseConnector } from "./base.js";

export class NotionConnector extends BaseConnector<NotionSourceConfig> {
  readonly source = "notion" as const;

  constructor(private readonly env: AppEnv) {
    super();
  }

  override async fetchSince(cursor: string | null, config: NotionSourceConfig, _context: RunContext): Promise<RawSourceItem[]> {
    if (!config.enabled || !this.env.NOTION_TOKEN) {
      return [];
    }

    const client = new Client({ auth: this.env.NOTION_TOKEN });
    const items: RawSourceItem[] = [];

    for (const databaseId of config.databaseAllowlist) {
      let startCursor: string | undefined;
      do {
        const response = await this.executeWithRateLimit(config, () =>
          client.databases.query({
            database_id: databaseId,
            page_size: 100,
            start_cursor: startCursor
          })
        );

        for (const page of response.results) {
          if (page.object !== "page" || !("last_edited_time" in page)) {
            continue;
          }
          if (cursor && page.last_edited_time <= cursor) {
            continue;
          }
          items.push({
            id: page.id,
            cursor: page.last_edited_time,
            payload: {
              page,
              sourceType: "database",
              parentDatabaseId: databaseId
            }
          });
        }

        startCursor = response.has_more ? response.next_cursor ?? undefined : undefined;
      } while (startCursor);
    }

    for (const pageId of config.pageAllowlist) {
      const page = await this.executeWithRateLimit(config, () => client.pages.retrieve({ page_id: pageId }));
      if (!("last_edited_time" in page)) {
        continue;
      }
      if (cursor && page.last_edited_time <= cursor) {
        continue;
      }
      items.push({
        id: page.id,
        cursor: page.last_edited_time,
        payload: {
          page,
          sourceType: "page"
        }
      });
    }

    return items.filter((item) => {
      const page = item.payload.page as { parent?: { database_id?: string } };
      const parentDatabaseId = page.parent?.database_id;
      return !config.excludedDatabaseNames.includes(parentDatabaseId ?? "");
    });
  }

  override async normalize(rawItem: RawSourceItem, config: NotionSourceConfig, context: RunContext): Promise<NormalizedSourceItem> {
    const page = rawItem.payload.page as {
      id: string;
      url?: string;
      last_edited_time?: string;
      properties?: Record<string, unknown>;
    };
    const properties = page.properties ?? {};
    const marketInsightFromProperties = extractMarketInsight(properties, "");
    if (marketInsightFromProperties && !config.storeRawText) {
      return this.buildMarketInsightSourceItem(page, rawItem, config, context, marketInsightFromProperties, "");
    }

    const content = await this.fetchPageContent(page.id, config);
    const marketInsight = extractMarketInsight(properties, content);
    if (marketInsight) {
      return this.buildMarketInsightSourceItem(page, rawItem, config, context, marketInsight, content);
    }

    const title = extractNotionTitle(properties) || `Notion page ${page.id}`;
    const text = content || title;
    const sourceItemId = page.id;
    return {
      source: "notion",
      sourceItemId,
      externalId: `notion:${sourceItemId}`,
      sourceFingerprint: hashParts(["notion", sourceItemId, page.last_edited_time ?? "", text]),
      sourceUrl: page.url ?? "",
      title,
      text,
      summary: text.slice(0, 300),
      occurredAt: page.last_edited_time ?? context.now.toISOString(),
      ingestedAt: context.now.toISOString(),
      metadata: {
        sourceType: rawItem.payload.sourceType,
        parentDatabaseId: rawItem.payload.parentDatabaseId,
        properties,
        storeRawText: config.storeRawText
      },
      rawPayload: rawItem.payload,
      rawText: config.storeRawText ? text : null
    };
  }

  override async backfill(_range: { from: Date; to: Date }, config: NotionSourceConfig, context: RunContext): Promise<RawSourceItem[]> {
    return this.fetchSince(null, config, context);
  }

  private async fetchPageContent(blockId: string, config: NotionSourceConfig) {
    if (!this.env.NOTION_TOKEN) {
      return "";
    }

    const client = new Client({ auth: this.env.NOTION_TOKEN });
    const lines: string[] = [];
    let startCursor: string | undefined;

    do {
      const response = await this.executeWithRateLimit(config, () =>
        client.blocks.children.list({
          block_id: blockId,
          page_size: 100,
          start_cursor: startCursor
        })
      );

      for (const block of response.results) {
        if (!("type" in block)) {
          continue;
        }
        const line = extractBlockText(block as Record<string, unknown>);
        if (line) {
          lines.push(line);
        }
      }

      startCursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (startCursor && lines.join("\n").length < 6000);

    return lines.join("\n").slice(0, 6000);
  }

  private buildMarketInsightSourceItem(
    page: {
      id: string;
      url?: string;
      properties?: Record<string, unknown>;
    },
    rawItem: RawSourceItem,
    config: NotionSourceConfig,
    context: RunContext,
    marketInsight: ReturnType<typeof extractMarketInsight>,
    content: string
  ): NormalizedSourceItem {
    if (!marketInsight) {
      throw new Error("Expected structured market insight payload");
    }

    const sourceItemId = page.id;
    return {
      source: "notion",
      sourceItemId,
      externalId: `notion:${sourceItemId}`,
      sourceFingerprint: hashParts([
        "notion",
        "market-insight",
        sourceItemId,
        marketInsight.title,
        marketInsight.theme,
        marketInsight.occurredAt,
        marketInsight.text
      ]),
      sourceUrl: marketInsight.sourceUrl || page.url || "",
      title: marketInsight.title,
      text: marketInsight.text,
      summary: marketInsight.summary,
      occurredAt: marketInsight.occurredAt,
      ingestedAt: context.now.toISOString(),
      metadata: {
        sourceType: rawItem.payload.sourceType,
        parentDatabaseId: rawItem.payload.parentDatabaseId,
        properties: page.properties ?? {},
        storeRawText: config.storeRawText,
        notionKind: "market-insight",
        theme: marketInsight.theme,
        sourceTypeLabel: marketInsight.sourceType,
        profileHint: marketInsight.profileHint
      },
      rawPayload: rawItem.payload,
      rawText: config.storeRawText ? marketInsight.text : null,
      chunks: marketInsight.chunks
    };
  }
}

function extractNotionTitle(properties: Record<string, unknown>) {
  for (const value of Object.values(properties)) {
    const property = value as { type?: string; title?: Array<{ plain_text?: string }> };
    if (property.type === "title") {
      return (property.title ?? []).map((item) => item.plain_text ?? "").join("").trim();
    }
  }

  return "";
}

function extractBlockText(block: Record<string, unknown>) {
  const type = block.type;
  if (typeof type !== "string") {
    return "";
  }

  const blockValue = block[type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  const text = (blockValue?.rich_text ?? []).map((entry) => entry.plain_text ?? "").join("").trim();
  if (text) {
    return text;
  }

  if (type === "bulleted_list_item" || type === "numbered_list_item") {
    return text;
  }

  return "";
}

function extractMarketInsight(properties: Record<string, unknown>, content: string) {
  const insightTitle = extractTitleProperty(properties, "Insight");
  const theme = extractSelectProperty(properties, "Theme") || "General";
  const sourceType = extractSelectProperty(properties, "Source type");
  const sourceUrl = extractUrlProperty(properties, "Source URL");
  const occurredAt = extractDateProperty(properties, "Timestamp");

  if (!insightTitle) {
    return null;
  }

  const summary = [
    `Theme: ${theme}.`,
    sourceType ? `Source type: ${sourceType}.` : "",
    content ? truncateContent(content, 220) : "Structured market insight captured in Notion."
  ]
    .filter(Boolean)
    .join(" ");

  const chunks = [
    insightTitle,
    `Theme: ${theme}`,
    sourceType ? `Source type: ${sourceType}` : "",
    content
  ]
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => entry.trim());

  const text = [
    insightTitle,
    theme ? `Theme: ${theme}` : "",
    sourceType ? `Source type: ${sourceType}` : "",
    sourceUrl ? `Source URL: ${sourceUrl}` : "",
    content
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    title: insightTitle,
    theme,
    sourceType,
    sourceUrl,
    occurredAt,
    summary,
    text,
    chunks,
    profileHint: inferMarketInsightProfileHint(theme, `${insightTitle}\n${content}`)
  };
}

function extractTitleProperty(properties: Record<string, unknown>, propertyName: string) {
  const property = properties[propertyName] as { type?: string; title?: Array<{ plain_text?: string }> } | undefined;
  if (property?.type !== "title") {
    return "";
  }
  return (property.title ?? []).map((item) => item.plain_text ?? "").join("").trim();
}

function extractSelectProperty(properties: Record<string, unknown>, propertyName: string) {
  const property = properties[propertyName] as { type?: string; select?: { name?: string | null } | null } | undefined;
  if (property?.type !== "select") {
    return "";
  }
  return property.select?.name?.trim() ?? "";
}

function extractUrlProperty(properties: Record<string, unknown>, propertyName: string) {
  const property = properties[propertyName] as { type?: string; url?: string | null } | undefined;
  if (property?.type !== "url") {
    return "";
  }
  return property.url?.trim() ?? "";
}

function extractDateProperty(properties: Record<string, unknown>, propertyName: string) {
  const property = properties[propertyName] as { type?: string; date?: { start?: string | null } | null } | undefined;
  if (property?.type !== "date") {
    return "";
  }
  return property.date?.start?.trim() ?? "";
}

function truncateContent(content: string, maxLength: number) {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength - 3)}...`;
}

function inferMarketInsightProfileHint(theme: string, text: string): ProfileId | undefined {
  const haystack = `${theme}\n${text}`.toLowerCase();

  if (/\b(strategy|strategic|market|vision|mobilisation|2026)\b/.test(haystack)) {
    return "baptiste";
  }

  if (/\b(dsn|case law|pay transparency|payroll|cost of work|compliance|fiabilité|réglement|reglement)\b/.test(haystack)) {
    return "thomas";
  }

  if (/\b(objection|buyer|commercial|sales|adoption)\b/.test(haystack)) {
    return "quentin";
  }

  if (/\b(genai|ai|produit|product|feedback|usage|ux)\b/.test(haystack)) {
    return "virginie";
  }

  return "linc-corporate";
}
