import { describe, expect, it, vi } from "vitest";
import { ClaapConnector } from "../src/connectors/claap.js";
import type { ClaapSourceConfig, RawSourceItem, RunContext } from "../src/domain/types.js";
import type { LlmClient } from "../src/services/llm.js";

const CLAAP_CONFIG: ClaapSourceConfig = {
  source: "claap",
  enabled: true,
  storeRawText: true,
  retentionDays: 180,
  rateLimit: {
    requestsPerMinute: 120,
    maxRetries: 0,
    initialDelayMs: 0
  },
  workspaceIds: ["ws-1"],
  folderIds: [],
  maxRecordingsPerRun: 50
};

const CONTEXT: RunContext = {
  dryRun: false,
  now: new Date("2026-03-19T12:00:00.000Z")
};

const ENV = {
  CLAAP_API_KEY: "test-key",
  DATABASE_URL: "",
  NOTION_TOKEN: "",
  NOTION_PARENT_PAGE_ID: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  TAVILY_API_KEY: "",
  LINEAR_API_KEY: "",
  DEFAULT_TIMEZONE: "Europe/Paris",
  DEFAULT_COMPANY_SLUG: "test",
  DEFAULT_COMPANY_NAME: "Test",
  INTELLIGENCE_LLM_PROVIDER: "openai" as const,
  INTELLIGENCE_LLM_MODEL: "gpt-5.4",
  DRAFT_LLM_PROVIDER: "openai" as const,
  DRAFT_LLM_MODEL: "gpt-5",
  LLM_MODEL: "gpt-4.1-mini",
  LLM_TIMEOUT_MS: 45000,
  HTTP_PORT: 3000,
  LOG_LEVEL: "info",
  NOTION_TONE_OF_VOICE_DB_ID: ""
};

function makeMockLlm(overrides: { hasSignal?: boolean; publishabilityRisk?: "safe" | "reframeable" | "harmful"; reframingSuggestion?: string } = {}): LlmClient {
  const hasSignal = overrides.hasSignal ?? true;
  const publishabilityRisk = overrides.publishabilityRisk ?? "safe";
  return {
    generateStructured: vi.fn().mockResolvedValue({
      output: {
        hasSignal,
        title: hasSignal ? "Signal détecté dans l'appel commercial" : "",
        summary: hasSignal ? "Le prospect a exprimé un besoin urgent de conformité DSN." : "",
        hookCandidate: hasSignal ? "Quand un DRH vous dit qu'il n'a plus confiance dans sa DSN..." : "",
        whyItMatters: hasSignal ? "La conformité DSN est un enjeu critique pour 2026." : "",
        excerpts: hasSignal ? ["Le DRH a dit: nous avons perdu confiance dans notre DSN actuelle"] : [],
        signalType: hasSignal ? "Pain point" : "",
        theme: hasSignal ? "Compliance" : "",
        confidenceScore: hasSignal ? 0.85 : 0,
        publishabilityRisk,
        reframingSuggestion: overrides.reframingSuggestion
      },
      usage: { mode: "provider", promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.01 },
      mode: "provider"
    })
  } as unknown as LlmClient;
}

