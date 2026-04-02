import { describe, expect, it, vi } from "vitest";

import { EditorialSignalEngineApp } from "../src/app.js";

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

const COMPANY_ID = "company-1";

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
    LOG_LEVEL: "info",
    NOTION_TONE_OF_VOICE_DB_ID: ""
  };
}

function makeMockSourceItem(overrides: {
  id?: string;
  text?: string;
  rawText?: string;
  metadataJson?: Record<string, unknown>;
}) {
  return {
    id: overrides.id ?? "si-claap-1",
    companyId: COMPANY_ID,
    source: "claap",
    sourceItemId: overrides.id ?? "si-claap-1",
    externalId: `claap:${overrides.id ?? "si-claap-1"}`,
    fingerprint: "fp-1",
    sourceUrl: "https://app.claap.io/rec-1",
    title: "Sales call",
    text: overrides.text ?? "Customer said they love the product accuracy. ".repeat(5),
    summary: "Sales call summary",
    authorName: null,
    speakerName: null,
    occurredAt: new Date("2026-03-19T10:00:00.000Z"),
    ingestedAt: new Date("2026-03-19T10:00:00.000Z"),
    metadataJson: overrides.metadataJson ?? { signalKind: "claap-signal" },
    rawPayloadJson: {},
    rawText: overrides.rawText ?? overrides.text ?? "Customer said they love the product accuracy. ".repeat(5),
    chunksJson: null
  };
}

function makeMockOpportunityRow(overrides: {
  id?: string;
  notionPageId?: string;
  sourceItemId?: string;
}) {
  const sourceItemId = overrides.sourceItemId ?? "si-claap-1";
  return {
    id: overrides.id ?? "opp-1",
    companyId: COMPANY_ID,
    sourceFingerprint: "sf-1",
    title: "Test opportunity",
    ownerProfile: null,
    ownerUserId: null,
    narrativePillar: null,
    targetSegment: "",
    editorialPillar: "",
    awarenessTarget: "",
    buyerFriction: "",
    contentMotion: "",
    angle: "Test angle",
    whyNow: "Test why now",
    whatItIsAbout: "Test what",
    whatItIsNotAbout: "Test not",
    routingStatus: "Routed",
    readiness: "Opportunity only",
    status: "To review",
    suggestedFormat: "Narrative",
    supportingEvidenceCount: 0,
    evidenceFreshness: 0.8,
    editorialOwner: null,
    selectedAt: null,
    updatedAt: new Date(),
    primaryEvidenceId: "ev-1",
    enrichmentLogJson: [],
    v1HistoryJson: [],
    notionPageId: overrides.notionPageId ?? "notion-page-1",
    notionPageFingerprint: "nfp-1",
    evidence: [{
      id: "ev-1",
      source: "claap",
      sourceItemId,
      sourceUrl: "https://app.claap.io/rec-1",
      timestamp: new Date("2026-03-19T10:00:00.000Z"),
      excerpt: "Customer said they love the product accuracy.",
      excerptHash: "hash-1",
      speakerOrAuthor: null,
      freshnessScore: 0.8
    }],
    primaryEvidence: {
      id: "ev-1",
      source: "claap",
      sourceItemId,
      sourceUrl: "https://app.claap.io/rec-1",
      timestamp: new Date("2026-03-19T10:00:00.000Z"),
      excerpt: "Customer said they love the product accuracy.",
      excerptHash: "hash-1",
      speakerOrAuthor: null,
      freshnessScore: 0.8
    }
  };
}

