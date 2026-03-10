import { WebClient } from "@slack/web-api";

import type { AppEnv } from "../config/env.js";
import type { ContentOpportunity, ProfileId } from "../domain/types.js";

export class SlackService {
  private readonly client: WebClient | null;

  constructor(private readonly env: AppEnv) {
    this.client = env.SLACK_BOT_TOKEN ? new WebClient(env.SLACK_BOT_TOKEN) : null;
  }

  async sendDigest(opportunities: ContentOpportunity[]) {
    if (!this.client || !this.env.SLACK_EDITORIAL_OPERATOR_ID) {
      return;
    }

    const grouped = groupByProfile(opportunities);
    const lines = ["Editorial opportunities digest"];

    for (const [profile, items] of Object.entries(grouped)) {
      lines.push("");
      lines.push(`*${profile}*`);
      for (const opportunity of items.slice(0, 5)) {
        lines.push(
          `- ${opportunity.title} | freshness ${(opportunity.evidenceFreshness * 100).toFixed(0)} | evidence ${opportunity.supportingEvidenceCount + 1}`
        );
      }
    }

    await this.client.chat.postMessage({
      channel: this.env.SLACK_EDITORIAL_OPERATOR_ID,
      text: lines.join("\n")
    });
  }

  async notifySelection(opportunity: ContentOpportunity) {
    if (!this.client || !this.env.SLACK_EDITORIAL_OPERATOR_ID) {
      return;
    }

    await this.client.chat.postMessage({
      channel: this.env.SLACK_EDITORIAL_OPERATOR_ID,
      text: `Opportunity selected in Notion: ${opportunity.title}`
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
