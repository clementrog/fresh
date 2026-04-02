import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import {
  z,
  type ZodObject,
  type ZodSchema,
  type ZodTypeAny
} from "zod";

import type { AppEnv } from "../config/env.js";
import type { LlmProvider } from "../domain/types.js";

export interface LlmUsage {
  mode: "provider" | "fallback";
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  model?: string;
  skipped?: boolean;
  error?: string;
}

export interface LlmStructuredResponse<T> {
  output: T;
  usage: LlmUsage;
  mode: "provider" | "fallback";
  error?: string;
}

type LoggerLike = {
  error: (...args: unknown[]) => void;
};

type SpawnFn = typeof defaultSpawn;

export class LlmClient {
  private cliPreflightPromise: Promise<void> | null = null;
  private readonly spawnImpl: SpawnFn;

  constructor(
    private readonly env: AppEnv,
    private readonly logger?: LoggerLike,
    private readonly fetchImpl: typeof fetch = fetch,
    spawnImpl?: SpawnFn
  ) {
    this.spawnImpl = spawnImpl ?? defaultSpawn;
  }

  async generateStructured<T>(params: {
    step: string;
    system: string;
    prompt: string;
    schema: ZodSchema<T>;
    provider?: LlmProvider;
    model?: string;
    allowFallback: boolean;
    fallback: () => T;
  }): Promise<LlmStructuredResponse<T>> {
    const provider = params.provider ?? this.resolveProvider(params.step);
    const model = params.model ?? this.resolveModel(params.step, provider);

    if (provider === "claude-cli") {
      if (params.step !== "draft-generation") {
        throw new Error(
          `claude-cli provider is only supported for the "draft-generation" step (got "${params.step}"). Check your LLM provider configuration.`
        );
      }
      if (!this.cliPreflightPromise) {
        this.cliPreflightPromise = this.verifyClaudeCliPreflight();
      }
      await this.cliPreflightPromise;
    }

    if (provider !== "claude-cli") {
      const providerKey = provider === "anthropic" ? this.env.ANTHROPIC_API_KEY : this.env.OPENAI_API_KEY;
      if (!providerKey) {
        if (!params.allowFallback) {
          throw new Error(`Missing API key for ${provider}`);
        }
        return this.buildFallback(params, `Missing API key for ${provider}`);
      }
    }

    try {
      const result = await this.requestStructuredContent({
        provider,
        model,
        step: params.step,
        system: params.system,
        prompt: params.prompt,
        schema: params.schema
      });

      const parsedJson = JSON.parse(result.content) as unknown;
      const normalizedJson = normalizeStructuredOutput(params.schema, parsedJson);
      const validated = params.schema.parse(normalizedJson);
      const resolvedModel = result.runtimeModel ?? model;
      const usage: LlmUsage = {
        mode: "provider",
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        estimatedCostUsd: result.actualCostUsd ?? estimateCostUsd(
          provider,
          model,
          result.promptTokens,
          result.completionTokens
        ),
        model: resolvedModel
      };

      return {
        output: validated,
        usage,
        mode: "provider"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown LLM error";
      this.logger?.error({ step: params.step, error }, "LLM structured generation failed");
      if (!params.allowFallback) {
        throw error;
      }

      return this.buildFallback(params, message);
    }
  }

  private async requestStructuredContent<T>(params: {
    provider: LlmProvider;
    model: string;
    step: string;
    system: string;
    prompt: string;
    schema: ZodSchema<T>;
  }): Promise<{ content: string; promptTokens: number; completionTokens: number; actualCostUsd?: number; runtimeModel?: string }> {
    if (params.provider === "claude-cli") {
      return this.requestClaudeCliStructuredContent(params);
    }
    return params.provider === "anthropic"
      ? this.requestAnthropicStructuredContent(params)
      : this.requestOpenAiStructuredContent(params);
  }

  private async requestOpenAiStructuredContent<T>(params: {
    model: string;
    step: string;
    system: string;
    prompt: string;
    schema: ZodSchema<T>;
  }) {
    const signal = buildTimeoutSignal(this.env.LLM_TIMEOUT_MS ?? 45_000);
    const response = await this.fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.OPENAI_API_KEY ?? ""}`
      },
      body: JSON.stringify({
        model: params.model,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: schemaNameForStep(params.step),
            strict: true,
            schema: zodToJsonSchema(params.schema)
          }
        },
        messages: [
          {
            role: "system",
            content: params.system
          },
          {
            role: "user",
            content: params.prompt
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed with ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI response did not include content");
    }

    return {
      content,
      promptTokens: payload.usage?.prompt_tokens ?? Math.ceil(params.prompt.length / 4),
      completionTokens: payload.usage?.completion_tokens ?? Math.ceil(content.length / 4)
    };
  }

  private async requestAnthropicStructuredContent(params: {
    model: string;
    step: string;
    system: string;
    prompt: string;
    schema: ZodSchema<unknown>;
  }) {
    const signal = buildTimeoutSignal(this.env.LLM_TIMEOUT_MS ?? 45_000);
    const response = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: 2048,
        system: `${params.system}\nReturn valid JSON only that matches the requested schema.`,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "Return JSON only. No markdown.",
                  `Schema name: ${schemaNameForStep(params.step)}`,
                  `JSON schema: ${JSON.stringify(zodToJsonSchema(params.schema))}`,
                  params.prompt
                ].join("\n\n")
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic request failed with ${response.status}`);
    }

    const payload = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const content = payload.content
      ?.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (!content) {
      throw new Error("Anthropic response did not include text content");
    }

    return {
      content,
      promptTokens: payload.usage?.input_tokens ?? Math.ceil(params.prompt.length / 4),
      completionTokens: payload.usage?.output_tokens ?? Math.ceil(content.length / 4)
    };
  }

  private requestClaudeCliStructuredContent<T>(params: {
    model: string;
    step: string;
    system: string;
    prompt: string;
    schema: ZodSchema<T>;
  }): Promise<{ content: string; promptTokens: number; completionTokens: number; actualCostUsd?: number; runtimeModel?: string }> {
    const cliPath = this.env.CLAUDE_CLI_PATH ?? "claude";
    const budget = String(this.env.CLAUDE_CLI_MAX_BUDGET_USD ?? 0.5);
    const timeoutMs = this.env.CLAUDE_CLI_TIMEOUT_MS ?? 120_000;
    const jsonSchema = JSON.stringify(zodToJsonSchema(params.schema));

    return new Promise((resolve, reject) => {
      const args = [
        "-p",
        "--output-format", "json",
        "--no-session-persistence",
        "--tools", "",
        "--model", params.model,
        "--system-prompt", params.system,
        "--json-schema", jsonSchema,
        "--max-budget-usd", budget,
      ];

      const child = this.spawnImpl(cliPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: timeoutMs,
        env: process.env,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          reject(new Error(`Claude CLI not found at "${cliPath}". Install it or set CLAUDE_CLI_PATH.`));
        } else {
          reject(new Error(`Claude CLI spawn error: ${err.message}`));
        }
      });

      child.on("close", (code, signal) => {
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          reject(new Error(`Claude CLI timed out after ${timeoutMs}ms (killed by ${signal})`));
          return;
        }

        try {
          const response = JSON.parse(stdout) as {
            is_error?: boolean;
            result?: string;
            errors?: string[];
            structured_output?: unknown;
            total_cost_usd?: number;
            usage?: {
              input_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
              output_tokens?: number;
            };
            modelUsage?: Record<string, unknown>;
          };

          if (response.is_error) {
            const detail = response.errors?.join("; ") ?? response.result ?? "unknown";
            reject(new Error(`Claude CLI returned error: ${detail}`));
            return;
          }

          if (response.structured_output === undefined || response.structured_output === null) {
            reject(new Error("Claude CLI response missing structured_output field"));
            return;
          }

          const cliUsage = response.usage ?? {};
          const promptTokens = (cliUsage.input_tokens ?? 0)
            + (cliUsage.cache_creation_input_tokens ?? 0)
            + (cliUsage.cache_read_input_tokens ?? 0);
          const completionTokens = cliUsage.output_tokens ?? 0;

          // Extract the actual runtime model from modelUsage keys (e.g. "claude-opus-4-6").
          // If multiple models appear (retries, routing), use the one matching the requested model,
          // or fall back to the single key if there's exactly one.
          const modelKeys = response.modelUsage ? Object.keys(response.modelUsage) : [];
          const runtimeModel = modelKeys.length === 1
            ? modelKeys[0]
            : modelKeys.find((k) => k === params.model) ?? modelKeys[0];

          resolve({
            content: JSON.stringify(response.structured_output),
            promptTokens,
            completionTokens,
            actualCostUsd: response.total_cost_usd,
            runtimeModel,
          });
        } catch {
          if (code !== 0) {
            reject(new Error(`Claude CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`));
            return;
          }
          reject(new Error(`Claude CLI output is not valid JSON: ${stdout.slice(0, 200)}`));
        }
      });

      child.stdin.write(params.prompt);
      child.stdin.end();
    });
  }

  private verifyClaudeCliPreflight(): Promise<void> {
    const cliPath = this.env.CLAUDE_CLI_PATH ?? "claude";
    const model = this.resolveModel("draft-generation", "claude-cli");

    return new Promise((resolve, reject) => {
      const versionChild = this.spawnImpl(cliPath, ["--version"], { stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
      let versionOut = "";
      let versionErr = "";
      versionChild.stdout.on("data", (chunk: Buffer) => { versionOut += chunk.toString(); });
      versionChild.stderr.on("data", (chunk: Buffer) => { versionErr += chunk.toString(); });

      versionChild.on("error", (err: NodeJS.ErrnoException) => {
        reject(new Error(
          `Claude CLI preflight failed: binary not found at "${cliPath}". ` +
          `Install Claude Code CLI or set CLAUDE_CLI_PATH. (${err.code ?? err.message})`
        ));
      });

      versionChild.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Claude CLI preflight failed: "${cliPath} --version" exited with code ${code}. stderr: ${versionErr.slice(0, 300)}`));
          return;
        }

        // Step 2: minimal structured-output round-trip with target model
        const probeSchema = '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}';
        const probeChild = this.spawnImpl(cliPath, [
          "-p", "--output-format", "json", "--no-session-persistence",
          "--tools", "", "--model", model,
          "--json-schema", probeSchema,
          "--max-budget-usd", "0.15",
        ], { stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, env: process.env });

        let probeOut = "";
        let probeErr = "";
        probeChild.stdout.on("data", (chunk: Buffer) => { probeOut += chunk.toString(); });
        probeChild.stderr.on("data", (chunk: Buffer) => { probeErr += chunk.toString(); });

        probeChild.on("error", (err: Error) => {
          reject(new Error(`Claude CLI preflight probe failed: ${err.message}`));
        });

        probeChild.on("close", (probeCode) => {
          try {
            const probeResponse = JSON.parse(probeOut) as { is_error?: boolean; structured_output?: unknown; errors?: string[] };
            if (probeResponse.is_error) {
              const detail = probeResponse.errors?.join("; ") ?? "unknown reason";
              reject(new Error(`Claude CLI preflight probe failed: ${detail}. Model "${model}" may need a higher CLAUDE_CLI_MAX_BUDGET_USD or may not be available.`));
              return;
            }
            if (probeResponse.structured_output === undefined || probeResponse.structured_output === null) {
              reject(new Error(`Claude CLI preflight probe missing structured_output. --json-schema may not be supported by this CLI version.`));
              return;
            }
            resolve();
          } catch {
            // stdout wasn't valid JSON — fall through to exit-code diagnostics
            if (probeCode !== 0) {
              reject(new Error(
                `Claude CLI preflight probe failed: model "${model}" may not be supported or flags are incompatible. ` +
                `Exit code ${probeCode}. stderr: ${probeErr.slice(0, 300)}`
              ));
              return;
            }
            reject(new Error(`Claude CLI preflight probe output is not valid JSON: ${probeOut.slice(0, 200)}`));
          }
        });

        probeChild.stdin.write('Return {"ok":true}');
        probeChild.stdin.end();
      });
    });
  }

  private resolveProvider(step: string): LlmProvider {
    if (step === "draft-generation") {
      return this.env.DRAFT_LLM_PROVIDER ?? "openai";
    }

    if (isNanoStep(step)) {
      return this.env.NANO_LLM_PROVIDER ?? "openai";
    }

    // Tier 2: screening/signal are always OpenAI fast-reasoning models
    if (step.includes("screening") || step.includes("signal")) {
      return "openai";
    }

    if (this.env.INTELLIGENCE_LLM_PROVIDER) {
      return this.env.INTELLIGENCE_LLM_PROVIDER;
    }

    return this.env.ANTHROPIC_API_KEY ? "anthropic" : "openai";
  }

  private resolveModel(step: string, provider: LlmProvider) {
    // Tier 1a: Draft generation — creative writing
    if (step === "draft-generation") {
      if (provider === "claude-cli") {
        // The env schema defaults DRAFT_LLM_MODEL to "gpt-5.4" (OpenAI).
        // When the operator chose claude-cli, use the Claude default unless
        // they explicitly set a Claude model name.
        const envModel = this.env.DRAFT_LLM_MODEL;
        return envModel && !envModel.startsWith("gpt-") ? envModel : "claude-opus-4-6";
      }
      return this.env.DRAFT_LLM_MODEL ?? "gpt-5.4";
    }

    // Tier 3: Nano — classification, enrichment policies, sensitivity
    if (isNanoStep(step)) {
      return this.env.NANO_LLM_MODEL ?? "gpt-5.4-nano";
    }

    // Tier 1b: High reasoning — editorial judgment & synthesis
    if (step.includes("create-enrich") || step.includes("market-research")) {
      return this.env.INTELLIGENCE_LLM_MODEL ?? "gpt-5.4";
    }

    // Tier 2: Fast reasoning — screening, signal extraction
    if (step.includes("screening") || step.includes("signal")) {
      return this.env.LLM_MODEL ?? "gpt-5.4-mini";
    }

    // Fallback
    return provider === "anthropic"
      ? this.env.INTELLIGENCE_LLM_MODEL ?? "gpt-5.4"
      : this.env.LLM_MODEL ?? "gpt-5.4-mini";
  }

  private buildFallback<T>(
    params: {
      schema: ZodSchema<T>;
      fallback: () => T;
    },
    error: string
  ): LlmStructuredResponse<T> {
    const fallbackOutput = params.schema.parse(params.fallback());
    return {
      output: fallbackOutput,
      usage: {
        mode: "fallback",
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        error
      },
      mode: "fallback",
      error
    };
  }
}

function isNanoStep(step: string): boolean {
  return step.includes("sensitivity") || step.includes("enrichment-policy")
    || step.includes("publishability");
}

function estimateCostUsd(provider: LlmProvider, model: string, promptTokens: number, completionTokens: number) {
  const rates = provider === "claude-cli"
    ? inferClaudeCliRates(model)
    : provider === "anthropic"
      ? inferAnthropicRates(model)
      : inferOpenAiRates(model);
  const promptRate = rates.promptRate;
  const completionRate = rates.completionRate;
  return Number((promptTokens * promptRate + completionTokens * completionRate).toFixed(6));
}

function inferOpenAiRates(model: string) {
  if (model.includes("gpt-5.4-nano")) {
    return {
      promptRate: 0.0000001,
      completionRate: 0.0000004
    };
  }

  if (model.includes("gpt-5.4-mini")) {
    return {
      promptRate: 0.0000004,
      completionRate: 0.0000016
    };
  }

  if (model.includes("gpt-5.4")) {
    return {
      promptRate: 0.0000025,
      completionRate: 0.000015
    };
  }

  if (model.includes("gpt-5")) {
    return {
      promptRate: 0.00000125,
      completionRate: 0.00001
    };
  }

  return {
    promptRate: 0.0000004,
    completionRate: 0.0000016
  };
}

function inferAnthropicRates(model: string) {
  if (model.includes("sonnet")) {
    return {
      promptRate: 0.000003,
      completionRate: 0.000015
    };
  }

  return {
    promptRate: 0.000003,
    completionRate: 0.000015
  };
}

function inferClaudeCliRates(model: string) {
  if (model.includes("opus")) {
    return {
      promptRate: 0.000015,
      completionRate: 0.000075
    };
  }
  if (model.includes("sonnet")) {
    return {
      promptRate: 0.000003,
      completionRate: 0.000015
    };
  }
  return {
    promptRate: 0.000015,
    completionRate: 0.000075
  };
}

function buildTimeoutSignal(timeoutMs: number) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(`LLM request timed out after ${timeoutMs}ms`)), timeoutMs).unref?.();
  return controller.signal;
}

function schemaNameForStep(step: string) {
  return step
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "structured_output";
}

function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const converted = convertZodType(schema);
  if (!isJsonSchemaObject(converted) || converted.type !== "object") {
    throw new Error("Structured output schemas must be Zod objects.");
  }

  return converted;
}

function convertZodType(schema: ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    return convertObject(schema);
  }
  if (schema instanceof z.ZodString) {
    return { type: "string" };
  }
  if (schema instanceof z.ZodNumber) {
    return { type: "number" };
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }
  if (schema instanceof z.ZodEnum) {
    return {
      type: "string",
      enum: [...schema.options]
    };
  }
  if (schema instanceof z.ZodArray) {
    return {
      type: "array",
      items: convertZodType(schema.element)
    };
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return convertZodType(schema._def.innerType);
  }
  if (schema instanceof z.ZodNullable) {
    const inner = convertZodType(schema.unwrap());
    const innerType = isJsonSchemaObject(inner) ? inner.type : undefined;
    if (typeof innerType === "string") {
      return {
        ...inner,
        type: [innerType, "null"]
      };
    }
    return {
      anyOf: [inner, { type: "null" }]
    };
  }
  if (schema instanceof z.ZodLiteral) {
    const value = schema._def.value;
    const type =
      typeof value === "string"
        ? "string"
        : typeof value === "number"
          ? "number"
          : typeof value === "boolean"
            ? "boolean"
            : undefined;
    if (!type) {
      throw new Error(`Unsupported literal type in structured output schema: ${typeof value}`);
    }
    return {
      type,
      enum: [value]
    };
  }

  throw new Error(`Unsupported Zod schema in structured output conversion: ${schema._def.typeName}`);
}

function convertObject(schema: ZodObject<any>) {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const typedValue = value as ZodTypeAny;
    properties[key] = isOptionalSchema(typedValue)
      ? makeSchemaNullable(convertZodType(unwrapOptionalSchema(typedValue)))
      : convertZodType(typedValue);
    required.push(key);
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    required
  };
}

function isOptionalSchema(schema: ZodTypeAny): boolean {
  return schema instanceof z.ZodOptional || schema instanceof z.ZodDefault;
}

function unwrapOptionalSchema(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
    current = current._def.innerType;
  }
  return current;
}

function makeSchemaNullable(schema: Record<string, unknown>) {
  const typed = isJsonSchemaObject(schema) ? schema.type : undefined;
  if (typeof typed === "string") {
    return {
      ...schema,
      type: [typed, "null"]
    };
  }
  if (Array.isArray(typed)) {
    return typed.includes("null")
      ? schema
      : {
          ...schema,
          type: [...typed, "null"]
        };
  }
  const anyOf = isJsonSchemaObject(schema) ? schema.anyOf : undefined;
  if (Array.isArray(anyOf) && anyOf.some((entry) => isJsonSchemaObject(entry) && entry.type === "null")) {
    return schema;
  }
  return {
    anyOf: [schema, { type: "null" }]
  };
}

function normalizeStructuredOutput(schema: ZodTypeAny, value: unknown): unknown {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    if (value === null) {
      return undefined;
    }
    return normalizeStructuredOutput(schema._def.innerType, value);
  }

  if (schema instanceof z.ZodNullable) {
    if (value === null) {
      return null;
    }
    return normalizeStructuredOutput(schema.unwrap(), value);
  }

  if (schema instanceof z.ZodObject && value && typeof value === "object" && !Array.isArray(value)) {
    const shape = schema.shape;
    const normalizedEntries = Object.entries(shape).map(([key, childSchema]) => [
      key,
      normalizeStructuredOutput(childSchema as ZodTypeAny, (value as Record<string, unknown>)[key])
    ]);
    return Object.fromEntries(normalizedEntries);
  }

  if (schema instanceof z.ZodArray && Array.isArray(value)) {
    return value.map((entry) => normalizeStructuredOutput(schema.element, entry));
  }

  // Clamp numbers to min/max bounds declared in the schema
  if (schema instanceof z.ZodNumber && typeof value === "number") {
    let clamped = value;
    for (const check of (schema._def.checks ?? []) as Array<{ kind: string; value: number }>) {
      if (check.kind === "min" && clamped < check.value) clamped = check.value;
      if (check.kind === "max" && clamped > check.value) clamped = check.value;
    }
    return clamped;
  }

  return value;
}

function isJsonSchemaObject(value: unknown): value is { type?: unknown } & Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
