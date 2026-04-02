import { describe, expect, it } from "vitest";

import { NotionConnector } from "../src/connectors/notion.js";
import type { RawSourceItem } from "../src/domain/types.js";

const env = {
  DATABASE_URL: "",
  NOTION_TOKEN: "test-token",
  OPENAI_API_KEY: "test-key",
  CLAAP_API_KEY: "",
  LINEAR_API_KEY: "",
  DEFAULT_TIMEZONE: "Europe/Paris",
  LLM_MODEL: "gpt-5",
  LLM_TIMEOUT_MS: 100,
  LOG_LEVEL: "info"
};

describe("market insights notion ingestion", () => {
  it("normalizes market insight database rows into structured source material", async () => {
    const connector = new NotionConnector(env);
    let pageContentCalls = 0;
    (connector as unknown as { fetchPageContent: () => Promise<string> }).fetchPageContent = async () =>
      {
        pageContentCalls += 1;
        return [
          "What happened",
          "Buyers now ask for visible proof of field adoption before trusting the promise.",
          "Why it matters",
          "This changes the standard for credible product storytelling."
        ].join("\n");
      };

    const rawItem: RawSourceItem = {
      id: "page-1",
      cursor: "2026-03-12T12:00:00.000Z",
      payload: {
        sourceType: "database",
        parentDatabaseId: "f3595464-713a-41d6-9897-5d9e0aaa065f",
        page: {
          id: "page-1",
          url: "https://www.notion.so/page-1",
          last_edited_time: "2026-03-12T12:00:00.000Z",
          properties: {
            Insight: {
              type: "title",
              title: [{ plain_text: "Buyers want proof of adoption" }]
            },
            Theme: {
              type: "select",
              select: { name: "Strategic synthesis 2026" }
            },
            "Source type": {
              type: "select",
              select: { name: "Synthesis" }
            },
            "Source URL": {
              type: "url",
              url: "https://example.com/proof"
            },
            Timestamp: {
              type: "date",
              date: { start: "2026-03-11T09:00:00.000Z" }
            }
          }
        }
      }
    };
    const config = {
      source: "notion" as const,
      enabled: true,
      storeRawText: false,
      retentionDays: 30,
      rateLimit: {
        requestsPerMinute: 30,
        maxRetries: 3,
        initialDelayMs: 10
      },
      pageAllowlist: [],
      databaseAllowlist: ["f3595464-713a-41d6-9897-5d9e0aaa065f"],
      excludedDatabaseNames: []
    };

    const normalized = await connector.normalize(rawItem, config, {
      dryRun: false,
      now: new Date("2026-03-12T12:30:00.000Z")
    });

    expect(normalized.title).toBe("Buyers want proof of adoption");
    expect(normalized.sourceUrl).toBe("https://example.com/proof");
    expect(normalized.metadata.notionKind).toBe("market-insight");
    expect(normalized.metadata.theme).toBe("Strategic synthesis 2026");
    expect(normalized.metadata.profileHint).toBe("baptiste");
    expect(pageContentCalls).toBe(1);
    expect(normalized.chunks).toEqual([
      "Buyers want proof of adoption",
      "What happened\nBuyers now ask for visible proof of field adoption before trusting the promise.\nWhy it matters\nThis changes the standard for credible product storytelling."
    ]);
    expect(normalized.text).toContain("What happened");
    expect(normalized.text).toContain("This changes the standard for credible product storytelling.");
  });

  it("keeps market insight rows on the structured path even when Theme is blank", async () => {
    const connector = new NotionConnector(env);
    (connector as unknown as { fetchPageContent: () => Promise<string> }).fetchPageContent = async () =>
      "What happened\nA labor update with enough body content to remain structured.";

    const rawItem: RawSourceItem = {
      id: "page-2",
      cursor: "2026-03-12T12:00:00.000Z",
      payload: {
        sourceType: "database",
        parentDatabaseId: "f3595464-713a-41d6-9897-5d9e0aaa065f",
        page: {
          id: "page-2",
          url: "https://www.notion.so/page-2",
          last_edited_time: "2026-03-12T12:00:00.000Z",
          properties: {
            Insight: {
              type: "title",
              title: [{ plain_text: "A labor update without an explicit theme" }]
            },
            Theme: {
              type: "select",
              select: null
            },
            "Source type": {
              type: "select",
              select: { name: "Secondary" }
            },
            "Source URL": {
              type: "url",
              url: "https://example.com/labor-update"
            },
            Timestamp: {
              type: "date",
              date: { start: "2026-03-12" }
            }
          }
        }
      }
    };
    const config = {
      source: "notion" as const,
      enabled: true,
      storeRawText: false,
      retentionDays: 30,
      rateLimit: {
        requestsPerMinute: 30,
        maxRetries: 3,
        initialDelayMs: 10
      },
      pageAllowlist: [],
      databaseAllowlist: ["f3595464-713a-41d6-9897-5d9e0aaa065f"],
      excludedDatabaseNames: []
    };

    const normalized = await connector.normalize(rawItem, config, {
      dryRun: false,
      now: new Date("2026-03-12T12:30:00.000Z")
    });

    expect(normalized.metadata.notionKind).toBe("market-insight");
    expect(normalized.metadata.theme).toBe("General");
    expect(normalized.chunks).toEqual([
      "A labor update without an explicit theme",
      "What happened\nA labor update with enough body content to remain structured."
    ]);
  });
});
