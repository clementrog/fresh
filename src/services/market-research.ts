import { z } from "zod";

import { marketResearchSummarySchema } from "../config/schema.js";
import type {
  MarketQueryRecord,
  MarketResearchRuntimeConfig,
  NormalizedSourceItem
} from "../domain/types.js";
import { hashParts, hashText } from "../lib/ids.js";
import type { LlmClient, LlmUsage } from "./llm.js";

type ExistingSourceItem = {
  fingerprint: string;
} | null;

type FetchLike = typeof fetch;

interface MarketResearchRunParams {
  companyId: string;
  marketQueries: MarketQueryRecord[];
  doctrineMarkdown: string;
  runtimeConfig: MarketResearchRuntimeConfig;
  now: Date;
  llmClient: LlmClient;
  tavilyApiKey?: string;
  findExistingSourceItem: (params: {
    companyId: string;
    source: "market-research";
    sourceItemId: string;
  }) => Promise<ExistingSourceItem>;
  fetchImpl?: FetchLike;
}

interface TavilySearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    raw_content?: string;
    score?: number;
  }>;
}

interface NormalizedMarketResearchResult {
  url: string;
  title: string;
  snippet: string;
  score?: number;
}

type MarketResearchSummary = z.infer<typeof marketResearchSummarySchema>;

export interface MarketResearchRunResult {
  items: NormalizedSourceItem[];
  usageEvents: Array<{ step: string; usage: LlmUsage }>;
  fetchedResultsCount: number;
  skippedUnchanged: number;
  skippedEmpty: number;
}

export async function runMarketResearch(params: MarketResearchRunParams): Promise<MarketResearchRunResult> {
  const client = new TavilyClient(
    params.tavilyApiKey,
    params.runtimeConfig,
    params.fetchImpl ?? fetch
  );
  const usageEvents: Array<{ step: string; usage: LlmUsage }> = [];
  const items: NormalizedSourceItem[] = [];
  let fetchedResultsCount = 0;
  let skippedUnchanged = 0;
  let skippedEmpty = 0;

  for (const marketQuery of params.marketQueries) {
    const normalizedResults = await client.search(marketQuery.query);
    fetchedResultsCount += normalizedResults.length;

    if (normalizedResults.length === 0) {
      skippedEmpty += 1;
      continue;
    }

    const resultSetHash = buildResultSetHash(marketQuery.query, normalizedResults);
    const sourceItemId = `market-query:${marketQuery.id}:set:${resultSetHash}`;
    const sourceFingerprint = hashParts([
      params.companyId,
      marketQuery.id,
      resultSetHash,
      "market_research_summary"
    ]);

    const existing = await params.findExistingSourceItem({
      companyId: params.companyId,
      source: "market-research",
      sourceItemId
    });

    if (existing?.fingerprint === sourceFingerprint) {
      skippedUnchanged += 1;
      continue;
    }

    if (existing && existing.fingerprint !== sourceFingerprint) {
      throw new Error(`Existing market research row ${sourceItemId} has unexpected fingerprint mismatch.`);
    }

    const response = await params.llmClient.generateStructured({
      step: "market-research-summary",
      system: buildSystemPrompt(params.doctrineMarkdown),
      prompt: buildSummaryPrompt(marketQuery.query, normalizedResults),
      schema: marketResearchSummarySchema,
      allowFallback: true,
      fallback: () => buildFallbackSummary(marketQuery.query, normalizedResults)
    });

    usageEvents.push({
      step: "market-research-summary",
      usage: response.usage
    });

    const groundedSummary = sanitizeSummaryOutput(
      response.output,
      marketQuery.query,
      normalizedResults
    );

    const item = buildNormalizedSourceItem({
      companyId: params.companyId,
      marketQuery,
      resultSetHash,
      normalizedResults,
      summaryOutput: groundedSummary,
      now: params.now,
      storeRawText: params.runtimeConfig.storeRawText
    });
    items.push(item);
  }

  return {
    items,
    usageEvents,
    fetchedResultsCount,
    skippedUnchanged,
    skippedEmpty
  };
}

