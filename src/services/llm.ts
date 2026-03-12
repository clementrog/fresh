import {
  z,
  type ZodObject,
  type ZodSchema,
  type ZodTypeAny
} from "zod";

import type { AppEnv } from "../config/env.js";

export interface LlmUsage {
  mode: "provider" | "fallback";
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
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

export class LlmClient {
  constructor(
    private readonly env: AppEnv,
    private readonly logger?: LoggerLike,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async generateStructured<T>(params: {
    step: string;
    system: string;
    prompt: string;
    schema: ZodSchema<T>;
    allowFallback: boolean;
    fallback: () => T;
  }): Promise<LlmStructuredResponse<T>> {
    if (!this.env.OPENAI_API_KEY) {
      if (!params.allowFallback) {
        throw new Error("Missing OPENAI_API_KEY");
      }
      return this.buildFallback(params, "Missing OPENAI_API_KEY");
    }

    try {
      const signal = buildTimeoutSignal(this.env.LLM_TIMEOUT_MS);
      const response = await this.fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: this.env.LLM_MODEL,
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
        throw new Error(`LLM request failed with ${response.status}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("LLM response did not include content");
      }

      const parsedJson = JSON.parse(content) as unknown;
      const validated = params.schema.parse(parsedJson);
      const usage: LlmUsage = {
        mode: "provider",
        promptTokens: payload.usage?.prompt_tokens ?? Math.ceil(params.prompt.length / 4),
        completionTokens: payload.usage?.completion_tokens ?? Math.ceil(content.length / 4),
        estimatedCostUsd: estimateCostUsd(
          payload.usage?.prompt_tokens ?? Math.ceil(params.prompt.length / 4),
          payload.usage?.completion_tokens ?? Math.ceil(content.length / 4)
        )
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

function estimateCostUsd(promptTokens: number, completionTokens: number) {
  const promptRate = 0.0000004;
  const completionRate = 0.0000016;
  return Number((promptTokens * promptRate + completionTokens * completionRate).toFixed(6));
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
    properties[key] = convertZodType(value as ZodTypeAny);
    if (!isOptionalSchema(value as ZodTypeAny)) {
      required.push(key);
    }
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

function isJsonSchemaObject(value: unknown): value is { type?: unknown } & Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
