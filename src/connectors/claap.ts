import type { AppEnv } from "../config/env.js";
import type {
  ClaapSourceConfig,
  NormalizedSourceItem,
  RawSourceItem,
  RunContext
} from "../domain/types.js";
import { hashParts } from "../lib/ids.js";
import { BaseConnector } from "./base.js";

export class ClaapConnector extends BaseConnector<ClaapSourceConfig> {
  readonly source = "claap" as const;

  constructor(private readonly env: AppEnv) {
    super();
  }

  override async fetchSince(cursor: string | null, config: ClaapSourceConfig, _context: RunContext): Promise<RawSourceItem[]> {
    if (!config.enabled || !this.env.CLAAP_API_KEY) {
      return [];
    }

    const items: RawSourceItem[] = [];

    for (const workspaceId of config.workspaceIds) {
      const response = await this.executeWithRateLimit(config, () =>
        fetch(`https://api.claap.io/v2/workspaces/${workspaceId}/recordings`, {
          headers: {
            Authorization: `Bearer ${this.env.CLAAP_API_KEY}`
          }
        })
      );

      if (!response.ok) {
        continue;
      }

      const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
      for (const recording of body.data ?? []) {
        const updatedAt = String(recording.updatedAt ?? recording.createdAt ?? "");
        if (cursor && updatedAt <= cursor) {
          continue;
        }

        if (config.folderIds.length > 0 && !config.folderIds.includes(String(recording.folderId ?? ""))) {
          continue;
        }

        items.push({
          id: String(recording.id),
          cursor: updatedAt,
          payload: recording
        });
      }
    }

    return items;
  }

  override async normalize(rawItem: RawSourceItem, config: ClaapSourceConfig, context: RunContext): Promise<NormalizedSourceItem> {
    const payload = rawItem.payload as {
      id?: string;
      title?: string;
      transcript?: string;
      summary?: string;
      url?: string;
      updatedAt?: string;
      createdAt?: string;
      speaker?: string;
    };
    const transcript = payload.transcript ?? "";
    const sourceItemId = String(payload.id ?? rawItem.id);
    return {
      source: "claap",
      sourceItemId,
      externalId: `claap:${sourceItemId}`,
      sourceFingerprint: hashParts(["claap", sourceItemId, payload.updatedAt ?? payload.createdAt ?? "", transcript]),
      sourceUrl: payload.url ?? "",
      title: payload.title ?? `Claap recording ${rawItem.id}`,
      text: transcript,
      summary: payload.summary ?? transcript.slice(0, 200),
      speakerName: payload.speaker,
      occurredAt: payload.updatedAt ?? payload.createdAt ?? context.now.toISOString(),
      ingestedAt: context.now.toISOString(),
      metadata: {
        storeRawText: config.storeRawText
      },
      rawPayload: rawItem.payload,
      rawText: config.storeRawText ? transcript : null,
      chunks: chunkTranscript(transcript)
    };
  }

  override async backfill(range: { from: Date; to: Date }, config: ClaapSourceConfig, context: RunContext): Promise<RawSourceItem[]> {
    return this.fetchSince(range.from.toISOString(), config, {
      dryRun: false,
      now: context.now
    });
  }
}

function chunkTranscript(transcript: string) {
  if (!transcript.trim()) {
    return [];
  }

  const size = 500;
  const chunks: string[] = [];
  for (let index = 0; index < transcript.length; index += size) {
    chunks.push(transcript.slice(index, index + size));
  }
  return chunks;
}
