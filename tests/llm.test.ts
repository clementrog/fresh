import { describe, expect, it } from "vitest";
import { z } from "zod";

import { LlmClient } from "../src/services/llm.js";

const env = {
  DATABASE_URL: "",
  NOTION_TOKEN: "",
  NOTION_PARENT_PAGE_ID: "",
  SLACK_BOT_TOKEN: "",
  SLACK_EDITORIAL_OPERATOR_ID: "",
  OPENAI_API_KEY: "test-key",
  CLAAP_API_KEY: "",
  LINEAR_API_KEY: "",
  DEFAULT_TIMEZONE: "Europe/Paris",
  LLM_MODEL: "test",
  LOG_LEVEL: "info"
};

describe("llm client", () => {
  it("falls back when provider output fails schema validation", async () => {
    const client = new LlmClient(
      env,
      undefined,
      async () =>
        ({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    wrong: "shape"
                  })
                }
              }
            ]
          })
        }) as Response
    );

    const result = await client.generateStructured({
      step: "test",
      system: "Return JSON",
      prompt: "Return JSON",
      schema: z.object({ value: z.string() }),
      allowFallback: true,
      fallback: () => ({ value: "fallback" })
    });

    expect(result.mode).toBe("fallback");
    expect(result.output.value).toBe("fallback");
  });

  it("throws when fallback is disabled", async () => {
    const client = new LlmClient(
      env,
      undefined,
      async () =>
        ({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    wrong: "shape"
                  })
                }
              }
            ]
          })
        }) as Response
    );

    await expect(
      client.generateStructured({
        step: "test",
        system: "Return JSON",
        prompt: "Return JSON",
        schema: z.object({ value: z.string() }),
        allowFallback: false,
        fallback: () => ({ value: "fallback" })
      })
    ).rejects.toThrow();
  });
});
