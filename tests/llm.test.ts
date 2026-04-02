import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EventEmitter } from "node:events";

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

// --- claude-cli provider tests ---

function makeCliEnv(overrides: Record<string, unknown> = {}) {
  return {
    DATABASE_URL: "",
    OPENAI_API_KEY: "",
    DRAFT_LLM_PROVIDER: "claude-cli" as const,
    DRAFT_LLM_MODEL: "claude-opus-4-6",
    CLAUDE_CLI_PATH: "/fake/claude",
    CLAUDE_CLI_TIMEOUT_MS: 5000,
    LLM_TIMEOUT_MS: 100,
    LOG_LEVEL: "info",
    ...overrides
  };
}

function makeFakeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: string;
  error?: NodeJS.ErrnoException;
}) {
  const child = new EventEmitter();
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  (child as unknown as Record<string, unknown>).stdout = stdoutEmitter;
  (child as unknown as Record<string, unknown>).stderr = stderrEmitter;
  (child as unknown as Record<string, unknown>).stdin = { write() {}, end() {} };

  process.nextTick(() => {
    if (opts.error) {
      child.emit("error", opts.error);
      return;
    }
    if (opts.stdout) stdoutEmitter.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) stderrEmitter.emit("data", Buffer.from(opts.stderr));
    process.nextTick(() => child.emit("close", opts.exitCode ?? 0, opts.signal ?? null));
  });

  return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
}

const cliJsonResponse = (structured: unknown, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    is_error: false,
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 50,
      output_tokens: 300,
    },
    modelUsage: { "claude-opus-4-6": { inputTokens: 100, outputTokens: 300 } },
    structured_output: structured,
    result: "",
    ...overrides,
  });

const cliTestSchema = z.object({ value: z.string() });

