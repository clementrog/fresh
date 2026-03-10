import type { ZodSchema } from "zod";

import type { AppEnv } from "../config/env.js";

export interface LlmUsage {
  mode: "provider" | "fallback";
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
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
      const response = await this.fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: this.env.LLM_MODEL,
          response_format: {
            type: "json_object"
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
