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

describe("claap signals notion ingestion", () => {
  it("normalizes claap signal rows into structured source material without page crawling", async () => {
    const connector = new NotionConnector(env);
    let pageContentCalls = 0;
    (connector as unknown as { fetchPageContent: () => Promise<string> }).fetchPageContent = async () => {
      pageContentCalls += 1;
      return "This should not be called for structured Claap signals.";
    };

    const rawItem: RawSourceItem = {
      id: "claap-page-1",
      cursor: "2026-03-12T17:00:00.000Z",
      payload: {
        sourceType: "database",
        parentDatabaseId: "f159a3dc-0211-48ba-a6f7-ca6ff6b81861",
        page: {
          id: "claap-page-1",
          url: "https://www.notion.so/claap-page-1",
          last_edited_time: "2026-03-12T17:00:00.000Z",
          properties: {
            "Signal title": {
              type: "title",
              title: [{ plain_text: "Les cabinets ne croient pas la promesse produit sans preuve terrain" }]
            },
            "Signal summary": {
              type: "rich_text",
              rich_text: [{ plain_text: "Les prospects demandent des exemples d'usage concrets avant de croire le discours commercial." }]
            },
            "Hook candidate": {
              type: "rich_text",
              rich_text: [{ plain_text: "Le problème n'est pas votre démo. C'est l'absence de preuve terrain." }]
            },
            "Why it matters": {
              type: "rich_text",
              rich_text: [{ plain_text: "Cela révèle un vrai angle de crédibilité marché pour Linc." }]
            },
            "Claap excerpts": {
              type: "rich_text",
              rich_text: [{ plain_text: "- On veut voir un vrai cabinet qui l'utilise.\n- La promesse seule ne suffit plus." }]
            },
            "Transcript URL": {
              type: "url",
              url: "https://claap.io/transcript-1"
            },
            "Source date": {
              type: "date",
              date: { start: "2026-03-11" }
            },
            "Signal type": {
              type: "select",
              select: { name: "Objection" }
            },
            Theme: {
              type: "select",
              select: { name: "Buyer proof" }
            },
            "Persona hint": {
              type: "select",
              select: { name: "Quentin" }
            },
            Confidence: {
              type: "select",
              select: { name: "High" }
            },
            "Transcript title": {
              type: "rich_text",
              rich_text: [{ plain_text: "Demo debrief cabinet" }]
            },
            "Speaker / context": {
              type: "rich_text",
              rich_text: [{ plain_text: "Sales call with payroll prospect" }]
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
      databaseAllowlist: ["f159a3dc-0211-48ba-a6f7-ca6ff6b81861"],
      excludedDatabaseNames: []
    };

    const normalized = await connector.normalize(rawItem, config, {
      dryRun: false,
      now: new Date("2026-03-12T17:10:00.000Z")
    });

    expect(normalized.metadata.notionKind).toBe("claap-signal");
    expect(normalized.metadata.profileHint).toBe("quentin");
    expect(normalized.metadata.signalTypeLabel).toBe("Objection");
    expect(normalized.metadata.theme).toBe("Buyer proof");
    expect(normalized.sourceUrl).toBe("https://claap.io/transcript-1");
    expect(pageContentCalls).toBe(0);
    expect(normalized.chunks).toEqual([
      "On veut voir un vrai cabinet qui l'utilise.",
      "La promesse seule ne suffit plus."
    ]);
  });

  it("builds claap signals and direct territory from structured normalization without LLM calls", async () => {
    const item = {
      source: "notion" as const,
      sourceItemId: "claap-page-1",
      externalId: "notion:claap-page-1",
      sourceFingerprint: "claap-fingerprint-1",
      sourceUrl: "https://claap.io/transcript-1",
      title: "Les cabinets ne croient pas la promesse produit sans preuve terrain",
      text: "Signal title: Les cabinets ne croient pas la promesse produit sans preuve terrain",
      summary: "Les prospects demandent des exemples d'usage concrets avant de croire le discours commercial. Why it matters: Cela révèle un vrai angle de crédibilité marché pour Linc.",
      occurredAt: "2026-03-11T09:00:00.000Z",
      ingestedAt: "2026-03-12T17:10:00.000Z",
      metadata: {
        notionKind: "claap-signal",
        signalTypeLabel: "Objection",
        theme: "Buyer proof",
        profileHint: "quentin",
        hookCandidate: "Le problème n'est pas votre démo. C'est l'absence de preuve terrain.",
        whyItMatters: "Cela révèle un vrai angle de crédibilité marché pour Linc.",
        confidenceScore: 0.9
      },
      rawPayload: {}
    };
    const evidence = [
      {
        id: "e1",
        source: "notion" as const,
        sourceItemId: "notion:claap-page-1",
        sourceUrl: "https://claap.io/transcript-1",
        timestamp: "2026-03-11T09:00:00.000Z",
        excerpt: "On veut voir un vrai cabinet qui l'utilise.",
        excerptHash: "hash-1",
        freshnessScore: 0.9
      },
      {
        id: "e2",
        source: "notion" as const,
        sourceItemId: "notion:claap-page-1",
        sourceUrl: "https://claap.io/transcript-1",
        timestamp: "2026-03-11T09:00:00.000Z",
        excerpt: "La promesse seule ne suffit plus.",
        excerptHash: "hash-2",
        freshnessScore: 0.9
      }
    ];
    const llmClient = new LlmClient(
      env,
      undefined,
      async () => {
        throw new Error("LLM should not be called for deterministic Claap signal mapping");
      }
    );

    const extracted = await extractSignalFromItem(item, evidence, llmClient, undefined);
    const territory = await resolveTerritory(extracted.signal, llmClient);

    expect(extracted.usage.skipped).toBe(true);
    expect(extracted.signal.type).toBe("objection");
    expect(extracted.signal.probableOwnerProfile).toBe("quentin");
    expect(extracted.signal.confidence).toBe(0.9);
    expect(extracted.signal.suggestedAngle).toContain("absence de preuve terrain");
    expect(territory.usage.skipped).toBe(true);
    expect(territory.assignment.profileId).toBe("quentin");
    expect(territory.assignment.needsRouting).toBe(false);
  });

  it("infers a claap profile hint from payroll-domain language when persona hint is blank", async () => {
    const connector = new NotionConnector(env);

    const rawItem: RawSourceItem = {
      id: "claap-page-2",
      cursor: "2026-03-12T17:00:00.000Z",
      payload: {
        sourceType: "database",
        parentDatabaseId: "f159a3dc-0211-48ba-a6f7-ca6ff6b81861",
        page: {
          id: "claap-page-2",
          url: "https://www.notion.so/claap-page-2",
          last_edited_time: "2026-03-12T17:00:00.000Z",
          properties: {
            "Signal title": {
              type: "title",
              title: [{ plain_text: "Régularisations DSN : déclôturer des mois de bulletins est un risque majeur" }]
            },
            "Signal summary": {
              type: "rich_text",
              rich_text: [{ plain_text: "Une régularisation rétroactive peut casser une chaîne de bulletins déjà clôturés." }]
            },
            "Hook candidate": {
              type: "rich_text",
              rich_text: [{ plain_text: "Le vrai sujet n'est pas la régularisation. C'est tout ce qu'elle casse derrière." }]
            },
            "Why it matters": {
              type: "rich_text",
              rich_text: [{ plain_text: "C'est un angle métier fort pour expliquer les risques de la paie rétroactive." }]
            },
            "Claap excerpts": {
              type: "rich_text",
              rich_text: [{ plain_text: "- Dès qu'on touche au bulletin passé, tout le reste saute.\n- Les taux DSN ne sont plus les bons." }]
            },
            "Transcript URL": {
              type: "url",
              url: "https://claap.io/transcript-2"
            },
            "Source date": {
              type: "date",
              date: { start: "2026-03-11" }
            },
            "Signal type": {
              type: "select",
              select: { name: "Operational friction" }
            },
            Theme: {
              type: "select",
              select: { name: "DSN" }
            },
            "Persona hint": {
              type: "select",
              select: null
            },
            Confidence: {
              type: "select",
              select: { name: "High" }
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
      databaseAllowlist: ["f159a3dc-0211-48ba-a6f7-ca6ff6b81861"],
      excludedDatabaseNames: []
    };

    const normalized = await connector.normalize(rawItem, config, {
      dryRun: false,
      now: new Date("2026-03-12T17:10:00.000Z")
    });

    expect(normalized.metadata.notionKind).toBe("claap-signal");
    expect(normalized.metadata.profileHint).toBe("thomas");
  });
});
