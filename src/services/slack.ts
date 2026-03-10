import { WebClient } from "@slack/web-api";

import type { AppEnv } from "../config/env.js";
import type { ContentOpportunity, ProfileId } from "../domain/types.js";

export class SlackService {
  private readonly client: WebClient | null;

  constructor(private readonly env: AppEnv, client?: WebClient) {
    this.client = client ?? (env.SLACK_BOT_TOKEN ? new WebClient(env.SLACK_BOT_TOKEN) : null);
  }

  async sendDigest(opportunities: ContentOpportunity[]) {
    if (!this.client || !this.env.SLACK_EDITORIAL_OPERATOR_ID) {
      return;
    }
    if (opportunities.length === 0) {
      return;
    }

    const grouped = groupByProfile(opportunities);
    const lines = [`Editorial opportunities digest (${opportunities.length})`];
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
          text: `*${opportunities.length}* opportunities need review.`
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

    await this.client.chat.postMessage({
      channel: this.env.SLACK_EDITORIAL_OPERATOR_ID,
      text: lines.join("\n"),
      blocks: blocks as any
    });
  }

  async notifySelection(opportunity: ContentOpportunity) {
    if (!this.client || !this.env.SLACK_EDITORIAL_OPERATOR_ID) {
      return;
    }

    await this.client.chat.postMessage({
      channel: this.env.SLACK_EDITORIAL_OPERATOR_ID,
      text: `Opportunity selected in Notion: ${opportunity.title}${opportunity.notionPageId ? ` ${notionPageUrl(opportunity.notionPageId)}` : ""}`
    });
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
