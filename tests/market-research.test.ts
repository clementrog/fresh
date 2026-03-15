import { describe, expect, it, vi } from "vitest";

import { loadConnectorConfigs } from "../src/config/loaders.js";
import type { MarketResearchRuntimeConfig } from "../src/domain/types.js";
import { runMarketResearch } from "../src/services/market-research.js";

const runtimeConfig: MarketResearchRuntimeConfig = {
  enabled: true,
  storeRawText: true,
  retentionDays: 30,
  rateLimit: {
    requestsPerMinute: 1000,
    maxRetries: 0,
    initialDelayMs: 1
  },
  maxResultsPerQuery: 5
};

const baseQuery = {
  id: "mq-1",
  companyId: "company-1",
  query: "What changed in payroll software buying behavior?",
  enabled: true,
  priority: 1,
  createdAt: "2026-03-14T09:00:00.000Z",
  updatedAt: "2026-03-14T09:00:00.000Z"
};

describe("market research service", () => {
  it("builds a deterministic source item shape from Tavily results", async () => {
    const llmClient = {
      generateStructured: vi.fn(async () => ({
        output: {
          title: "Buyers demand implementation proof",
          summary: "Recent articles emphasize proof of adoption and implementation evidence.",
          keyFindings: [
            {
              claim: "Buyers increasingly ask for proof of live implementation.",
              supportingResultIndices: [0, 1]
            }
          ]
        },
        usage: {
          mode: "provider" as const,
          promptTokens: 10,
          completionTokens: 5,
          estimatedCostUsd: 0.01
        },
        mode: "provider" as const
      }))
    } as any;

    const result = await runMarketResearch({
      companyId: "company-1",
      marketQueries: [baseQuery],
      doctrineMarkdown: "Focus on concrete buyer behavior.",
      runtimeConfig,
      now: new Date("2026-03-14T10:00:00.000Z"),
      llmClient,
      tavilyApiKey: "test-key",
      findExistingSourceItem: vi.fn(async () => null),
      fetchImpl: vi.fn(async () =>
        ({
          ok: true,
          json: async () => ({
            results: [
              {
                title: "   Buyers want proof   ",
                url: "https://example.com/proof#fragment",
                content: "  Teams now ask for visible adoption proof.  "
              },
              {
                title: "Case studies are back",
                url: "https://example.com/case-studies",
                content: "Case studies now matter earlier in the buying cycle."
              }
            ]
          })
        }) as Response
      )
    });

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.source).toBe("market-research");
    expect(item.sourceItemId).toMatch(/^market-query:mq-1:set:/);
    expect(item.externalId).toMatch(/^market-research:mq-1:/);
    expect(item.summary).toContain("proof of adoption");
    expect(item.metadata.kind).toBe("market_research_summary");
    expect(item.metadata.resultUrls).toEqual([
      "https://example.com/case-studies",
      "https://example.com/proof"
    ]);
    expect(item.text).toContain("Query: What changed in payroll software buying behavior?");
    expect(item.text).toContain("Buyers increasingly ask for proof of live implementation.");
    expect(item.rawPayload).toMatchObject({
      query: {
        id: "mq-1"
      }
    });
  });

  it("skips unchanged result sets before summary generation", async () => {
    const firstLlmClient = {
      generateStructured: vi.fn(async () => ({
        output: {
          title: "Proof matters",
          summary: "Summary",
          keyFindings: [{ claim: "Claim", supportingResultIndices: [0] }]
        },
        usage: {
          mode: "provider" as const,
          promptTokens: 10,
          completionTokens: 5,
          estimatedCostUsd: 0.01
        },
        mode: "provider" as const
      }))
    } as any;

    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        json: async () => ({
          results: [
            {
              title: "Result A",
              url: "https://example.com/a",
              content: "Evidence A"
            }
          ]
        })
      }) as Response
    );

    const first = await runMarketResearch({
      companyId: "company-1",
      marketQueries: [baseQuery],
      doctrineMarkdown: "Doctrine",
      runtimeConfig,
      now: new Date("2026-03-14T10:00:00.000Z"),
      llmClient: firstLlmClient,
      tavilyApiKey: "test-key",
      findExistingSourceItem: vi.fn(async () => null),
      fetchImpl
    });

    const existingItem = first.items[0]!;
    const secondLlmClient = {
      generateStructured: vi.fn(async () => {
        throw new Error("LLM should not be called for unchanged market research");
      })
    } as any;

    const second = await runMarketResearch({
      companyId: "company-1",
      marketQueries: [baseQuery],
      doctrineMarkdown: "Doctrine",
      runtimeConfig,
      now: new Date("2026-03-14T10:05:00.000Z"),
      llmClient: secondLlmClient,
      tavilyApiKey: "test-key",
      findExistingSourceItem: vi.fn(async () => ({
        fingerprint: existingItem.sourceFingerprint
      })),
      fetchImpl
    });

    expect(second.items).toHaveLength(0);
    expect(second.skippedUnchanged).toBe(1);
  });

  it("keeps the result-set hash stable when Tavily order and whitespace change", async () => {
    const llmClient = {
      generateStructured: vi.fn(async () => ({
        output: {
          title: "Stable",
          summary: "Stable",
          keyFindings: [{ claim: "Stable", supportingResultIndices: [0] }]
        },
        usage: {
          mode: "provider" as const,
          promptTokens: 10,
          completionTokens: 5,
          estimatedCostUsd: 0.01
        },
        mode: "provider" as const
      }))
    } as any;

    const first = await runMarketResearch({
      companyId: "company-1",
      marketQueries: [baseQuery],
      doctrineMarkdown: "Doctrine",
      runtimeConfig,
      now: new Date("2026-03-14T10:00:00.000Z"),
      llmClient,
      tavilyApiKey: "test-key",
      findExistingSourceItem: vi.fn(async () => null),
      fetchImpl: vi.fn(async () =>
        ({
          ok: true,
          json: async () => ({
            results: [
              { title: "Alpha", url: "https://example.com/a", content: "One" },
              { title: "Beta", url: "https://example.com/b", content: "Two" }
            ]
          })
        }) as Response
      )
    });

    const second = await runMarketResearch({
      companyId: "company-1",
      marketQueries: [baseQuery],
      doctrineMarkdown: "Doctrine",
      runtimeConfig,
      now: new Date("2026-03-14T10:00:00.000Z"),
      llmClient,
      tavilyApiKey: "test-key",
      findExistingSourceItem: vi.fn(async () => null),
      fetchImpl: vi.fn(async () =>
        ({
          ok: true,
          json: async () => ({
            results: [
              { title: "  Beta ", url: "https://example.com/b", content: " Two " },
              { title: "Alpha", url: "https://example.com/a#note", content: "One" }
            ]
          })
        }) as Response
      )
    });

    expect(first.items[0]?.sourceItemId).toBe(second.items[0]?.sourceItemId);
    expect(first.items[0]?.sourceFingerprint).toBe(second.items[0]?.sourceFingerprint);
  });

  it("creates no source item when Tavily yields no usable results", async () => {
    const llmClient = {
      generateStructured: vi.fn(async () => {
        throw new Error("LLM should not run for empty results");
      })
    } as any;

    const result = await runMarketResearch({
      companyId: "company-1",
      marketQueries: [baseQuery],
      doctrineMarkdown: "Doctrine",
      runtimeConfig,
      now: new Date("2026-03-14T10:00:00.000Z"),
      llmClient,
      tavilyApiKey: "test-key",
      findExistingSourceItem: vi.fn(async () => null),
      fetchImpl: vi.fn(async () =>
        ({
          ok: true,
          json: async () => ({
            results: [
              { title: "", url: "", content: " " }
            ]
          })
        }) as Response
      )
    });

    expect(result.items).toHaveLength(0);
    expect(result.skippedEmpty).toBe(1);
  });

  it("retries Tavily 429 and 500 responses before succeeding", async () => {
    const llmClient = {
      generateStructured: vi.fn(async () => ({
        output: {
          title: "Recovered after retries",
          summary: "Summary",
          keyFindings: [{ claim: "Claim", supportingResultIndices: [0] }]
        },
        usage: {
          mode: "provider" as const,
          promptTokens: 10,
          completionTokens: 5,
          estimatedCostUsd: 0.01
        },
        mode: "provider" as const
      }))
    } as any;

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              title: "Recovered result",
              url: "https://example.com/recovered",
              content: "Recovered snippet"
            }
          ]
        })
      } as Response);

    const result = await runMarketResearch({
      companyId: "company-1",
      marketQueries: [baseQuery],
      doctrineMarkdown: "Doctrine",
      runtimeConfig: {
        ...runtimeConfig,
        rateLimit: {
          ...runtimeConfig.rateLimit,
          maxRetries: 2
        }
      },
      now: new Date("2026-03-14T10:00:00.000Z"),
      llmClient,
      tavilyApiKey: "test-key",
      findExistingSourceItem: vi.fn(async () => null),
      fetchImpl: fetchImpl as typeof fetch
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.items).toHaveLength(1);
  });

  it("drops invalid key findings and falls back when none remain grounded", async () => {
    const llmClient = {
      generateStructured: vi
        .fn()
        .mockResolvedValueOnce({
          output: {
            title: "Mixed grounding",
            summary: "Summary",
            keyFindings: [
              { claim: "Ungrounded claim", supportingResultIndices: [99] },
              { claim: "Grounded claim", supportingResultIndices: [0, 999] }
            ]
          },
          usage: {
            mode: "provider" as const,
            promptTokens: 10,
            completionTokens: 5,
            estimatedCostUsd: 0.01
          },
          mode: "provider" as const
        })
        .mockResolvedValueOnce({
          output: {
            title: "All invalid",
            summary: "Summary",
            keyFindings: [
              { claim: "Still ungrounded", supportingResultIndices: [50] }
            ]
          },
          usage: {
            mode: "provider" as const,
            promptTokens: 10,
            completionTokens: 5,
            estimatedCostUsd: 0.01
          },
          mode: "provider" as const
        })
    } as any;

    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        json: async () => ({
          results: [
            {
              title: "Grounded result",
              url: "https://example.com/grounded",
              content: "Grounded snippet"
            }
          ]
        })
      }) as Response
    );

    const mixed = await runMarketResearch({
      companyId: "company-1",
      marketQueries: [baseQuery],
      doctrineMarkdown: "Doctrine",
      runtimeConfig,
      now: new Date("2026-03-14T10:00:00.000Z"),
      llmClient,
      tavilyApiKey: "test-key",
      findExistingSourceItem: vi.fn(async () => null),
      fetchImpl
    });

    expect(mixed.items[0]?.text).toContain("Grounded claim");
    expect(mixed.items[0]?.text).not.toContain("Ungrounded claim");

    const fallback = await runMarketResearch({
      companyId: "company-1",
      marketQueries: [baseQuery],
      doctrineMarkdown: "Doctrine",
      runtimeConfig,
      now: new Date("2026-03-14T10:00:00.000Z"),
      llmClient,
      tavilyApiKey: "test-key",
      findExistingSourceItem: vi.fn(async () => null),
      fetchImpl
    });

    expect(fallback.items[0]?.text).toContain("Grounded snippet");
    expect(fallback.items[0]?.text).not.toContain("Still ungrounded");
  });
});

describe("connector regression", () => {
  it("keeps market research out of the generic connector config path", async () => {
    const configs = await loadConnectorConfigs();
    expect(configs.map((config) => config.source)).not.toContain("market-research");
  });
});
