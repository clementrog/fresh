import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LlmClient } from "../src/services/llm.js";

const env = {
  DATABASE_URL: "",
  NOTION_TOKEN: "",
  NOTION_PARENT_PAGE_ID: "",
  OPENAI_API_KEY: "test-key",
  CLAAP_API_KEY: "",
  LINEAR_API_KEY: "",
  DEFAULT_TIMEZONE: "Europe/Paris",
  LLM_MODEL: "test",
  LLM_TIMEOUT_MS: 100,
  LOG_LEVEL: "info"
};

describe("llm client", () => {
  it("sends strict json schema structured output requests", async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  value: "provider"
                })
              }
            }
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5
          }
        })
      }) as Response
    );
    const client = new LlmClient(env, undefined, fetchImpl);

    const result = await client.generateStructured({
      step: "signal-extraction",
      system: "Return JSON",
      prompt: "Return JSON",
      schema: z.object({
        value: z.string(),
        category: z.enum(["a", "b"]).optional()
      }),
      allowFallback: true,
      fallback: () => ({ value: "fallback" })
    });

    expect(result.mode).toBe("provider");
    expect(result.output.value).toBe("provider");

    const firstCall = fetchImpl.mock.calls[0] as unknown[] | undefined;
    const request = (firstCall?.[1] ?? {}) as { body?: string };
    const body = JSON.parse(request.body ?? "{}") as {
      response_format?: {
        type?: string;
        json_schema?: {
          name?: string;
          strict?: boolean;
          schema?: {
            type?: string;
            additionalProperties?: boolean;
            required?: string[];
            properties?: Record<string, { type?: string | string[]; enum?: string[] }>;
          };
        };
      };
    };

    expect(body.response_format?.type).toBe("json_schema");
    expect(body.response_format?.json_schema?.name).toBe("signal_extraction");
    expect(body.response_format?.json_schema?.strict).toBe(true);
    expect(body.response_format?.json_schema?.schema?.type).toBe("object");
    expect(body.response_format?.json_schema?.schema?.additionalProperties).toBe(false);
    expect(body.response_format?.json_schema?.schema?.required).toEqual(["value", "category"]);
    expect(body.response_format?.json_schema?.schema?.properties?.value).toEqual({ type: "string" });
    expect(body.response_format?.json_schema?.schema?.properties?.category).toEqual({
      type: ["string", "null"],
      enum: ["a", "b"]
    });
  });

  it("normalizes null optional fields from OpenAI structured outputs", async () => {
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
                    value: "provider",
                    category: null
                  })
                }
              }
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5
            }
          })
        }) as Response
    );

    const result = await client.generateStructured({
      step: "signal-extraction",
      system: "Return JSON",
      prompt: "Return JSON",
      schema: z.object({
        value: z.string(),
        category: z.enum(["a", "b"]).optional()
      }),
      allowFallback: true,
      fallback: () => ({ value: "fallback" })
    });

    expect(result.mode).toBe("provider");
    expect(result.output).toEqual({
      value: "provider",
      category: undefined
    });
  });

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

  it("falls back when the provider call times out", async () => {
    const timeoutEnv = {
      ...env,
      LLM_TIMEOUT_MS: 10
    };
    const client = new LlmClient(timeoutEnv, undefined, async (_input, init) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      });
      throw new Error("unreachable");
    });

    const result = await client.generateStructured({
      step: "test-timeout",
      system: "Return JSON",
      prompt: "Return JSON",
      schema: z.object({ value: z.string() }),
      allowFallback: true,
      fallback: () => ({ value: "fallback" })
    });

    expect(result.mode).toBe("fallback");
    expect(result.output.value).toBe("fallback");
    expect(result.usage.error?.toLowerCase()).toContain("timeout");
  });
});
