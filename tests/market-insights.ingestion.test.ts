import { describe, expect, it } from "vitest";

import { NotionConnector } from "../src/connectors/notion.js";
import type { RawSourceItem } from "../src/domain/types.js";
import { LlmClient } from "../src/services/llm.js";
import { extractSignalFromItem } from "../src/services/signal-extractor.js";
import { resolveTerritory } from "../src/services/territory.js";

const env = {
  DATABASE_URL: "",
  NOTION_TOKEN: "test-token",
  NOTION_PARENT_PAGE_ID: "",
  SLACK_BOT_TOKEN: "",
  SLACK_EDITORIAL_OPERATOR_ID: "",
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
    (connector as unknown as { fetchPageContent: () => Promise<string> }).fetchPageContent = async () =>
      "Buyers now ask for visible proof of field adoption before trusting the promise.";

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
    expect(normalized.chunks).toEqual([
      "Buyers want proof of adoption",
      "Theme: Strategic synthesis 2026",
      "Source type: Synthesis",
      "Buyers now ask for visible proof of field adoption before trusting the promise."
    ]);
  });

  it("builds signals and territory directly from market insight normalization without LLM calls", async () => {
    const item = {
      source: "notion" as const,
      sourceItemId: "page-1",
      externalId: "notion:page-1",
      sourceFingerprint: "fingerprint-1",
      sourceUrl: "https://example.com/proof",
      title: "Buyers want proof of adoption",
      text: "Theme: Strategic synthesis 2026\nSource type: Synthesis\nBuyers want proof of adoption in the field.",
      summary: "Theme: Strategic synthesis 2026. Source type: Synthesis. Buyers want proof of adoption.",
      occurredAt: "2026-03-11T09:00:00.000Z",
      ingestedAt: "2026-03-12T12:30:00.000Z",
      metadata: {
        notionKind: "market-insight",
        theme: "Strategic synthesis 2026",
        sourceTypeLabel: "Synthesis",
        profileHint: "baptiste"
      },
      rawPayload: {}
    };
    const evidence = [
      {
        id: "e1",
        source: "notion" as const,
        sourceItemId: "notion:page-1",
        sourceUrl: "https://example.com/proof",
        timestamp: "2026-03-11T09:00:00.000Z",
        excerpt: "Buyers want proof of adoption",
        excerptHash: "hash-1",
        freshnessScore: 0.9
      },
      {
        id: "e2",
        source: "notion" as const,
        sourceItemId: "notion:page-1",
        sourceUrl: "https://example.com/proof",
        timestamp: "2026-03-11T09:00:00.000Z",
        excerpt: "Theme: Strategic synthesis 2026",
        excerptHash: "hash-2",
        freshnessScore: 0.9
      }
    ];
    const llmClient = new LlmClient(
      env,
      undefined,
      async () => {
        throw new Error("LLM should not be called for deterministic market insight mapping");
      }
    );

    const extracted = await extractSignalFromItem(item, evidence, llmClient, undefined);
    const territory = await resolveTerritory(extracted.signal, llmClient);

    expect(extracted.usage.skipped).toBe(true);
    expect(extracted.signal.type).toBe("market-pattern");
    expect(extracted.signal.probableOwnerProfile).toBe("baptiste");
    expect(extracted.signal.confidence).toBe(0.86);
    expect(territory.usage.skipped).toBe(true);
    expect(territory.assignment.profileId).toBe("baptiste");
    expect(territory.assignment.needsRouting).toBe(false);
  });
});