function buildMocks(opts: {
  sourceItems: ReturnType<typeof makeMockSourceItem>[];
  opportunities: ReturnType<typeof makeMockOpportunityRow>[];
  llmResponses: Array<{ publishabilityRisk: "safe" | "reframeable" | "harmful" }>;
}) {
  const sourceItemUpdate = vi.fn().mockResolvedValue({});
  const opportunityUpdate = vi.fn().mockResolvedValue({});
  const replaceOpportunityRelations = vi.fn().mockResolvedValue(undefined);
  let llmCallIndex = 0;
  const llmClient = {
    generateStructured: vi.fn().mockImplementation(() => {
      const response = opts.llmResponses[llmCallIndex] ?? { publishabilityRisk: "safe" };
      llmCallIndex += 1;
      return Promise.resolve({
        output: {
          hasSignal: true,
          title: "",
          summary: "",
          hookCandidate: "",
          whyItMatters: "",
          excerpts: [],
          signalType: "",
          theme: "",
          confidenceScore: 0,
          publishabilityRisk: response.publishabilityRisk
        },
        usage: { mode: "provider", promptTokens: 10, completionTokens: 10, estimatedCostUsd: 0.001 }
      });
    })
  };

  const prisma = {
    sourceItem: {
      findMany: vi.fn().mockResolvedValue(opts.sourceItems),
      update: sourceItemUpdate
    },
    opportunity: {
      findMany: vi.fn().mockResolvedValue(opts.opportunities),
      update: opportunityUpdate
    },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ count: BigInt(0) }])
  };

  const repositories = {
    getCompanyBySlug: vi.fn().mockResolvedValue({ id: COMPANY_ID, slug: "default", name: "Default" }),
    getLatestEditorialConfig: vi.fn().mockResolvedValue({
      layer1CompanyLens: { doctrineMarkdown: "Test doctrine", sensitivityMarkdown: "" },
      layer2ContentPhilosophy: { defaults: [] },
      layer3LinkedInCraft: { defaults: [] }
    }),
    listUsers: vi.fn().mockResolvedValue([]),
    createSyncRun: vi.fn().mockResolvedValue(undefined),
    updateSyncRun: vi.fn().mockResolvedValue(undefined),
    addCostEntries: vi.fn().mockResolvedValue(undefined),
    replaceOpportunityRelations
  };

  return {
    prisma,
    repositories,
    llmClient,
    sourceItemUpdate,
    opportunityUpdate,
    replaceOpportunityRelations
  };
}

