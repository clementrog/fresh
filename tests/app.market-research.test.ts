import { describe, expect, it, vi } from "vitest";

import { EditorialSignalEngineApp } from "../src/app.js";

function buildEnv() {
  return {
    DATABASE_URL: "",
    NOTION_TOKEN: "",
    NOTION_PARENT_PAGE_ID: "parent-page",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    TAVILY_API_KEY: "tavily-test-key",
    CLAAP_API_KEY: "",
    LINEAR_API_KEY: "",
    DEFAULT_TIMEZONE: "Europe/Paris",
    DEFAULT_COMPANY_SLUG: "default",
    DEFAULT_COMPANY_NAME: "Default Company",
    INTELLIGENCE_LLM_PROVIDER: "openai" as const,
    INTELLIGENCE_LLM_MODEL: "gpt-4.1-mini",
    DRAFT_LLM_PROVIDER: "openai" as const,
    DRAFT_LLM_MODEL: "gpt-5",
    LLM_MODEL: "gpt-5.4-mini",
    NANO_LLM_PROVIDER: "openai" as const,
    NANO_LLM_MODEL: "gpt-5.4-nano",
    LLM_TIMEOUT_MS: 100,
    HTTP_PORT: 3000,
    LOG_LEVEL: "info"
  };
}

function buildRepositories() {
  return {
    getCompanyBySlug: vi.fn(async () => ({
      id: "company-1",
      slug: "default",
      name: "Default Company",
      defaultTimezone: "Europe/Paris",
      createdAt: "2026-03-14T09:00:00.000Z",
      updatedAt: "2026-03-14T09:00:00.000Z"
    })),
    createSyncRun: vi.fn(async () => ({})),
    updateSyncRun: vi.fn(async () => ({})),
    updateSyncRunNotionSync: vi.fn(async () => ({})),
    addCostEntries: vi.fn(async () => ({})),
    getLatestEditorialConfig: vi.fn(async () => ({
      layer1CompanyLens: {
        doctrineMarkdown: "Focus on concrete buyer behavior."
      }
    })),
    listActiveMarketQueries: vi.fn(async () => ([
      {
        id: "mq-1",
        companyId: "company-1",
        query: "What changed in payroll software buying behavior?",
        enabled: true,
        priority: 1,
        createdAt: "2026-03-14T09:00:00.000Z",
        updatedAt: "2026-03-14T09:00:00.000Z"
      }
    ])),
    findSourceItemBySourceKey: vi.fn(async () => null),
    upsertSourceItem: vi.fn(async () => ({}))
  } as const;
}

describe("market research app command", () => {
  it("creates market research source items and a company-scoped sync run", async () => {
    const repositories = buildRepositories();
    const llmClient = {
      generateStructured: vi.fn(async () => ({
        output: {
          title: "Buyers want proof",
          summary: "Buyers want proof of implementation.",
          keyFindings: [{ claim: "Proof matters earlier in the cycle.", supportingResultIndices: [0] }]
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

    const app = new EditorialSignalEngineApp(
      buildEnv(),
      {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
      },
      {
        repositories: repositories as any,
        llmClient,
        notion: {
          syncRun: vi.fn(async () => null)
        } as any
      }
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      ({
        ok: true,
        json: async () => ({
          results: [
            {
              title: "Proof is the new shortlist filter",
              url: "https://example.com/proof",
              content: "Buyers now ask for implementation proof much earlier."
            }
          ]
        })
      }) as Response
    ) as typeof fetch;

    try {
      await app.run("market-research:run");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(repositories.createSyncRun).toHaveBeenCalledTimes(1);
    expect(repositories.createSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runType: "market-research:run",
        source: "market-research",
        companyId: "company-1"
      })
    );
    expect(repositories.upsertSourceItem).toHaveBeenCalledTimes(1);
    const itemArg = ((repositories.upsertSourceItem.mock.calls as unknown) as Array<[any]>)[0]?.[0];
    expect(itemArg).toMatchObject({
      source: "market-research",
      metadata: expect.objectContaining({
        kind: "market_research_summary"
      })
    });
  });

  it("skips writes and does not requeue unchanged market research", async () => {
    const repositories = buildRepositories();
    const llmClient = {
      generateStructured: vi.fn(async () => ({
        output: {
          title: "Buyers want proof",
          summary: "Buyers want proof of implementation.",
          keyFindings: [{ claim: "Proof matters earlier in the cycle.", supportingResultIndices: [0] }]
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

    const app = new EditorialSignalEngineApp(
      buildEnv(),
      {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
      },
      {
        repositories: repositories as any,
        llmClient,
        notion: {
          syncRun: vi.fn(async () => null)
        } as any
      }
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      ({
        ok: true,
        json: async () => ({
          results: [
            {
              title: "Proof is the new shortlist filter",
              url: "https://example.com/proof",
              content: "Buyers now ask for implementation proof much earlier."
            }
          ]
        })
      }) as Response
    ) as typeof fetch;

    try {
      await app.run("market-research:run");
      const firstItem = ((repositories.upsertSourceItem.mock.calls as unknown) as Array<[any]>)[0]?.[0];
      const firstFingerprint = firstItem?.sourceFingerprint as string | undefined;
      expect(firstFingerprint).toBeTruthy();
      repositories.upsertSourceItem.mockClear();
      llmClient.generateStructured.mockClear();
      repositories.findSourceItemBySourceKey.mockResolvedValue({
        fingerprint: firstFingerprint
      } as any);

      await app.run("market-research:run");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(llmClient.generateStructured).not.toHaveBeenCalled();
    expect(repositories.upsertSourceItem).not.toHaveBeenCalled();
  });
});
