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

  constructor(
    private readonly env: AppEnv,
    private readonly createClient: (token: string) => WebClient = (token) => new WebClient(token),
    private readonly sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {
    super();
  }

  protected override async pause(ms: number) {
    await this.sleepImpl(ms);
  }

  override async fetchSince(cursor: string | null, config: SlackSourceConfig, _context: RunContext): Promise<RawSourceItem[]> {
    if (!config.enabled || !this.env.SLACK_BOT_TOKEN) {
      return [];
    }

    const client = this.createClient(this.env.SLACK_BOT_TOKEN);
    const items: RawSourceItem[] = [];

    for (const channel of config.channels.filter((entry) => entry.enabled)) {
      let nextCursor: string | undefined;
      do {
        const history = await this.executeSlackOperation(config, () =>
          this.executeWithRateLimit(config, () =>
            client.conversations.history({
              channel: channel.channelId,
              oldest: cursor ?? undefined,
              limit: 200,
              cursor: nextCursor
            }),
          false)
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
            for (const reply of await this.fetchAllReplies(client, config, channel.channelId, message.thread_ts as string, cursor)) {
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

  private async fetchAllReplies(client: WebClient, config: SlackSourceConfig, channelId: string, threadTs: string, cursor: string | null) {
    const replies = new Map<string, any>();
    let nextCursor: string | undefined;

    do {
      const response = await this.executeSlackOperation(config, () =>
        this.executeWithRateLimit(config, () =>
          client.conversations.replies({
            channel: channelId,
            ts: threadTs,
            oldest: cursor ?? undefined,
            limit: 200,
            cursor: nextCursor
          }),
        false)
      );

      for (const reply of response.messages ?? []) {
        if (typeof reply.ts === "string") {
          replies.set(reply.ts, reply);
        }
      }

      nextCursor = response.response_metadata?.next_cursor || undefined;
    } while (nextCursor);

    return [...replies.values()];
  }

  private async executeSlackOperation<TResult>(config: SlackSourceConfig, operation: () => Promise<TResult>) {
    for (let attempt = 0; attempt <= config.rateLimit.maxRetries + 2; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const retryAfterMs = getSlackRetryAfterMs(error);
        if (retryAfterMs === null) {
          throw error;
        }

        const backoffMs = retryAfterMs + config.rateLimit.initialDelayMs * attempt;
        await this.pause(backoffMs);
      }
    }

    throw new Error("Slack operation exceeded retry budget after repeated rate limits.");
  }
}

function slackTsToIso(ts: string) {
  const millis = Number.parseFloat(ts) * 1000;
  return new Date(Number.isFinite(millis) ? millis : Date.now()).toISOString();
}

function getSlackRetryAfterMs(error: unknown) {
  if (!error || typeof error !== "object") {
    return null;
  }

  const typedError = error as {
    statusCode?: number;
    data?: { retryAfter?: number; retry_after?: number };
    headers?: Record<string, string | number | undefined> | { get?: (name: string) => string | null };
  };
  if (typedError.statusCode !== 429) {
    return null;
  }

  const retryAfterFromData = typedError.data?.retryAfter ?? typedError.data?.retry_after;
  if (typeof retryAfterFromData === "number" && Number.isFinite(retryAfterFromData)) {
    return retryAfterFromData * 1000;
  }

  if (typedError.headers && "get" in typedError.headers && typeof typedError.headers.get === "function") {
    const headerValue = typedError.headers.get("retry-after");
    const parsed = Number(headerValue);
    if (Number.isFinite(parsed)) {
      return parsed * 1000;
    }
  }

  const headerValue =
    typedError.headers && !("get" in typedError.headers)
      ? (typedError.headers as Record<string, string | number | undefined>)["retry-after"]
      : undefined;
  const parsed = Number(headerValue);
  return Number.isFinite(parsed) ? parsed * 1000 : null;
}
