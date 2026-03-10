import { describe, expect, it, vi } from "vitest";

import { SlackConnector } from "../src/connectors/slack.js";

describe("slack connector", () => {
  it("paginates thread replies beyond the first 200 messages", async () => {
    const history = vi.fn(async () => ({
      messages: [
        {
          ts: "1000.000100",
          text: "Parent thread",
          thread_ts: "1000.000100",
          reply_count: 250
        }
      ],
      response_metadata: {}
    }));
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [
          { ts: "1000.000100", text: "Parent thread" },
          { ts: "1000.000101", text: "Reply 1" }
        ],
        response_metadata: {
          next_cursor: "page-2"
        }
      })
      .mockResolvedValueOnce({
        messages: [{ ts: "1000.000102", text: "Reply 2" }],
        response_metadata: {}
      });

    const connector = new SlackConnector(
      {
        DATABASE_URL: "",
        NOTION_TOKEN: "",
        NOTION_PARENT_PAGE_ID: "",
        SLACK_BOT_TOKEN: "token",
        SLACK_EDITORIAL_OPERATOR_ID: "",
        OPENAI_API_KEY: "",
        CLAAP_API_KEY: "",
        LINEAR_API_KEY: "",
        DEFAULT_TIMEZONE: "Europe/Paris",
        LLM_MODEL: "test",
        LOG_LEVEL: "info"
      },
      () =>
        ({
          conversations: {
            history,
            replies
          }
        }) as never
    );

    const items = await connector.fetchSince(
      null,
      {
        source: "slack",
        enabled: true,
        storeRawText: true,
        retentionDays: 7,
        rateLimit: {
          requestsPerMinute: 100000,
          maxRetries: 0,
          initialDelayMs: 0
        },
        channels: [
          {
            channelId: "C123",
            mode: "threads_only",
            enabled: true
          }
        ]
      },
      {
        dryRun: false,
        now: new Date("2026-03-10T12:00:00.000Z")
      }
    );

    expect(history).toHaveBeenCalledTimes(1);
    expect(replies).toHaveBeenCalledTimes(2);
    expect(items.map((item) => item.id)).toEqual(["C123:1000.000100", "C123:1000.000101", "C123:1000.000102"]);
  });
});