describe("ClaapConnector", () => {
  describe("fetchSince", () => {
    it("uses v1 API with X-Claap-Key header", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          result: {
            recordings: [{
              id: "rec-1",
              title: "Sales call",
              updatedAt: "2026-03-19T10:00:00.000Z",
              url: "https://app.claap.io/rec-1"
            }]
          }
        })
      });
      vi.stubGlobal("fetch", fetchSpy);

      const connector = new ClaapConnector(ENV);
      const items = await connector.fetchSince(null, CLAAP_CONFIG, CONTEXT);

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.claap.io/v1/recordings",
        expect.objectContaining({
          headers: { "X-Claap-Key": "test-key" }
        })
      );
      // Also fetches transcript
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.claap.io/v1/recordings/rec-1/transcript",
        expect.objectContaining({
          headers: { "X-Claap-Key": "test-key" }
        })
      );
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("rec-1");

      vi.unstubAllGlobals();
    });

    it("parses result.recordings response format", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          result: {
            recordings: [
              { id: "rec-a", updatedAt: "2026-03-19T10:00:00.000Z" },
              { id: "rec-b", updatedAt: "2026-03-19T11:00:00.000Z" }
            ]
          }
        })
      });
      vi.stubGlobal("fetch", fetchSpy);

      const connector = new ClaapConnector(ENV);
      const items = await connector.fetchSince(null, CLAAP_CONFIG, CONTEXT);

      expect(items).toHaveLength(2);
      expect(items[0].id).toBe("rec-a");
      expect(items[1].id).toBe("rec-b");

      vi.unstubAllGlobals();
    });

    it("respects cursor filter", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          result: {
            recordings: [
              { id: "rec-old", updatedAt: "2026-03-18T10:00:00.000Z" },
              { id: "rec-new", updatedAt: "2026-03-19T10:00:00.000Z" }
            ]
          }
        })
      });
      vi.stubGlobal("fetch", fetchSpy);

      const connector = new ClaapConnector(ENV);
      const items = await connector.fetchSince("2026-03-18T12:00:00.000Z", CLAAP_CONFIG, CONTEXT);

      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("rec-new");

      vi.unstubAllGlobals();
    });

    it("respects maxRecordingsPerRun cap", async () => {
      const recordings = Array.from({ length: 10 }, (_, i) => ({
        id: `rec-${i}`,
        updatedAt: `2026-03-19T${String(i).padStart(2, "0")}:00:00.000Z`
      }));
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { recordings } })
      });
      vi.stubGlobal("fetch", fetchSpy);

      const config = { ...CLAAP_CONFIG, maxRecordingsPerRun: 3 };
      const connector = new ClaapConnector(ENV);
      const items = await connector.fetchSince(null, config, CONTEXT);

      expect(items).toHaveLength(3);

      vi.unstubAllGlobals();
    });

    it("respects folderIds filter", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          result: {
            recordings: [
              { id: "rec-1", folderId: "folder-a", updatedAt: "2026-03-19T10:00:00.000Z" },
              { id: "rec-2", folderId: "folder-b", updatedAt: "2026-03-19T11:00:00.000Z" }
            ]
          }
        })
      });
      vi.stubGlobal("fetch", fetchSpy);

      const config = { ...CLAAP_CONFIG, folderIds: ["folder-a"] };
      const connector = new ClaapConnector(ENV);
      const items = await connector.fetchSince(null, config, CONTEXT);

      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("rec-1");

      vi.unstubAllGlobals();
    });

    it("returns empty array when API key is missing", async () => {
      const connector = new ClaapConnector({ ...ENV, CLAAP_API_KEY: "" });
      const items = await connector.fetchSince(null, CLAAP_CONFIG, CONTEXT);
      expect(items).toHaveLength(0);
    });

    it("returns empty array when API responds with error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

      const connector = new ClaapConnector(ENV);
      const items = await connector.fetchSince(null, CLAAP_CONFIG, CONTEXT);
      expect(items).toHaveLength(0);

      vi.unstubAllGlobals();
    });
  });

  describe("normalize", () => {
    it("assembles transcript from segments", async () => {
      const connector = new ClaapConnector(ENV);
      const rawItem: RawSourceItem = {
        id: "rec-1",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-1",
          title: "Sales call",
          url: "https://app.claap.io/rec-1",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: [
            { speaker: "Alice", text: "Welcome everyone", startedAt: 0, endedAt: 5 },
            { speaker: "Bob", text: "Thanks for having me", startedAt: 5, endedAt: 10 }
          ],
          assembledTranscript: "[Alice] Welcome everyone\n[Bob] Thanks for having me"
        }
      };

      const result = await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      expect(result.source).toBe("claap");
      expect(result.text).toContain("[Alice] Welcome everyone");
      expect(result.text).toContain("[Bob] Thanks for having me");
      expect(result.sourceUrl).toBe("https://app.claap.io/rec-1");
    });

    it("produces signal item when LLM detects a signal", async () => {
      const llm = makeMockLlm({ hasSignal: true });
      const connector = new ClaapConnector(ENV, llm);

      const longTranscript = "[Alice] " + "Le DRH a dit nous avons perdu confiance dans notre DSN actuelle. ".repeat(10);
      const rawItem: RawSourceItem = {
        id: "rec-signal",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-signal",
          title: "Commercial call",
          url: "https://app.claap.io/rec-signal",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: [],
          assembledTranscript: longTranscript
        }
      };

      const result = await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      expect(result.metadata.signalKind).toBe("claap-signal");
      expect(result.title).toBe("Signal détecté dans l'appel commercial");
      expect(result.metadata.theme).toBe("Compliance");
      expect(result.metadata.signalTypeLabel).toBe("Pain point");
      expect(result.metadata.confidenceScore).toBe(0.85);
      expect(result.metadata.hookCandidate).toContain("DRH");
    });

    it("produces plain item when LLM says no signal", async () => {
      const llm = makeMockLlm({ hasSignal: false });
      const connector = new ClaapConnector(ENV, llm);

      const longTranscript = "Some routine standup meeting about sprint planning and task updates. ".repeat(5);
      const rawItem: RawSourceItem = {
        id: "rec-nosignal",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-nosignal",
          title: "Daily standup",
          url: "https://app.claap.io/rec-nosignal",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: [],
          assembledTranscript: longTranscript
        }
      };

      const result = await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      expect(result.metadata.signalKind).toBeUndefined();
      expect(result.title).toBe("Daily standup");
    });

    it("falls back to plain item when transcript is too short for signal extraction", async () => {
      const llm = makeMockLlm({ hasSignal: true });
      const connector = new ClaapConnector(ENV, llm);

      const rawItem: RawSourceItem = {
        id: "rec-short",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-short",
          title: "Quick check-in",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: [],
          assembledTranscript: "Hello everyone"
        }
      };

      const result = await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      expect(result.metadata.signalKind).toBeUndefined();
      expect((llm.generateStructured as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("falls back to plain item when no LlmClient provided", async () => {
      const connector = new ClaapConnector(ENV);

      const longTranscript = "A very important sales call with crucial insights about the market. ".repeat(5);
      const rawItem: RawSourceItem = {
        id: "rec-nollm",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-nollm",
          title: "Sales call",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: [],
          assembledTranscript: longTranscript
        }
      };

      const result = await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      expect(result.metadata.signalKind).toBeUndefined();
      expect(result.title).toBe("Sales call");
    });

    it("falls back to plain item when LLM throws", async () => {
      const llm = {
        generateStructured: vi.fn().mockRejectedValue(new Error("LLM timeout"))
      } as unknown as LlmClient;
      const connector = new ClaapConnector(ENV, llm);

      const longTranscript = "Important discussion about compliance and regulatory changes. ".repeat(5);
      const rawItem: RawSourceItem = {
        id: "rec-llm-error",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-llm-error",
          title: "Compliance meeting",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: [],
          assembledTranscript: longTranscript
        }
      };

      const result = await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      expect(result.metadata.signalKind).toBeUndefined();
      expect(result.title).toBe("Compliance meeting");
    });

    it("chunks transcript by speaker turns when segments available", async () => {
      const connector = new ClaapConnector(ENV);

      const segments = Array.from({ length: 20 }, (_, i) => ({
        speaker: i % 2 === 0 ? "Alice" : "Bob",
        text: `Statement number ${i} about compliance topics with enough text to be meaningful`,
        startedAt: i * 10,
        endedAt: (i + 1) * 10
      }));
      const assembled = segments.map(s => `[${s.speaker}] ${s.text}`).join("\n");

      const rawItem: RawSourceItem = {
        id: "rec-chunked",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-chunked",
          title: "Long meeting",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: segments,
          assembledTranscript: assembled
        }
      };

      const result = await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      expect(result.chunks).toBeDefined();
      expect(result.chunks!.length).toBeGreaterThan(1);
      // Each chunk should start with a speaker marker
      for (const chunk of result.chunks!) {
        expect(chunk).toMatch(/^\[/);
      }
    });

    it("harmful signal → plain item with publishabilityRisk in metadata, no signalKind", async () => {
      const llm = makeMockLlm({ hasSignal: true, publishabilityRisk: "harmful" });
      const connector = new ClaapConnector(ENV, llm);

      const longTranscript = "[Customer] They don't trust the accuracy of the DSN output. ".repeat(10);
      const rawItem: RawSourceItem = {
        id: "rec-harmful",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-harmful",
          title: "Customer complaint call",
          url: "https://app.claap.io/rec-harmful",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: [],
          assembledTranscript: longTranscript
        }
      };

      const result = await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      expect(result.metadata.signalKind).toBeUndefined();
      expect(result.metadata.publishabilityRisk).toBe("harmful");
      expect(result.title).toBe("Customer complaint call");
      expect(result.metadata.reviewTitle).toBe("Signal détecté dans l'appel commercial");
      expect(result.metadata.reviewSummary).toBe("Le prospect a exprimé un besoin urgent de conformité DSN.");
      expect(result.metadata.reviewExcerpts).toEqual(["Le DRH a dit: nous avons perdu confiance dans notre DSN actuelle"]);
      expect(result.metadata.reviewWhyBlocked).toContain("Blocked as harmful");
    });

    it("reframeable signal → signalKind 'claap-signal-reframeable', confidence ≤ 0.5, reframingSuggestion in metadata", async () => {
      const llm = makeMockLlm({
        hasSignal: true,
        publishabilityRisk: "reframeable",
        reframingSuggestion: "Focus on the validation outcome, not the doubt"
      });
      const connector = new ClaapConnector(ENV, llm);

      const longTranscript = "[Customer] We had doubts about accuracy but after testing it works well. ".repeat(10);
      const rawItem: RawSourceItem = {
        id: "rec-reframeable",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-reframeable",
          title: "Customer validation call",
          url: "https://app.claap.io/rec-reframeable",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: [],
          assembledTranscript: longTranscript
        }
      };

      const result = await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      expect(result.metadata.signalKind).toBe("claap-signal-reframeable");
      expect(result.metadata.publishabilityRisk).toBe("reframeable");
      expect(result.metadata.reframingSuggestion).toBe("Focus on the validation outcome, not the doubt");
      expect(result.metadata.confidenceScore).toBeLessThanOrEqual(0.5);
      expect(result.metadata.reviewTitle).toBe("Signal détecté dans l'appel commercial");
      expect(result.metadata.reviewSummary).toBe("Le prospect a exprimé un besoin urgent de conformité DSN.");
      expect(result.metadata.reviewExcerpts).toEqual(["Le DRH a dit: nous avons perdu confiance dans notre DSN actuelle"]);
      expect(result.metadata.reviewWhyBlocked).toContain("Blocked as reframeable");
      // Extracted fields should still be present
      expect(result.metadata.theme).toBe("Compliance");
      expect(result.metadata.hookCandidate).toBeDefined();
    });

    it("safe signal → signalKind 'claap-signal', publishabilityRisk 'safe', confidence unchanged", async () => {
      const llm = makeMockLlm({ hasSignal: true, publishabilityRisk: "safe" });
      const connector = new ClaapConnector(ENV, llm);

      const longTranscript = "[Customer] Your compliance automation saved us 40 hours per month. ".repeat(10);
      const rawItem: RawSourceItem = {
        id: "rec-safe",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-safe",
          title: "Happy customer call",
          url: "https://app.claap.io/rec-safe",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: [],
          assembledTranscript: longTranscript
        }
      };

      const result = await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      expect(result.metadata.signalKind).toBe("claap-signal");
      expect(result.metadata.publishabilityRisk).toBe("safe");
      expect(result.metadata.confidenceScore).toBe(0.85);
    });

    it("plain item (no LLM) has no publishabilityRisk", async () => {
      const connector = new ClaapConnector(ENV);

      const longTranscript = "A regular meeting with general discussion about upcoming plans. ".repeat(5);
      const rawItem: RawSourceItem = {
        id: "rec-plain",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-plain",
          title: "Team standup",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: [],
          assembledTranscript: longTranscript
        }
      };

      const result = await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      expect(result.metadata.publishabilityRisk).toBeUndefined();
      expect(result.metadata.signalKind).toBeUndefined();
    });

    it("LLM failure has no publishabilityRisk", async () => {
      const llm = {
        generateStructured: vi.fn().mockRejectedValue(new Error("LLM timeout"))
      } as unknown as LlmClient;
      const connector = new ClaapConnector(ENV, llm);

      const longTranscript = "Important discussion about compliance and regulatory changes. ".repeat(5);
      const rawItem: RawSourceItem = {
        id: "rec-llm-fail",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-llm-fail",
          title: "Meeting",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: [],
          assembledTranscript: longTranscript
        }
      };

      const result = await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      expect(result.metadata.publishabilityRisk).toBeUndefined();
    });
  });

  describe("prompt", () => {
    it("includes doctrine in system prompt when provided", async () => {
      const llm = makeMockLlm({ hasSignal: true });
      const connector = new ClaapConnector(ENV, llm, "## Our company values honesty");

      const longTranscript = "[Alice] Some important discussion about compliance matters. ".repeat(10);
      const rawItem: RawSourceItem = {
        id: "rec-doctrine",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-doctrine",
          title: "Call",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: [],
          assembledTranscript: longTranscript
        }
      };

      await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      const generateCall = (llm.generateStructured as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(generateCall.system).toContain("Company Doctrine");
      expect(generateCall.system).toContain("Our company values honesty");
      expect(generateCall.system).toContain("Brand Safety");
    });

    it("includes brand safety in system prompt even without doctrine", async () => {
      const llm = makeMockLlm({ hasSignal: true });
      const connector = new ClaapConnector(ENV, llm);

      const longTranscript = "[Alice] Some important discussion about compliance matters. ".repeat(10);
      const rawItem: RawSourceItem = {
        id: "rec-nodoctrine",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {
          id: "rec-nodoctrine",
          title: "Call",
          updatedAt: "2026-03-19T10:00:00.000Z",
          transcriptSegments: [],
          assembledTranscript: longTranscript
        }
      };

      await connector.normalize(rawItem, CLAAP_CONFIG, CONTEXT);

      const generateCall = (llm.generateStructured as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(generateCall.system).toContain("Brand Safety");
      expect(generateCall.system).not.toContain("Company Doctrine");
    });
  });
});