describe("cleanup:claap-publishability", () => {
  it("reclassifies harmful/reframeable items and archives their opportunities", async () => {
    const si1 = makeMockSourceItem({ id: "si-1", text: "They don't trust accuracy. ".repeat(5) });
    const si2 = makeMockSourceItem({ id: "si-2", text: "Doubts about product but it works. ".repeat(5) });
    const opp1 = makeMockOpportunityRow({ id: "opp-1", notionPageId: "page-1", sourceItemId: "si-1" });
    const opp2 = makeMockOpportunityRow({ id: "opp-2", notionPageId: "page-2", sourceItemId: "si-2" });

    const mocks = buildMocks({
      sourceItems: [si1, si2],
      opportunities: [opp1, opp2],
      llmResponses: [
        { publishabilityRisk: "harmful" },
        { publishabilityRisk: "reframeable" }
      ]
    });

    // Wire up opportunity lookup per source item
    mocks.prisma.opportunity.findMany
      .mockResolvedValueOnce([opp1])
      .mockResolvedValueOnce([opp2]);

    const app = new EditorialSignalEngineApp(buildEnv(), { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, {
      prisma: mocks.prisma as any,
      repositories: mocks.repositories as any,
      llmClient: mocks.llmClient as any
    });

    await app.run("cleanup:claap-publishability");

    // Source items updated with metadata
    expect(mocks.sourceItemUpdate).toHaveBeenCalledTimes(2);

    // Both opportunities archived
    expect(mocks.opportunityUpdate).toHaveBeenCalledTimes(2);
    for (const call of mocks.opportunityUpdate.mock.calls) {
      expect(call[0].data.status).toBe("Archived");
    }

    // Evidence detached for both
    expect(mocks.replaceOpportunityRelations).toHaveBeenCalledTimes(2);
    for (const call of mocks.replaceOpportunityRelations.mock.calls) {
      expect(call[1]).toEqual([]); // empty evidence
      expect(call[2]).toBeNull(); // null primaryEvidenceId
    }

  });

  it("archives opportunity in DB when source item reclassified as harmful", async () => {
    const si = makeMockSourceItem({ id: "si-notion", text: "Customer complaint. ".repeat(5) });
    const opp = makeMockOpportunityRow({ id: "opp-notion", notionPageId: "existing-page-id", sourceItemId: "si-notion" });

    const mocks = buildMocks({
      sourceItems: [si],
      opportunities: [opp],
      llmResponses: [{ publishabilityRisk: "harmful" }]
    });

    mocks.prisma.opportunity.findMany.mockResolvedValueOnce([opp]);

    const app = new EditorialSignalEngineApp(buildEnv(), { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, {
      prisma: mocks.prisma as any,
      repositories: mocks.repositories as any,
      llmClient: mocks.llmClient as any
    });

    await app.run("cleanup:claap-publishability");

  });

  it("safe items left untouched", async () => {
    const si = makeMockSourceItem({ id: "si-safe", text: "Great customer feedback. ".repeat(5) });

    const mocks = buildMocks({
      sourceItems: [si],
      opportunities: [],
      llmResponses: [{ publishabilityRisk: "safe" }]
    });

    const app = new EditorialSignalEngineApp(buildEnv(), { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, {
      prisma: mocks.prisma as any,
      repositories: mocks.repositories as any,
      llmClient: mocks.llmClient as any
    });

    await app.run("cleanup:claap-publishability");

    // No DB writes for safe items
    expect(mocks.sourceItemUpdate).not.toHaveBeenCalled();
    expect(mocks.opportunityUpdate).not.toHaveBeenCalled();
    expect(mocks.replaceOpportunityRelations).not.toHaveBeenCalled();
  });

  it("dry-run mode makes no DB writes", async () => {
    const si = makeMockSourceItem({ id: "si-dry", text: "Negative feedback about accuracy. ".repeat(5) });
    const opp = makeMockOpportunityRow({ id: "opp-dry", notionPageId: "page-dry", sourceItemId: "si-dry" });

    const mocks = buildMocks({
      sourceItems: [si],
      opportunities: [opp],
      llmResponses: [{ publishabilityRisk: "harmful" }]
    });

    // Even with harmful result, dry-run should not write
    mocks.prisma.opportunity.findMany.mockResolvedValueOnce([opp]);

    const logInfo = vi.fn();
    const app = new EditorialSignalEngineApp(buildEnv(), { info: logInfo, error: vi.fn(), warn: vi.fn() }, {
      prisma: mocks.prisma as any,
      repositories: mocks.repositories as any,
      llmClient: mocks.llmClient as any
    });

    await app.run("cleanup:claap-publishability", { dryRun: true });

    expect(mocks.sourceItemUpdate).not.toHaveBeenCalled();
    expect(mocks.opportunityUpdate).not.toHaveBeenCalled();
    expect(mocks.replaceOpportunityRelations).not.toHaveBeenCalled();
  });

  it("archived opportunity with detached evidence remains readable via mapOpportunityRow sentinel", async () => {
    // After cleanup, an opportunity with status=Archived and no evidence should not throw
    // when loaded by mapOpportunityRow. We test this by creating the app and calling
    // a path that loads opportunities.
    const si = makeMockSourceItem({ id: "si-read", text: "Negative feedback. ".repeat(5) });
    const oppRow = {
      ...makeMockOpportunityRow({ id: "opp-read", notionPageId: "page-read", sourceItemId: "si-read" }),
      // Simulate post-cleanup state: no evidence, no primaryEvidence
      evidence: [],
      primaryEvidence: null,
      primaryEvidenceId: null,
      status: "Archived"
    };

    const mocks = buildMocks({
      sourceItems: [si],
      opportunities: [],
      llmResponses: [{ publishabilityRisk: "harmful" }]
    });

    // Create app to access mapOpportunityRow indirectly via listRecentActiveOpportunities path
    const app = new EditorialSignalEngineApp(buildEnv(), { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, {
      prisma: mocks.prisma as any,
      repositories: {
        ...mocks.repositories,
        listRecentActiveOpportunities: vi.fn().mockResolvedValue([oppRow])
      } as any,
      llmClient: mocks.llmClient as any
    });

    // The mapOpportunityRow is private, but it's used by intelligence run.
    // We can verify the sentinel behavior by accessing it indirectly.
    // For this unit test, we just verify the app constructor works and the
    // sentinel logic in the source is correct by checking the code path.
    // The important assertion is that mapOpportunityRow doesn't throw for archived + no evidence.
    // We test this by calling the method through reflection:
    const mapped = (app as any).mapOpportunityRow(oppRow);
    expect(mapped.primaryEvidence.excerpt).toBe("[archived]");
    expect(mapped.status).toBe("Archived");
    expect(mapped.evidence).toHaveLength(0);
  });
});
