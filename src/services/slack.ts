import { WebClient } from "@slack/web-api";

import type { AppEnv } from "../config/env.js";
import type { ContentOpportunity, ProfileId } from "../domain/types.js";

export class SlackService {
  private readonly client: WebClient | null;

  constructor(private readonly env: AppEnv, client?: WebClient) {
    this.client = client ?? (env.SLACK_BOT_TOKEN ? new WebClient(env.SLACK_BOT_TOKEN) : null);
  }

  async sendDigest(params: { channelId: string; digestKey: string; opportunities: ContentOpportunity[] }) {
    if (!this.client) {
      return null;
    }
    if (params.opportunities.length === 0) {
      return null;
    }

    const grouped = groupByProfile(params.opportunities);
    const lines = [`Editorial opportunities digest (${params.opportunities.length})`, `Digest key: ${params.digestKey}`];
    const blocks: Array<Record<string, unknown>> = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Editorial opportunities digest"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${params.opportunities.length}* opportunities need review.`
        }
      }
    ];

    for (const [profile, items] of Object.entries(grouped)) {
      blocks.push({
        type: "divider"
      });
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${profile}*`
        }
      });

      lines.push("");
      lines.push(`*${profile}*`);
      for (const opportunity of items.slice(0, 5)) {
        const notionUrl = opportunity.notionPageId ? notionPageUrl(opportunity.notionPageId) : "";
        const proofSummary = `${truncate(opportunity.primaryEvidence.excerpt, 140)} (${opportunity.evidence.length} proofs)`;
        const freshness = `${(opportunity.evidenceFreshness * 100).toFixed(0)}%`;
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              notionUrl ? `• <${notionUrl}|${escapeMrkdwn(opportunity.title)}>` : `• *${escapeMrkdwn(opportunity.title)}*`,
              `Why now: ${escapeMrkdwn(opportunity.whyNow)}`,
              `Proof: ${escapeMrkdwn(proofSummary)}`,
              `Freshness: ${freshness}`
            ].join("\n")
          }
        });
        lines.push(
          `- ${opportunity.title} | freshness ${(opportunity.evidenceFreshness * 100).toFixed(0)} | evidence ${opportunity.evidence.length}`
        );
      }
    }

    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `digest-key:${params.digestKey}`
        }
      ]
    });

    const response = await this.client.chat.postMessage({
      channel: params.channelId,
      text: lines.join("\n"),
      blocks: blocks as any
    });

    return {
      ts: response.ts ?? "",
      channel: typeof response.channel === "string" ? response.channel : params.channelId
    };
  }

  async notifySelection(opportunity: ContentOpportunity) {
    if (!this.client) {
      return;
    }
    const channel = await this.resolveDigestChannelId();
    if (!channel) {
      return;
    }

    await this.client.chat.postMessage({
      channel,
      text: `Opportunity selected in Notion: ${opportunity.title}${opportunity.notionPageId ? ` ${notionPageUrl(opportunity.notionPageId)}` : ""}`
    });
  }

  async findRecentDigestByKey(params: {
    channelId: string;
    digestKey: string;
    maxPages?: number;
    limitPerPage?: number;
  }) {
    if (!this.client) {
      return null;
    }
    const maxPages = params.maxPages ?? 10;
    const limitPerPage = params.limitPerPage ?? 100;
    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const history = await this.client.conversations.history({
        channel: params.channelId,
        limit: limitPerPage,
        cursor
      });

      const match = (history.messages ?? []).find((message) => messageContainsDigestKey(message, params.digestKey));
      if (match && typeof match.ts === "string") {
        return {
          ts: match.ts,
          channel: params.channelId
        };
      }

      cursor = history.response_metadata?.next_cursor || undefined;
      if (!cursor) {
        break;
      }
    }

    return null;
  }

  async sendOperationalAlert(text: string) {
    if (!this.client) {
      return;
    }
    const channel = await this.resolveDigestChannelId();
    if (!channel) {
      return;
    }

    await this.client.chat.postMessage({
      channel,
      text: `ALERT: ${text}`
    });
  }

  async resolveDigestChannelId() {
    if (!this.client || !this.env.SLACK_EDITORIAL_OPERATOR_ID) {
      return null;
    }

    if (!this.env.SLACK_EDITORIAL_OPERATOR_ID.startsWith("U")) {
      return this.env.SLACK_EDITORIAL_OPERATOR_ID;
    }

    const response = await this.client.conversations.open({
      users: this.env.SLACK_EDITORIAL_OPERATOR_ID
    });
    return response.channel?.id ?? null;
  }
}

function groupByProfile(opportunities: ContentOpportunity[]) {
  return opportunities.reduce<Record<string, ContentOpportunity[]>>((accumulator, opportunity) => {
    const key = opportunity.ownerProfile ?? "unassigned";
    accumulator[key] ??= [];
    accumulator[key].push(opportunity);
    return accumulator;
  }, {});
}

function notionPageUrl(notionPageId: string) {
  return `https://www.notion.so/${notionPageId.replace(/-/g, "")}`;
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function escapeMrkdwn(value: string) {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] ?? char);
}

function messageContainsDigestKey(message: unknown, digestKey: string) {
  const typedMessage = (message ?? {}) as {
    text?: string;
    blocks?: unknown[];
  };
  const text = typeof typedMessage.text === "string" ? typedMessage.text : "";
  if (text.includes(digestKey)) {
    return true;
  }

  const blocks = Array.isArray(typedMessage.blocks) ? typedMessage.blocks : [];
  return blocks.some((block) => JSON.stringify(block).includes(digestKey));
}
