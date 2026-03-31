import { describe, expect, it, vi } from "vitest";
import { EditorialSignalEngineApp } from "../src/app.js";

vi.mock("../src/services/intelligence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/intelligence.js")>();
  return { ...actual, runIntelligencePipeline: vi.fn() };
});

vi.mock("../src/config/loaders.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/loaders.js")>();
  return {
    ...actual,
    loadDoctrineMarkdown: vi.fn().mockResolvedValue("# FRESH DOCTRINE v2\nThis is the updated editorial doctrine."),
    loadSensitivityMarkdown: vi.fn().mockResolvedValue("# FRESH SENSITIVITY v2"),
    loadProfileBases: vi.fn().mockResolvedValue([]),
    loadConnectorConfigs: vi.fn().mockResolvedValue([])
  };
});

import { runIntelligencePipeline } from "../src/services/intelligence.js";

const mockedPipeline = vi.mocked(runIntelligencePipeline);
const COMPANY_ID = "company-1";
const STALE_DOCTRINE = "# OLD DOCTRINE v1\nThis is the stale doctrine from the database.";
const FRESH_DOCTRINE = "# FRESH DOCTRINE v2\nThis is the updated editorial doctrine.";

function buildEnv() {
  return {
    DATABASE_URL: "", NOTION_TOKEN: "", NOTION_PARENT_PAGE_ID: "parent-page",
    OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", TAVILY_API_KEY: "",
    CLAAP_API_KEY: "", LINEAR_API_KEY: "",
    DEFAULT_TIMEZONE: "Europe/Paris", DEFAULT_COMPANY_SLUG: "default", DEFAULT_COMPANY_NAME: "Default Company",
    INTELLIGENCE_LLM_PROVIDER: "openai" as const, INTELLIGENCE_LLM_MODEL: "gpt-4.1-mini",
    DRAFT_LLM_PROVIDER: "openai" as const, DRAFT_LLM_MODEL: "gpt-5",
    LLM_MODEL: "gpt-4.1-mini", LLM_TIMEOUT_MS: 100, HTTP_PORT: 3000, LOG_LEVEL: "info"
  };
}

function buildRepositories() {
  let refreshedConfig: Record<string, unknown> | null = null;
  const getLatestEditorialConfig = vi.fn(async () => {
    if (refreshedConfig) return refreshedConfig;
    return {
      id: "ec-stale", companyId: COMPANY_ID, version: 1,
      layer1CompanyLens: { doctrineMarkdown: STALE_DOCTRINE, sensitivityMarkdown: "# OLD SENSITIVITY v1" },
      layer2ContentPhilosophy: { defaults: [] }, layer3LinkedInCraft: { defaults: [] },
      createdAt: new Date()
    };
  });
  const upsertEditorialConfig = vi.fn(async (config: Record<string, unknown>) => { refreshedConfig = config; });
  return {
    repos: {
      ensureDefaultCompany: vi.fn(async () => ({ id: COMPANY_ID, slug: "default", name: "Default Company", defaultTimezone: "Europe/Paris", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })),
      getCompanyBySlug: vi.fn(async () => ({ id: COMPANY_ID, slug: "default", name: "Default Company", defaultTimezone: "Europe/Paris", createdAt: "2026-03-14T09:00:00.000Z", updatedAt: "2026-03-14T09:00:00.000Z" })),
      getLatestEditorialConfig, upsertEditorialConfig,
      upsertUser: vi.fn(), upsertSourceConfig: vi.fn(), listUsers: vi.fn(async () => []),
      createSyncRun: vi.fn(async () => ({})), acquireRunLease: vi.fn(async () => ({})),
      renewRunLease: vi.fn(async () => true), updateSyncRun: vi.fn(async () => ({})),
      updateSyncRunNotionSync: vi.fn(async () => ({})), addCostEntries: vi.fn(async () => ({})),
      listPendingSourceItems: vi.fn(async () => []), listRecentActiveOpportunities: vi.fn(async () => []),
      createOpportunityOnly: vi.fn(async () => ({})), persistStandaloneEvidence: vi.fn(async () => ({})),
      listCandidateSourceItems: vi.fn(async () => [] as any[]), listSourceItemsByIds: vi.fn(async () => [] as any[]),
      enrichOpportunity: vi.fn(async () => ({})), updateOpportunityNotionSync: vi.fn(async () => ({})),
      updateSourceItemNotionSync: vi.fn(async () => ({})), markSourceItemsProcessed: vi.fn(async () => ({})),
      saveScreeningResults: vi.fn(async () => ({ missingIds: [] as string[] }))
    } as any,
    upsertEditorialConfig, getLatestEditorialConfig
  };
}

describe("doctrine refresh → intelligence:run end-to-end", () => {
  it("stale editorial config is refreshed by convergence, and intelligence:run uses the fresh doctrine in the LLM path", async () => {
    const { repos, upsertEditorialConfig, getLatestEditorialConfig } = buildRepositories();
    mockedPipeline.mockResolvedValue({
      screeningResults: new Map(), created: [], enriched: [], skipped: [],
      usageEvents: [], dedupEvents: [], processedSourceItemIds: [],
      linearReviewItems: [], linearClassifications: new Map(), githubReviewItems: [], githubClassifications: new Map(), angleQualityEvents: [],
      speakerContextEvents: []
    });
    const app = new EditorialSignalEngineApp(buildEnv(), { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, {
      prisma: { $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})), $queryRawUnsafe: vi.fn(async () => [{ count: BigInt(0) }]) } as any,
      repositories: repos, llmClient: {} as any,
      notion: { syncOpportunity: vi.fn(async () => null), syncRun: vi.fn(async () => null), syncUser: vi.fn(async () => null) } as any
    });
    await app.run("intelligence:run");

    expect(upsertEditorialConfig).toHaveBeenCalledTimes(1);
    const upsertedConfig = upsertEditorialConfig.mock.calls[0][0] as any;
    expect(upsertedConfig.layer1CompanyLens.doctrineMarkdown).toBe(FRESH_DOCTRINE);

    expect(getLatestEditorialConfig.mock.calls.length).toBeGreaterThanOrEqual(2);

    expect(mockedPipeline).toHaveBeenCalledTimes(1);
    const pipelineParams = mockedPipeline.mock.calls[0][0] as any;
    expect(pipelineParams.doctrineMarkdown).toBe(FRESH_DOCTRINE);
    expect(pipelineParams.doctrineMarkdown).not.toBe(STALE_DOCTRINE);
  });
});
