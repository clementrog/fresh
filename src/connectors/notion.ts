import { Client } from "@notionhq/client";

import type { AppEnv } from "../config/env.js";
import type {
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
    const title = extractNotionTitle(page.properties ?? {}) || `Notion page ${page.id}`;
    const content = await this.fetchPageContent(page.id, config);
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
        properties: page.properties,
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
