import { describe, expect, it } from "vitest";
import { z } from "zod";

import { LlmClient } from "../src/services/llm.js";
import type { AppEnv } from "../src/config/env.js";

const testSchema = z.object({ ok: z.boolean() });

function buildDefaultEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    DATABASE_URL: "",
    NOTION_TOKEN: "",
    NOTION_PARENT_PAGE_ID: "",
    OPENAI_API_KEY: "test-openai-key",
    ANTHROPIC_API_KEY: "",
    TAVILY_API_KEY: "",
    CLAAP_API_KEY: "",
    LINEAR_API_KEY: "",
    DEFAULT_TIMEZONE: "Europe/Paris",
    DEFAULT_COMPANY_SLUG: "default",
    DEFAULT_COMPANY_NAME: "Default Company",
    INTELLIGENCE_LLM_PROVIDER: "openai" as const,
    INTELLIGENCE_LLM_MODEL: "gpt-5.4",
    DRAFT_LLM_PROVIDER: "openai" as const,
    DRAFT_LLM_MODEL: "gpt-5.4",
    LLM_MODEL: "gpt-5.4-mini",
    NANO_LLM_PROVIDER: "openai" as const,
    NANO_LLM_MODEL: "gpt-5.4-nano",
    LLM_TIMEOUT_MS: 5000,
    HTTP_PORT: 3000,
    LOG_LEVEL: "info",
    ...overrides
  } as AppEnv;
}

function mockFetch(): { fetch: typeof fetch; calls: Array<{ url: string; model: string }> } {
  const calls: Array<{ url: string; model: string }> = [];

  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = JSON.parse(init?.body as string ?? "{}");
    calls.push({ url, model: body.model });

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  return { fetch: impl as typeof fetch, calls };
}

async function callStep(client: LlmClient, step: string) {
  return client.generateStructured({
    step,
    system: "test",
    prompt: "test",
    schema: testSchema,
    allowFallback: true,
    fallback: () => ({ ok: false })
  });
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// All 11 step strings with expected model and endpoint under default env
const ROUTING_TABLE: [string, string, string][] = [
  // Tier 1: High reasoning (gpt-5.4)
  ["draft-generation",                      "gpt-5.4",      OPENAI_URL],
  ["create-enrich",                         "gpt-5.4",      OPENAI_URL],
  ["market-research-summary",               "gpt-5.4",      OPENAI_URL],
  // Tier 2: Fast reasoning (gpt-5.4-mini)
  ["screening",                             "gpt-5.4-mini", OPENAI_URL],
  ["claap-signal-extraction",               "gpt-5.4-mini", OPENAI_URL],
  // Tier 3: Nano (gpt-5.4-nano)
  ["linear-enrichment-policy",              "gpt-5.4-nano", OPENAI_URL],
  ["github-enrichment-policy",              "gpt-5.4-nano", OPENAI_URL],
  ["sensitivity-classification",            "gpt-5.4-nano", OPENAI_URL],
  ["draft-sensitivity",                     "gpt-5.4-nano", OPENAI_URL],
  ["claap-publishability-reclassification", "gpt-5.4-nano", OPENAI_URL],
  // sales-extraction is called with explicit model in SalesApp (gpt-5.4-nano); it bypasses resolveModel.
];

describe("LLM routing", () => {
  describe.each(ROUTING_TABLE)(
    "step %s → model %s at %s",
    (step, expectedModel, expectedUrl) => {
      it("routes to the correct model and endpoint", async () => {
        const { fetch: mockFn, calls } = mockFetch();
        const client = new LlmClient(buildDefaultEnv(), undefined, mockFn);
        await callStep(client, step);

        expect(calls).toHaveLength(1);
        expect(calls[0].model).toBe(expectedModel);
        expect(calls[0].url).toBe(expectedUrl);
      });
    }
  );

  describe("screening and signal steps stay on OpenAI when INTELLIGENCE_LLM_PROVIDER is anthropic", () => {
    it.each([
      ["screening", "gpt-5.4-mini"],
      ["claap-signal-extraction", "gpt-5.4-mini"],
    ])("%s → openai with model %s", async (step, expectedModel) => {
      const { fetch: mockFn, calls } = mockFetch();
      const client = new LlmClient(
        buildDefaultEnv({
          INTELLIGENCE_LLM_PROVIDER: "anthropic" as const,
          ANTHROPIC_API_KEY: "test-anthropic-key"
        }),
        undefined,
        mockFn
      );
      await callStep(client, step);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(OPENAI_URL);
      expect(calls[0].model).toBe(expectedModel);
    });
  });
});
