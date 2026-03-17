import { describe, expect, it } from "vitest";

import { NotionConnector } from "../src/connectors/notion.js";
import type { RawSourceItem } from "../src/domain/types.js";

const env = {
  DATABASE_URL: "",
  NOTION_TOKEN: "test-token",
  NOTION_PARENT_PAGE_ID: "",
  OPENAI_API_KEY: "test-key",
  CLAAP_API_KEY: "",
  LINEAR_API_KEY: "",
  DEFAULT_TIMEZONE: "Europe/Paris",
  LLM_MODEL: "gpt-5",
  LLM_TIMEOUT_MS: 100,
  LOG_LEVEL: "info"
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
  databaseAllowlist: ["db-proof-1"],
  excludedDatabaseNames: []
};

const context = {
  dryRun: false,
  now: new Date("2026-03-17T10:00:00.000Z")
};

function makeProofRawItem(overrides: {
  id?: string;
  properties?: Record<string, unknown>;
} = {}): RawSourceItem {
  return {
    id: overrides.id ?? "proof-page-1",
    cursor: "2026-03-17T09:00:00.000Z",
    payload: {
      sourceType: "database",
      parentDatabaseId: "db-proof-1",
      page: {
        id: overrides.id ?? "proof-page-1",
        url: "https://www.notion.so/proof-page-1",
        last_edited_time: "2026-03-17T09:00:00.000Z",
        properties: overrides.properties ?? {
          Claim: {
            type: "title",
            title: [{ plain_text: "SOC 2 Type II certification achieved" }]
          },
          "Proof category": {
            type: "select",
            select: { name: "Security" }
          },
          "Evidence Summary": {
            type: "rich_text",
            rich_text: [{ plain_text: "Completed SOC 2 Type II audit with zero critical findings. Report available for enterprise prospects." }]
          },
          Theme: {
            type: "select",
            select: { name: "Enterprise trust" }
          },
          "Source URL": {
            type: "url",
            url: "https://example.com/soc2-report"
          },
          Date: {
            type: "date",
            date: { start: "2026-03-15" }
          }
        }
      }
    }
  };
}

function stubConnector() {
  const connector = new NotionConnector(env);
  (connector as unknown as { fetchPageContent: () => Promise<string> }).fetchPageContent = async () =>
    "Additional context about the SOC 2 certification process and results.";
  return connector;
}

