import type { ConnectorConfig, HealthcheckResult, RunContext, SourceConnector } from "../domain/types.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export abstract class BaseConnector<TConfig extends ConnectorConfig> implements SourceConnector<TConfig> {
  abstract readonly source: TConfig["source"];
  private lastRequestAt = 0;

  protected async pause(ms: number) {
    await sleep(ms);
  }

  async healthcheck(config: TConfig): Promise<HealthcheckResult> {
    return {
      source: this.source,
      ok: config.enabled,
      details: config.enabled ? "Connector enabled" : "Connector disabled"
    };
  }

  protected async executeWithRateLimit<TResult>(
    config: TConfig,
    operation: () => Promise<TResult>,
    retryable = true
  ): Promise<TResult> {
    const minDelayMs = Math.ceil(60000 / Math.max(1, config.rateLimit.requestsPerMinute));
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < minDelayMs) {
      await this.pause(minDelayMs - elapsed);
    }

    for (let attempt = 0; attempt <= config.rateLimit.maxRetries; attempt += 1) {
      try {
        const result = await operation();
        this.lastRequestAt = Date.now();
        return result;
      } catch (error) {
        this.lastRequestAt = Date.now();
        if (!retryable || attempt === config.rateLimit.maxRetries) {
          throw error;
        }

        await this.pause(config.rateLimit.initialDelayMs * (attempt + 1));
      }
    }

    throw new Error(`Rate-limited operation failed for ${this.source}`);
  }

  abstract fetchSince(cursor: string | null, config: TConfig, context: RunContext): Promise<import("../domain/types.js").RawSourceItem[]>;
  abstract normalize(
    rawItem: import("../domain/types.js").RawSourceItem,
    config: TConfig,
    context: RunContext
  ): Promise<import("../domain/types.js").NormalizedSourceItem>;
  abstract backfill(
    range: { from: Date; to: Date },
    config: TConfig,
    context: RunContext
  ): Promise<import("../domain/types.js").RawSourceItem[]>;

  async cleanup(retentionPolicy: { retentionDays: number }, _context: RunContext): Promise<number> {
    return retentionPolicy.retentionDays >= 0 ? 0 : 0;
  }
}
