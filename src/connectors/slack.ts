import { WebClient } from "@slack/web-api";

import type { AppEnv } from "../config/env.js";
import type {
  NormalizedSourceItem,
  RawSourceItem,
  RunContext,
  SlackSourceConfig
} from "../domain/types.js";
import { hashParts } from "../lib/ids.js";
import { BaseConnector } from "./base.js";

export class SlackConnector extends BaseConnector<SlackSourceConfig> {
  readonly source = "slack" as const;

  constructor(private readonly env: AppEnv) {
    super();
  }

  override async fetchSince(cursor: string | null, config: SlackSourceConfig, _context: RunContext): Promise<RawSourceItem[]> {
    if (!config.enabled || !this.env.SLACK_BOT_TOKEN) {
      return [];
    }

    const client = new WebClient(this.env.SLACK_BOT_TOKEN);
    const items: RawSourceItem[] = [];

    for (const channel of config.channels.filter((entry) => entry.enabled)) {
      let nextCursor: string | undefined;
      do {
        const history = await this.executeWithRateLimit(config, () =>
          client.conversations.history({
            channel: channel.channelId,
            oldest: cursor ?? undefined,
            limit: 200,
            cursor: nextCursor
          })
        );

        for (const message of history.messages ?? []) {
          if (typeof message.ts !== "string") {
            continue;
          }

          if (channel.mode === "threads_only" && !message.thread_ts) {
            continue;
          }

          if (channel.mode === "mentions_only" && !(message.text ?? "").includes("<@")) {
            continue;
          }

          items.push({
            id: `${channel.channelId}:${message.ts}`,
            cursor: message.ts,
            payload: {
              ...message,
              channelId: channel.channelId,
              ingestionMode: channel.mode
            }
          });

          if ((channel.mode === "full" || channel.mode === "threads_only") && message.thread_ts && message.reply_count) {
            const replies = await this.executeWithRateLimit(config, () =>
              client.conversations.replies({
                channel: channel.channelId,
                ts: message.thread_ts as string,
                limit: 200
              })
            );
            for (const reply of replies.messages ?? []) {
              if (typeof reply.ts !== "string" || reply.ts === message.ts) {
                continue;
              }
              items.push({
                id: `${channel.channelId}:${reply.ts}`,
                cursor: reply.ts,
                payload: {
                  ...reply,
                  channelId: channel.channelId,
                  ingestionMode: channel.mode,
                  parentThreadTs: message.thread_ts
                }
              });
            }
          }
        }

        nextCursor = history.response_metadata?.next_cursor || undefined;
      } while (nextCursor);
    }

    return items;
  }

  override async normalize(rawItem: RawSourceItem, config: SlackSourceConfig, context: RunContext): Promise<NormalizedSourceItem> {
    const payload = rawItem.payload as {
      text?: string;
      ts?: string;
      user?: string;
      thread_ts?: string;
      channelId?: string;
      ingestionMode?: string;
      parentThreadTs?: string;
    };
    const text = payload.text ?? "";
    const occurredAt = slackTsToIso(payload.ts ?? String(context.now.getTime() / 1000));
    const channelId = payload.channelId ?? "unknown";
    const threadTs = payload.parentThreadTs ?? payload.thread_ts ?? payload.ts ?? "";
    const sourceItemId = rawItem.id;
    return {
      source: "slack",
      sourceItemId,
      externalId: `slack:${sourceItemId}`,
      sourceFingerprint: hashParts(["slack", sourceItemId, text]),
      sourceUrl: `https://slack.com/app_redirect?channel=${channelId}&message_ts=${payload.ts ?? ""}`,
      title: text.slice(0, 80) || `Slack message ${rawItem.id}`,
      text,
      summary: text.slice(0, 200),
      authorName: payload.user,
      occurredAt,
      ingestedAt: context.now.toISOString(),
      metadata: {
        channelId,
        threadTs,
        ingestionMode: payload.ingestionMode ?? "full",
        storeRawText: config.storeRawText
      },
      rawPayload: rawItem.payload,
      rawText: config.storeRawText ? text : null,
      chunks: undefined
    };
  }

  override async backfill(range: { from: Date; to: Date }, config: SlackSourceConfig, _context: RunContext): Promise<RawSourceItem[]> {
    return this.fetchSince(Math.floor(range.from.getTime() / 1000).toString(), config, {
      dryRun: false,
      now: range.to
    });
  }
}

function slackTsToIso(ts: string) {
  const millis = Number.parseFloat(ts) * 1000;
  return new Date(Number.isFinite(millis) ? millis : Date.now()).toISOString();
}