describe("internal proof notion ingestion", () => {
  it("normalizes internal proof row with all fields", async () => {
    const connector = stubConnector();
    const normalized = await connector.normalize(makeProofRawItem(), config, context);

    expect(normalized.metadata.notionKind).toBe("internal-proof");
    expect(normalized.metadata.proofCategory).toBe("security");
    expect(normalized.metadata.theme).toBe("Enterprise trust");
    expect(normalized.metadata.profileHint).toBe("thomas");
    expect(normalized.title).toBe("SOC 2 Type II certification achieved");
    expect(normalized.sourceUrl).toBe("https://example.com/soc2-report");
    expect(normalized.text).toContain("SOC 2 Type II certification achieved");
    expect(normalized.text).toContain("Proof category: security");
    expect(normalized.text).toContain("Completed SOC 2 Type II audit with zero critical findings.");
    expect(normalized.summary).toContain("Proof category: security");
    expect(normalized.summary).toContain("Completed SOC 2 Type II audit with zero critical findings.");
    expect(normalized.chunks).toBeDefined();
    expect(normalized.chunks!.length).toBeGreaterThanOrEqual(3);
    expect(normalized.chunks![0]).toBe("SOC 2 Type II certification achieved");
    expect(normalized.chunks![1]).toBe("Proof category: security");
    expect(normalized.chunks).toContain("Completed SOC 2 Type II audit with zero critical findings. Report available for enterprise prospects.");
  });

  it("handles all four proof categories with correct profileHint", async () => {
    const connector = new NotionConnector(env);
    // Use neutral page content to avoid keyword pollution across categories
    (connector as unknown as { fetchPageContent: () => Promise<string> }).fetchPageContent = async () =>
      "Supporting details for this proof item.";

    const cases = [
      { category: "Security", expectedCategory: "security", expectedProfile: "thomas" },
      { category: "Product", expectedCategory: "product", expectedProfile: "virginie" },
      { category: "Implementation", expectedCategory: "implementation", expectedProfile: "quentin" },
      { category: "Operations", expectedCategory: "operations", expectedProfile: "baptiste" }
    ];

    for (const { category, expectedCategory, expectedProfile } of cases) {
      const rawItem = makeProofRawItem({
        id: `proof-${category.toLowerCase()}`,
        properties: {
          Claim: {
            type: "title",
            title: [{ plain_text: `${category} proof claim` }]
          },
          "Proof category": {
            type: "select",
            select: { name: category }
          }
        }
      });

      const normalized = await connector.normalize(rawItem, config, context);
      expect(normalized.metadata.notionKind).toBe("internal-proof");
      expect(normalized.metadata.proofCategory).toBe(expectedCategory);
      expect(normalized.metadata.profileHint).toBe(expectedProfile);
    }
  });

  it("normalizes French category names", async () => {
    const connector = stubConnector();

    const frenchCases = [
      { french: "Sécurité", expected: "security" },
      { french: "Produit", expected: "product" },
      { french: "Implémentation", expected: "implementation" },
      { french: "Opérations", expected: "operations" }
    ];

    for (const { french, expected } of frenchCases) {
      const rawItem = makeProofRawItem({
        id: `proof-fr-${expected}`,
        properties: {
          Claim: {
            type: "title",
            title: [{ plain_text: `French ${expected} claim` }]
          },
          "Proof category": {
            type: "select",
            select: { name: french }
          }
        }
      });

      const normalized = await connector.normalize(rawItem, config, context);
      expect(normalized.metadata.notionKind).toBe("internal-proof");
      expect(normalized.metadata.proofCategory).toBe(expected);
    }
  });

  it("falls through to generic when Claim property missing", async () => {
    const connector = stubConnector();
    const rawItem = makeProofRawItem({
      properties: {
        Title: {
          type: "title",
          title: [{ plain_text: "Not a claim property" }]
        },
        "Proof category": {
          type: "select",
          select: { name: "Security" }
        }
      }
    });

    const normalized = await connector.normalize(rawItem, config, context);
    expect(normalized.metadata.notionKind).toBeUndefined();
  });

  it("falls through when Proof category missing", async () => {
    const connector = stubConnector();
    const rawItem = makeProofRawItem({
      properties: {
        Claim: {
          type: "title",
          title: [{ plain_text: "Valid claim" }]
        }
      }
    });

    const normalized = await connector.normalize(rawItem, config, context);
    expect(normalized.metadata.notionKind).toBeUndefined();
  });

  it("falls through when Proof category has unrecognized value", async () => {
    const connector = stubConnector();
    const rawItem = makeProofRawItem({
      properties: {
        Claim: {
          type: "title",
          title: [{ plain_text: "Valid claim" }]
        },
        "Proof category": {
          type: "select",
          select: { name: "Unknown Category" }
        }
      }
    });

    const normalized = await connector.normalize(rawItem, config, context);
    expect(normalized.metadata.notionKind).toBeUndefined();
  });

  it("market-insight wins over internal proof when both properties present", async () => {
    const connector = stubConnector();
    const rawItem = makeProofRawItem({
      properties: {
        // Market insight property (checked first in normalize)
        Insight: {
          type: "title",
          title: [{ plain_text: "Market insight title" }]
        },
        Theme: {
          type: "select",
          select: { name: "General" }
        },
        // Internal proof properties
        Claim: {
          type: "title",
          title: [{ plain_text: "Proof claim" }]
        },
        "Proof category": {
          type: "select",
          select: { name: "Security" }
        }
      }
    });

    const normalized = await connector.normalize(rawItem, config, context);
    expect(normalized.metadata.notionKind).toBe("market-insight");
  });

  it("defaults Theme to General when absent", async () => {
    const connector = stubConnector();
    const rawItem = makeProofRawItem({
      properties: {
        Claim: {
          type: "title",
          title: [{ plain_text: "SOC 2 certification" }]
        },
        "Proof category": {
          type: "select",
          select: { name: "Security" }
        }
      }
    });

    const normalized = await connector.normalize(rawItem, config, context);
    expect(normalized.metadata.notionKind).toBe("internal-proof");
    expect(normalized.metadata.theme).toBe("General");
  });

  it("accepts both Evidence summary and Evidence Summary property names", async () => {
    const connector = stubConnector();
    const rawItem = makeProofRawItem({
      id: "proof-page-case-variant",
      properties: {
        Claim: {
          type: "title",
          title: [{ plain_text: "Structured implementation proof" }]
        },
        "Proof category": {
          type: "select",
          select: { name: "Implementation" }
        },
        "Evidence summary": {
          type: "rich_text",
          rich_text: [{ plain_text: "Implementation proof kept under the alternate property casing." }]
        }
      }
    });

    const normalized = await connector.normalize(rawItem, config, context);
    expect(normalized.metadata.notionKind).toBe("internal-proof");
    expect(normalized.text).toContain("Implementation proof kept under the alternate property casing.");
    expect(normalized.summary).toContain("Implementation proof kept under the alternate property casing.");
  });
});