function makeCountingSpawn(schedule: Array<Parameters<typeof makeFakeChild>[0]>) {
  let callCount = 0;
  const spawnFn = (() => {
    const opts = schedule[callCount] ?? schedule[schedule.length - 1];
    callCount++;
    return makeFakeChild(opts);
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnFn, getCount: () => callCount };
}

describe("claude-cli provider", () => {
  // Preflight schedule: [0] = version check, [1] = probe, [2+] = actual calls
  const PREFLIGHT_OK: Array<Parameters<typeof makeFakeChild>[0]> = [
    { stdout: "2.1.90\n", exitCode: 0 },
    { stdout: cliJsonResponse({ ok: true }), exitCode: 0 },
  ];

  it("rejects non-draft steps with a configuration error", async () => {
    const { spawnFn } = makeCountingSpawn([
      ...PREFLIGHT_OK,
      { stdout: cliJsonResponse({ value: "test" }), exitCode: 0 },
    ]);
    const client = new LlmClient(makeCliEnv(), undefined, fetch, spawnFn);

    await expect(
      client.generateStructured({
        step: "screening",
        system: "test",
        prompt: "test",
        provider: "claude-cli",
        schema: cliTestSchema,
        allowFallback: false,
        fallback: () => ({ value: "fb" }),
      })
    ).rejects.toThrow(/claude-cli provider is only supported for the "draft-generation" step/);
  });

  it("extracts structured_output and usage from CLI response", async () => {
    const { spawnFn } = makeCountingSpawn([
      ...PREFLIGHT_OK,
      { stdout: cliJsonResponse({ value: "opus-draft" }), exitCode: 0 },
    ]);
    const client = new LlmClient(makeCliEnv(), undefined, fetch, spawnFn);
    const result = await client.generateStructured({
      step: "draft-generation",
      system: "test",
      prompt: "test",
      schema: cliTestSchema,
      allowFallback: false,
      fallback: () => ({ value: "fb" }),
    });

    expect(result.mode).toBe("provider");
    expect(result.output.value).toBe("opus-draft");
    expect(result.usage.promptTokens).toBe(350); // 100 + 200 + 50
    expect(result.usage.completionTokens).toBe(300);
    expect(result.usage.estimatedCostUsd).toBe(0.05); // actual cost from CLI, not rate-based
    expect(result.usage.model).toBe("claude-opus-4-6"); // runtime model from modelUsage
  });

  it("prefers requested model when modelUsage has multiple keys", async () => {
    const multiModelResponse = JSON.stringify({
      type: "result",
      is_error: false,
      total_cost_usd: 0.08,
      usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100 },
      modelUsage: {
        "claude-sonnet-4-6": { inputTokens: 10, outputTokens: 5 },
        "claude-opus-4-6": { inputTokens: 50, outputTokens: 100 },
      },
      structured_output: { value: "multi" },
      result: "",
    });
    const { spawnFn } = makeCountingSpawn([
      ...PREFLIGHT_OK,
      { stdout: multiModelResponse, exitCode: 0 },
    ]);
    const client = new LlmClient(makeCliEnv(), undefined, fetch, spawnFn);
    const result = await client.generateStructured({
      step: "draft-generation",
      system: "test",
      prompt: "test",
      schema: cliTestSchema,
      allowFallback: false,
      fallback: () => ({ value: "fb" }),
    });

    expect(result.usage.model).toBe("claude-opus-4-6");
  });

  it("throws when CLI binary is not found (ENOENT)", async () => {
    const enoent = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    const { spawnFn } = makeCountingSpawn([{ error: enoent }]);
    const client = new LlmClient(makeCliEnv(), undefined, fetch, spawnFn);

    await expect(
      client.generateStructured({
        step: "draft-generation",
        system: "test",
        prompt: "test",
        schema: cliTestSchema,
        allowFallback: false,
        fallback: () => ({ value: "fb" }),
      })
    ).rejects.toThrow(/preflight failed.*not found/i);
  });

  it("throws when CLI returns is_error: true", async () => {
    const { spawnFn } = makeCountingSpawn([
      ...PREFLIGHT_OK,
      { stdout: JSON.stringify({ is_error: true, result: "model overloaded" }), exitCode: 0 },
    ]);
    const client = new LlmClient(makeCliEnv(), undefined, fetch, spawnFn);

    await expect(
      client.generateStructured({
        step: "draft-generation",
        system: "test",
        prompt: "test",
        schema: cliTestSchema,
        allowFallback: false,
        fallback: () => ({ value: "fb" }),
      })
    ).rejects.toThrow(/Claude CLI returned error.*model overloaded/);
  });

  it("throws when CLI response is missing structured_output", async () => {
    const { spawnFn } = makeCountingSpawn([
      ...PREFLIGHT_OK,
      { stdout: JSON.stringify({ is_error: false, result: "some text" }), exitCode: 0 },
    ]);
    const client = new LlmClient(makeCliEnv(), undefined, fetch, spawnFn);

    await expect(
      client.generateStructured({
        step: "draft-generation",
        system: "test",
        prompt: "test",
        schema: cliTestSchema,
        allowFallback: false,
        fallback: () => ({ value: "fb" }),
      })
    ).rejects.toThrow(/missing structured_output/);
  });

  it("throws when CLI exits with non-zero code", async () => {
    const { spawnFn } = makeCountingSpawn([
      ...PREFLIGHT_OK,
      { stderr: "something went wrong", exitCode: 1 },
    ]);
    const client = new LlmClient(makeCliEnv(), undefined, fetch, spawnFn);

    await expect(
      client.generateStructured({
        step: "draft-generation",
        system: "test",
        prompt: "test",
        schema: cliTestSchema,
        allowFallback: false,
        fallback: () => ({ value: "fb" }),
      })
    ).rejects.toThrow(/exited with code 1/);
  });

  it("preflight failure surfaces on first draft call", async () => {
    const { spawnFn } = makeCountingSpawn([
      { stdout: "2.1.90\n", exitCode: 0 },
      { stderr: "unknown flag --json-schema", exitCode: 2 },
    ]);
    const client = new LlmClient(makeCliEnv(), undefined, fetch, spawnFn);

    await expect(
      client.generateStructured({
        step: "draft-generation",
        system: "test",
        prompt: "test",
        schema: cliTestSchema,
        allowFallback: false,
        fallback: () => ({ value: "fb" }),
      })
    ).rejects.toThrow(/preflight probe failed/);
  });

  it("preflight runs only once across multiple draft calls", async () => {
    const { spawnFn, getCount } = makeCountingSpawn([
      ...PREFLIGHT_OK,
      { stdout: cliJsonResponse({ value: "draft" }), exitCode: 0 },
    ]);
    const client = new LlmClient(makeCliEnv(), undefined, fetch, spawnFn);

    await client.generateStructured({
      step: "draft-generation",
      system: "test",
      prompt: "test",
      schema: cliTestSchema,
      allowFallback: false,
      fallback: () => ({ value: "fb" }),
    });

    await client.generateStructured({
      step: "draft-generation",
      system: "test",
      prompt: "test2",
      schema: cliTestSchema,
      allowFallback: false,
      fallback: () => ({ value: "fb" }),
    });

    // 2 preflight + 2 draft calls = 4 total
    expect(getCount()).toBe(4);
  });

  it("surfaces timeout as a clear error when CLI is killed by SIGTERM", async () => {
    const { spawnFn } = makeCountingSpawn([
      ...PREFLIGHT_OK,
      { exitCode: 0, signal: "SIGTERM" },
    ]);
    const client = new LlmClient(makeCliEnv(), undefined, fetch, spawnFn);

    await expect(
      client.generateStructured({
        step: "draft-generation",
        system: "test",
        prompt: "test",
        schema: cliTestSchema,
        allowFallback: false,
        fallback: () => ({ value: "fb" }),
      })
    ).rejects.toThrow(/timed out.*SIGTERM/);
  });
});
