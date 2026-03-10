import path from "node:path";
import { promises as fs } from "node:fs";

import matter from "gray-matter";

import type {
  MarketFindingsSourceConfig,
  NormalizedSourceItem,
  RawSourceItem,
  RunContext
} from "../domain/types.js";
import { listFilesRecursive } from "../lib/fs.js";
import { hashParts, hashText } from "../lib/ids.js";
import { BaseConnector } from "./base.js";

export class MarketFindingsConnector extends BaseConnector<MarketFindingsSourceConfig> {
  readonly source = "market-findings" as const;

  override async fetchSince(cursor: string | null, config: MarketFindingsSourceConfig, _context: RunContext): Promise<RawSourceItem[]> {
    if (!config.enabled) {
      return [];
    }

    const files = (await listFilesRecursive(path.resolve(config.directory))).filter((file) => file.endsWith(".md"));
    const items = await Promise.all(
      files.map(async (file) => {
        const contents = await fs.readFile(file, "utf8");
        const parsed = matter(contents);
        const stats = await fs.stat(file);
        const fileFingerprint = hashText(contents);
        const fileCursor = `${stats.mtime.toISOString()}:${fileFingerprint}`;
        if (cursor && fileCursor <= cursor) {
          return null;
        }

        return {
          id: parsed.data.id ?? path.basename(file, ".md"),
          cursor: fileCursor,
          payload: {
            filePath: file,
            frontmatter: parsed.data,
            body: parsed.content,
            fileFingerprint,
            fileModifiedAt: stats.mtime.toISOString()
          }
        } satisfies RawSourceItem;
      })
    );

    return items.filter(Boolean) as RawSourceItem[];
  }

  override async normalize(rawItem: RawSourceItem, config: MarketFindingsSourceConfig, context: RunContext): Promise<NormalizedSourceItem> {
    const payload = rawItem.payload as {
      filePath?: string;
      frontmatter?: Record<string, unknown>;
      body?: string;
      fileFingerprint?: string;
      fileModifiedAt?: string;
    };
    const body = payload.body ?? "";
    const sourceItemId = rawItem.id;
    return {
      source: "market-findings",
      sourceItemId,
      externalId: `market-findings:${sourceItemId}`,
      sourceFingerprint: hashParts(["market-findings", sourceItemId, payload.fileFingerprint ?? "", body]),
      sourceUrl: payload.filePath ?? "",
      title: String(payload.frontmatter?.finding ?? payload.frontmatter?.title ?? rawItem.id),
      text: body,
      summary: body.slice(0, 200),
      occurredAt: String(payload.frontmatter?.updatedAt ?? payload.fileModifiedAt ?? context.now.toISOString()),
      ingestedAt: context.now.toISOString(),
      metadata: {
        ...(payload.frontmatter ?? {}),
        fileFingerprint: payload.fileFingerprint
      },
      rawPayload: rawItem.payload,
      rawText: config.storeRawText ? body : null
    };
  }

  override async backfill(_range: { from: Date; to: Date }, config: MarketFindingsSourceConfig, context: RunContext): Promise<RawSourceItem[]> {
    return this.fetchSince(null, config, context);
  }
}