class TavilyClient {
  private lastRequestAt = 0;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly runtimeConfig: MarketResearchRuntimeConfig,
    private readonly fetchImpl: FetchLike
  ) {}

  async search(query: string): Promise<NormalizedMarketResearchResult[]> {
    if (!this.apiKey) {
      throw new Error("Missing TAVILY_API_KEY for market research.");
    }

    const payload = await this.executeWithRateLimit(async () => {
      const response = await this.fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          search_depth: "basic",
          max_results: this.runtimeConfig.maxResultsPerQuery,
          include_answer: false,
          include_raw_content: false
        })
      });

      if (!response.ok) {
        const message = `Tavily request failed with ${response.status}`;
        if (response.status === 429 || response.status >= 500) {
          throw new Error(message);
        }
        throw new NonRetryableError(message);
      }

      return response.json() as Promise<TavilySearchResponse>;
    });

    return normalizeTavilyResults(payload.results ?? [], this.runtimeConfig.maxResultsPerQuery);
  }

  private async executeWithRateLimit<TResult>(operation: () => Promise<TResult>) {
    const minDelayMs = Math.ceil(60000 / Math.max(1, this.runtimeConfig.rateLimit.requestsPerMinute));
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < minDelayMs) {
      await sleep(minDelayMs - elapsed);
    }

    for (let attempt = 0; attempt <= this.runtimeConfig.rateLimit.maxRetries; attempt += 1) {
      try {
        const result = await operation();
        this.lastRequestAt = Date.now();
        return result;
      } catch (error) {
        this.lastRequestAt = Date.now();
        if (error instanceof NonRetryableError) {
          throw error;
        }
        if (attempt === this.runtimeConfig.rateLimit.maxRetries) {
          throw error;
        }
        await sleep(this.runtimeConfig.rateLimit.initialDelayMs * (attempt + 1));
      }
    }

    throw new Error("Tavily request failed unexpectedly.");
  }
}

class NonRetryableError extends Error {}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTavilyResults(
  results: TavilySearchResponse["results"],
  maxResults: number
): NormalizedMarketResearchResult[] {
  const dedupedByUrl = new Map<string, NormalizedMarketResearchResult>();
  for (const result of (results ?? []).slice(0, maxResults)) {
    const url = normalizeUrl(result.url ?? "");
    if (!url) {
      continue;
    }

    const title = normalizeWhitespace(result.title ?? "");
    const snippet = normalizeWhitespace(result.content ?? result.raw_content ?? "");
    if (!title && !snippet) {
      continue;
    }

    if (!dedupedByUrl.has(url)) {
      dedupedByUrl.set(url, {
        url,
        title: title || url,
        snippet: snippet || title || url,
        score: typeof result.score === "number" ? result.score : undefined
      });
    }
  }

  return [...dedupedByUrl.values()].sort((left, right) => left.url.localeCompare(right.url));
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.toString();
  } catch {
    return trimmed;
  }
}

function buildResultSetHash(query: string, results: NormalizedMarketResearchResult[]) {
  return hashText(JSON.stringify({
    query: normalizeWhitespace(query),
    results: results.map((result) => ({
      url: result.url,
      title: result.title,
      snippet: result.snippet
    }))
  }));
}

function buildSystemPrompt(doctrineMarkdown: string) {
  return [
    "You summarize bounded market research for an editorial intelligence system.",
    "Ground every claim in the provided search results only.",
    "Do not invent facts, trends, or companies that are not present in the inputs.",
    "Return concise, concrete findings that can later feed an opportunity creation pipeline.",
    "",
    "## Layer 1 Doctrine",
    doctrineMarkdown
  ].join("\n");
}

function buildSummaryPrompt(query: string, results: NormalizedMarketResearchResult[]) {
  return [
    `Query: ${query}`,
    "",
    "Search results:",
    ...results.map((result, index) => [
      `[${index}] ${result.title}`,
      `URL: ${result.url}`,
      `Snippet: ${result.snippet}`
    ].join("\n")),
    "",
    "Return JSON only. Each key finding must cite one or more result indices."
  ].join("\n\n");
}

