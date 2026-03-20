import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockLoadConnectorConfigs,
  mockLoadDoctrineMarkdown,
  mockCreateConnectorRegistry
} = vi.hoisted(() => ({
  mockLoadConnectorConfigs: vi.fn(),
  mockLoadDoctrineMarkdown: vi.fn(),
  mockCreateConnectorRegistry: vi.fn()
}));

vi.mock("../src/config/loaders.js", () => ({
  loadConnectorConfigs: mockLoadConnectorConfigs,
  loadDoctrineMarkdown: mockLoadDoctrineMarkdown,
  loadMarketResearchRuntimeConfig: vi.fn()
}));

vi.mock("../src/connectors/index.js", () => ({
  createConnectorRegistry: mockCreateConnectorRegistry
}));

vi.mock("../src/services/convergence.js", () => ({
  ensureConvergenceFoundation: vi.fn(async () => ({
    id: "company-1",
    slug: "default",
    name: "Default Company"
  }))
}));

import { EditorialSignalEngineApp } from "../src/app.js";

const COMPANY_ID = "company-1";

function buildEnv() {
  return {
    DATABASE_URL: "",
    NOTION_TOKEN: "",
    NOTION_PARENT_PAGE_ID: "parent-page",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    TAVILY_API_KEY: "",
    CLAAP_API_KEY: "",
    LINEAR_API_KEY: "",
    DEFAULT_TIMEZONE: "Europe/Paris",
    DEFAULT_COMPANY_SLUG: "default",
    DEFAULT_COMPANY_NAME: "Default Company",
    INTELLIGENCE_LLM_PROVIDER: "openai" as const,
    INTELLIGENCE_LLM_MODEL: "gpt-4.1-mini",
    DRAFT_LLM_PROVIDER: "openai" as const,
    DRAFT_LLM_MODEL: "gpt-5",
    LLM_MODEL: "gpt-4.1-mini",
    LLM_TIMEOUT_MS: 100,
    HTTP_PORT: 3000,
    LOG_LEVEL: "info",
    NOTION_TONE_OF_VOICE_DB_ID: ""
  };
}

function buildRegistry(normalizedItem: Record<string, unknown>) {
  return {
    claap: {
      source: "claap",
      fetchSince: vi.fn().mockResolvedValue([{
        id: "rec-1",
        cursor: "2026-03-19T10:00:00.000Z",
        payload: {}
      }]),
      normalize: vi.fn().mockResolvedValue(normalizedItem)
    }
  };
}

function buildAppDeps(storedItemOverrides: Record<string, unknown> = {}) {
  const repositories = {
    getCompanyBySlug: vi.fn().mockResolvedValue({ id: COMPANY_ID, slug: "default", name: "Default Company" }),
    createSyncRun: vi.fn().mockResolvedValue(undefined),
    getCursor: vi.fn().mockResolvedValue(null),
    upsertSourceItem: vi.fn().mockResolvedValue({
      id: "si-claap-1",
      source: "claap",
      title: "Stored Claap item",
      sourceUrl: "https://app.claap.io/rec-1",
      occurredAt: new Date("2026-03-19T10:00:00.000Z"),
      notionPageId: null,
      notionPageFingerprint: null,
      ...storedItemOverrides
    }),
    setCursor: vi.fn().mockResolvedValue(undefined),
    updateSourceItemNotionSync: vi.fn().mockResolvedValue(undefined),
    updateSyncRun: vi.fn().mockResolvedValue(undefined),
    addCostEntries: vi.fn().mockResolvedValue(undefined),
    updateSyncRunNotionSync: vi.fn().mockResolvedValue(undefined)
  };

  const notion = {
    isEnabled: () => true,
    syncClaapReviewItem: vi.fn().mockResolvedValue({ notionPageId: "review-page-1", action: "created" }),
    archiveClaapReviewItem: vi.fn().mockResolvedValue(undefined),
    syncRun: vi.fn().mockResolvedValue(null)
  };

  return { repositories, notion };
}

