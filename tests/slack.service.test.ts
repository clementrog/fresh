import { describe, expect, it, vi } from "vitest";

import { SlackService } from "../src/services/slack.js";

describe("slack service", () => {
  it("sends a rich digest with why-now copy and Notion links", async () => {
    const postMessage = vi.fn(async () => ({}));
    const service = new SlackService(
      {
        DATABASE_URL: "",
        NOTION_TOKEN: "",
        NOTION_PARENT_PAGE_ID: "parent-page",
        SLACK_BOT_TOKEN: "token",
        SLACK_EDITORIAL_OPERATOR_ID: "U123",
        OPENAI_API_KEY: "",
        CLAAP_API_KEY: "",
        LINEAR_API_KEY: "",
        DEFAULT_TIMEZONE: "Europe/Paris",
        LLM_MODEL: "test",
        LLM_TIMEOUT_MS: 100,
        LOG_LEVEL: "info"
      },
      {
        chat: {
          postMessage
        }
      } as never
    );

    await service.sendDigest({
      channelId: "D123",
      digestKey: "digest-key-1",
      opportunities: [{
        id: "opp_1",
        sourceFingerprint: "opp-fp-1",
        title: "Proof-led angle",
        ownerProfile: "quentin",
        narrativePillar: "sales",
        angle: "Angle",
        whyNow: "Fresh field proof is piling up this week.",
        whatItIsAbout: "About",
        whatItIsNotAbout: "Not about",
        relatedSignalIds: ["signal_1"],
        evidence: [
          {
            id: "evidence_1",
            source: "slack",
            sourceItemId: "source-1",
            sourceUrl: "https://example.com",
            timestamp: new Date().toISOString(),
            excerpt: "Prospects keep asking for proof of adoption in late-stage deals.",
            excerptHash: "hash-1",
            freshnessScore: 0.9
          }
        ],
        primaryEvidence: {
          id: "evidence_1",
          source: "slack",
          sourceItemId: "source-1",
          sourceUrl: "https://example.com",
          timestamp: new Date().toISOString(),
          excerpt: "Prospects keep asking for proof of adoption in late-stage deals.",
          excerptHash: "hash-1",
          freshnessScore: 0.9
        },
        supportingEvidenceCount: 0,
        evidenceFreshness: 0.9,
        evidenceExcerpts: ["Prospects keep asking for proof of adoption in late-stage deals."],
        routingStatus: "Routed",
        readiness: "Draft candidate",
        status: "Ready for V1",
        suggestedFormat: "Narrative lesson post",
        lastDigestAt: undefined,
        v1History: [],
        enrichmentLog: [],
        notionPageId: "12345678-1234-1234-1234-1234567890ab",
        notionPageFingerprint: "opp-fp-1"
      }]
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    const calls = postMessage.mock.calls as unknown as Array<[{
      text: string;
      blocks?: unknown;
    }]>;
    const payload = calls[0]?.[0];
    if (!payload) {
      throw new Error("Expected Slack payload");
    }
    expect(payload.text).toContain("Editorial opportunities digest");
    expect(payload.text).toContain("Digest key: digest-key-1");
    expect(JSON.stringify(payload.blocks)).toContain("Fresh field proof is piling up this week.");
    expect(JSON.stringify(payload.blocks)).toContain("https://www.notion.so/123456781234123412341234567890ab");
    expect(JSON.stringify(payload.blocks)).toContain("digest-key:digest-key-1");
  });

  it("paginates Slack history when reconciling a digest by key", async () => {
    const conversationsHistory = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ ts: "111.111", text: "something else" }],
        response_metadata: {
          next_cursor: "page-2"
        }
      })
      .mockResolvedValueOnce({
        messages: [{ ts: "222.222", text: "Digest key: digest-key-2" }],
        response_metadata: {}
      });
    const service = new SlackService(
      {
        DATABASE_URL: "",
        NOTION_TOKEN: "",
        NOTION_PARENT_PAGE_ID: "parent-page",
        SLACK_BOT_TOKEN: "token",
        SLACK_EDITORIAL_OPERATOR_ID: "U123",
        OPENAI_API_KEY: "",
        CLAAP_API_KEY: "",
        LINEAR_API_KEY: "",
        DEFAULT_TIMEZONE: "Europe/Paris",
        LLM_MODEL: "test",
        LLM_TIMEOUT_MS: 100,
        LOG_LEVEL: "info"
      },
      {
        conversations: {
          history: conversationsHistory,
          open: vi.fn(async () => ({ channel: { id: "D123" } }))
        }
      } as never
    );

    const channelId = await service.resolveDigestChannelId();
    const result = await service.findRecentDigestByKey({
      channelId: channelId ?? "D123",
      digestKey: "digest-key-2"
    });

    expect(conversationsHistory).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ts: "222.222",
      channel: "D123"
    });
  });
});