function buildFallbackSummary(query: string, results: NormalizedMarketResearchResult[]): MarketResearchSummary {
  const keyFindings = results.slice(0, Math.min(results.length, 3)).map((result, index) => ({
    claim: result.snippet || result.title,
    supportingResultIndices: [index]
  }));

  return {
    title: `Market research summary: ${normalizeWhitespace(query).slice(0, 80)}`,
    summary: results
      .slice(0, Math.min(results.length, 2))
      .map((result) => result.snippet || result.title)
      .join(" "),
    keyFindings
  };
}

function sanitizeSummaryOutput(
  summaryOutput: MarketResearchSummary,
  query: string,
  normalizedResults: NormalizedMarketResearchResult[]
): MarketResearchSummary {
  const keyFindings = summaryOutput.keyFindings
    .map((finding) => ({
      ...finding,
      supportingResultIndices: uniqueSupportingIndices(finding.supportingResultIndices)
        .filter((index) => normalizedResults[index] !== undefined)
    }))
    .filter((finding) => finding.supportingResultIndices.length > 0);

  if (keyFindings.length === 0) {
    return buildFallbackSummary(query, normalizedResults);
  }

  return {
    ...summaryOutput,
    keyFindings
  };
}

function buildNormalizedSourceItem(params: {
  companyId: string;
  marketQuery: MarketQueryRecord;
  resultSetHash: string;
  normalizedResults: NormalizedMarketResearchResult[];
  summaryOutput: MarketResearchSummary;
  now: Date;
  storeRawText: boolean;
}): NormalizedSourceItem {
  const sourceItemId = `market-query:${params.marketQuery.id}:set:${params.resultSetHash}`;
  const externalId = `market-research:${params.marketQuery.id}:${params.resultSetHash}`;
  const sourceFingerprint = hashParts([
    params.companyId,
    params.marketQuery.id,
    params.resultSetHash,
    "market_research_summary"
  ]);
  const text = buildSummaryText(
    params.marketQuery.query,
    params.summaryOutput,
    params.normalizedResults
  );

  return {
    source: "market-research",
    sourceItemId,
    externalId,
    sourceFingerprint,
    sourceUrl: params.normalizedResults[0]?.url ?? "",
    title: params.summaryOutput.title,
    summary: params.summaryOutput.summary,
    text,
    occurredAt: params.now.toISOString(),
    ingestedAt: params.now.toISOString(),
    metadata: {
      kind: "market_research_summary",
      marketQueryId: params.marketQuery.id,
      query: params.marketQuery.query,
      priority: params.marketQuery.priority,
      resultSetHash: params.resultSetHash,
      resultCount: params.normalizedResults.length,
      generatedAt: params.now.toISOString(),
      resultUrls: params.normalizedResults.map((result) => result.url)
    },
    rawPayload: {
      query: {
        id: params.marketQuery.id,
        query: params.marketQuery.query,
        priority: params.marketQuery.priority,
        enabled: params.marketQuery.enabled
      },
      normalizedResults: params.normalizedResults,
      summary: params.summaryOutput
    },
    rawText: params.storeRawText ? text : null,
    chunks: [
      params.summaryOutput.summary,
      ...params.summaryOutput.keyFindings.map((finding) => finding.claim)
    ]
  };
}

function buildSummaryText(
  query: string,
  summaryOutput: MarketResearchSummary,
  normalizedResults: NormalizedMarketResearchResult[]
) {
  const keyFindingBlocks = summaryOutput.keyFindings.map((finding, index) => {
    const citedResults = uniqueSupportingIndices(finding.supportingResultIndices)
      .map((resultIndex) => normalizedResults[resultIndex])
      .filter((result): result is NormalizedMarketResearchResult => Boolean(result));

    return [
      `${index + 1}. ${finding.claim}`,
      ...citedResults.map((result) => `   - ${result.title} (${result.url})`)
    ].join("\n");
  });

  return [
    `Query: ${query}`,
    "",
    `Summary: ${summaryOutput.summary}`,
    "",
    "Key findings:",
    ...keyFindingBlocks
  ].join("\n");
}

function uniqueSupportingIndices(indices: number[]) {
  return [...new Set(indices.filter((index) => Number.isInteger(index) && index >= 0))].sort((left, right) => left - right);
}