describe("ingest Claap review queue sync", () => {
  beforeEach(() => {
    mockLoadConnectorConfigs.mockReset();
    mockLoadDoctrineMarkdown.mockReset();
    mockCreateConnectorRegistry.mockReset();

    mockLoadConnectorConfigs.mockResolvedValue([{
      source: "claap",
      enabled: true,
      storeRawText: true,
      retentionDays: 180,
      rateLimit: { requestsPerMinute: 120, maxRetries: 0, initialDelayMs: 0 },
      workspaceIds: ["ws-1"],
      folderIds: [],
      maxRecordingsPerRun: 50
    }]);
    mockLoadDoctrineMarkdown.mockResolvedValue("## Doctrine");
  });

  it("creates or updates a Claap review page for a blocked ingested item", async () => {
    const normalizedItem = {
      source: "claap",
      sourceItemId: "rec-1",
      externalId: "claap:rec-1",
      sourceFingerprint: "fp-1",
      sourceUrl: "https://app.claap.io/rec-1",
      title: "Signal détecté",
      text: "Transcript",
      summary: "Summary",
      occurredAt: "2026-03-19T10:00:00.000Z",
      ingestedAt: "2026-03-19T12:00:00.000Z",
      metadata: {
        publishabilityRisk: "reframeable",
        reframingSuggestion: "Lead with the validated result",
        reviewTitle: "Signal détecté",
        reviewSummary: "Le client valide le résultat mais la formulation actuelle insiste sur un doute produit.",
        reviewExcerpts: [
          "On a eu un doute au début sur la traçabilité.",
          "Après test, le calcul était bon."
        ],
        reviewWhyBlocked: "Blocked as reframeable because the current wording still foregrounds the doubt."
      },
      rawPayload: {}
    };
    const registry = buildRegistry(normalizedItem);
    mockCreateConnectorRegistry.mockReturnValue(registry);

    const { repositories, notion } = buildAppDeps();
    const app = new EditorialSignalEngineApp(buildEnv(), { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, {
      prisma: {} as any,
      repositories: repositories as any,
      notion: notion as any
    });

    await app.run("ingest:run");

    expect(notion.syncClaapReviewItem).toHaveBeenCalledWith(expect.objectContaining({
      signalTitle: "Signal détecté",
      publishabilityRisk: "reframeable",
      originalSignalSummary: "Le client valide le résultat mais la formulation actuelle insiste sur un doute produit.",
      keyExcerpts: [
        "On a eu un doute au début sur la traçabilité.",
        "Après test, le calcul était bon."
      ],
      whyBlocked: "Blocked as reframeable because the current wording still foregrounds the doubt.",
      reframingSuggestion: "Lead with the validated result",
      transcriptLink: "https://app.claap.io/rec-1",
      claapSourceItemId: "si-claap-1"
    }));
    expect(repositories.updateSourceItemNotionSync).toHaveBeenCalledWith(
      "si-claap-1",
      "review-page-1",
      expect.any(String)
    );
  });

  it("archives an existing Claap review page when the ingested item is safe", async () => {
    const normalizedItem = {
      source: "claap",
      sourceItemId: "rec-1",
      externalId: "claap:rec-1",
      sourceFingerprint: "fp-1",
      sourceUrl: "https://app.claap.io/rec-1",
      title: "Happy customer call",
      text: "Transcript",
      summary: "Summary",
      occurredAt: "2026-03-19T10:00:00.000Z",
      ingestedAt: "2026-03-19T12:00:00.000Z",
      metadata: {
        publishabilityRisk: "safe"
      },
      rawPayload: {}
    };
    const registry = buildRegistry(normalizedItem);
    mockCreateConnectorRegistry.mockReturnValue(registry);

    const { repositories, notion } = buildAppDeps({
      notionPageId: "review-page-existing",
      notionPageFingerprint: "claap-review-fp-1"
    });
    const app = new EditorialSignalEngineApp(buildEnv(), { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, {
      prisma: {} as any,
      repositories: repositories as any,
      notion: notion as any
    });

    await app.run("ingest:run");

    expect(notion.archiveClaapReviewItem).toHaveBeenCalledWith("review-page-existing");
    expect(notion.syncClaapReviewItem).not.toHaveBeenCalled();
  });
});
