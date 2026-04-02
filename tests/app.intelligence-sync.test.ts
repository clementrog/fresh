import { describe, expect, it, vi } from "vitest";

import { EditorialSignalEngineApp } from "../src/app.js";

vi.mock("../src/services/intelligence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/intelligence.js")>();
  return {
    ...actual,
    runIntelligencePipeline: vi.fn()
  };
});

vi.mock("../src/services/convergence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/convergence.js")>();
  return {
    ...actual,
    ensureConvergenceFoundation: vi.fn(async () => ({
      id: "company-1",
      slug: "default",
      name: "Default Company"
    }))
  };
});

import { runIntelligencePipeline } from "../src/services/intelligence.js";

const mockedPipeline = vi.mocked(runIntelligencePipeline);

function buildEnv() {
  return {
    DATABASE_URL: "",
    NOTION_TOKEN: "",
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
    LLM_MODEL: "gpt-5.4-mini",
    NANO_LLM_PROVIDER: "openai" as const,
    NANO_LLM_MODEL: "gpt-5.4-nano",
    LLM_TIMEOUT_MS: 100,
    HTTP_PORT: 3000,
    LOG_LEVEL: "info"
  };
}

const COMPANY_ID = "company-1";

function buildRepositories() {
  return {
    getCompanyBySlug: vi.fn(async () => ({
      id: COMPANY_ID,
      slug: "default",
      name: "Default Company",
      defaultTimezone: "Europe/Paris",
      createdAt: "2026-03-14T09:00:00.000Z",
      updatedAt: "2026-03-14T09:00:00.000Z"
    })),
    createSyncRun: vi.fn(async () => ({})),
    acquireRunLease: vi.fn(async () => ({})),
    renewRunLease: vi.fn(async () => true),
    updateSyncRun: vi.fn(async () => ({})),
    addCostEntries: vi.fn(async () => ({})),
    getLatestEditorialConfig: vi.fn(async () => ({
      layer1CompanyLens: { doctrineMarkdown: "", sensitivityMarkdown: "" },
      layer2ContentPhilosophy: { defaults: [] },
      layer3LinkedInCraft: { defaults: [] }
    })),
    listUsers: vi.fn(async () => []),
    listPendingSourceItems: vi.fn(async () => []),
    listRecentActiveOpportunities: vi.fn(async () => []),
    createOpportunityOnly: vi.fn(async () => ({})),
    persistStandaloneEvidence: vi.fn(async () => ({})),
    listCandidateSourceItems: vi.fn(async () => [] as any[]),
    listSourceItemsByIds: vi.fn(async () => [] as any[]),
    enrichOpportunity: vi.fn(async () => ({})),
    markSourceItemsProcessed: vi.fn(async () => ({})),
    saveScreeningResults: vi.fn(async () => ({ missingIds: [] as string[] }))
  };
}

function buildPrisma() {
  return {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
    $queryRawUnsafe: vi.fn(async () => [{ count: BigInt(0) }])
  };
}

function buildApp(overrides: {
  repositories?: ReturnType<typeof buildRepositories>;
  prisma?: ReturnType<typeof buildPrisma>;
} = {}) {
  const repositories = overrides.repositories ?? buildRepositories();
  const prisma = overrides.prisma ?? buildPrisma();
  const app = new EditorialSignalEngineApp(
    buildEnv(),
    { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    {
      prisma: prisma as any,
      repositories: repositories as any,
      llmClient: {} as any
    }
  );
  return { app, repositories, prisma };
}

describe("intelligence sync — screening-write warnings", () => {
  it("surfaces missing-row screening writes in run warnings / SyncRun summary", async () => {
    const repositories = buildRepositories();
    repositories.saveScreeningResults.mockResolvedValue({
      missingIds: ["si_phantom_abc", "si_phantom_def"]
    });
    const { app } = buildApp({ repositories });

    const externalId = "ext-1";
    mockedPipeline.mockResolvedValue({
      screeningResults: new Map([[externalId, {
        decision: "skip" as const,
        rationale: "noise",
        createOrEnrich: "unknown" as const,
        relevanceScore: 0.2,
        sensitivityFlag: false,
        sensitivityCategories: []
      }]]),
      created: [],
      enriched: [],
      skipped: [],
      usageEvents: [],
      dedupEvents: [],
      processedSourceItemIds: [externalId],
      linearReviewItems: [],
      linearClassifications: new Map(),
      githubReviewItems: [],
      githubClassifications: new Map(),
      angleQualityEvents: [],
      speakerContextEvents: []
    });

    await app.run("intelligence:run");

    // updateSyncRun is called with the finalized run object that includes warnings
    const updateCalls = repositories.updateSyncRun.mock.calls as any[][];
    const runObjects = updateCalls.map(call => call[0]);
    const warningTexts = runObjects.flatMap((r: any) => r.warnings ?? []);
    expect(warningTexts).toContainEqual(
      expect.stringContaining("Screening write skipped 2 missing SourceItem(s)")
    );
    expect(warningTexts).toContainEqual(
      expect.stringContaining("si_phantom_abc")
    );
  });
});

describe("Layer 3 runtime normalization through load path", () => {
  it("legacy persisted Layer 3 defaults are normalized before reaching pipeline", async () => {
    mockedPipeline.mockReset();
    const repositories = buildRepositories();
    repositories.getLatestEditorialConfig.mockResolvedValue({
      layer1CompanyLens: { doctrineMarkdown: "", sensitivityMarkdown: "" },
      layer2ContentPhilosophy: { defaults: ["Specific"] },
      layer3LinkedInCraft: {
        defaults: [
          "Max 250 words. One idea per post.",
          "Write like a person, not a framework. First person mandatory.",
          "End with something worth reacting to. Not a summary.",
          "Never cite internal source systems. Transform evidence into personal observation.",
          "Vary structure across posts. Never repeat the same skeleton."
        ]
      }
    } as any);

    const { app } = buildApp({ repositories });

    mockedPipeline.mockResolvedValue({
      screeningResults: new Map(),
      created: [],
      enriched: [],
      skipped: [],
      usageEvents: [],
      dedupEvents: [],
      processedSourceItemIds: [],
      linearReviewItems: [],
      linearClassifications: new Map(),
      githubReviewItems: [],
      githubClassifications: new Map(),
      angleQualityEvents: [],
      speakerContextEvents: []
    });

    await app.run("intelligence:run");

    expect(mockedPipeline).toHaveBeenCalledTimes(1);
    const pipelineArgs = mockedPipeline.mock.calls[0][0] as unknown as Record<string, unknown>;
    const layer3 = pipelineArgs.layer3Defaults as string[];

    // Conflicting rules must be stripped
    expect(layer3.join(" ")).not.toMatch(/first\s+person\s+mandatory/i);
    expect(layer3.join(" ")).not.toMatch(/never\s+cite\s+internal\s+source/i);

    // Word count must be normalized
    expect(layer3).toContain("Target 200-250 words. One idea per post.");

    // Non-conflicting rules must be preserved
    expect(layer3).toContain("End with something worth reacting to. Not a summary.");
    expect(layer3).toContain("Vary structure across posts. Never repeat the same skeleton.");

    // Unrelated config fields must be untouched
    expect(pipelineArgs.doctrineMarkdown).toBe("");
    expect((pipelineArgs as any).layer2Defaults).toEqual(["Specific"]);
  });
});
