import { describe, expect, it, vi } from "vitest";

import { EditorialSignalEngineApp } from "../src/app.js";
import type { RepositoryBundle } from "../src/db/repositories.js";
import type { NotionSelectionRow, SyncRun } from "../src/domain/types.js";

vi.mock("../src/services/convergence.js", () => ({
  ensureConvergenceFoundation: vi.fn(async () => ({
    id: "company-1",
    slug: "default",
    name: "Default Company"
  }))
}));

type OpportunityRow = NonNullable<Awaited<ReturnType<RepositoryBundle["findOpportunityByNotionPageId"]>>>;

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
    LOG_LEVEL: "info"
  };
}

function makeOpportunityRow(overrides: Partial<{
  id: string;
  status: string;
  editorialOwner: string | null;
}> = {}): OpportunityRow {
  const ts = new Date("2026-03-30T09:00:00.000Z");
  const evidence = {
    id: "ev-1",
    source: "notion",
    sourceItemId: "si-1",
    sourceUrl: "https://example.com",
    timestamp: ts,
    createdAt: ts,
    companyId: "company-1",
    opportunityId: "opp-1",
    draftId: null,
    excerpt: "Evidence excerpt",
    excerptHash: "hash-1",
    freshnessScore: 0.9,
    speakerOrAuthor: null
  };
  return {
    id: overrides.id ?? "opp-1",
    companyId: "company-1",
    sourceFingerprint: "sf-1",
    title: "Test opportunity",
    ownerProfile: null,
    ownerUserId: null,
    narrativePillar: "",
    targetSegment: "",
    editorialPillar: "",
    awarenessTarget: "",
    buyerFriction: "",
    contentMotion: "",
    angle: "Test angle",
    whyNow: "Reason",
    whatItIsAbout: "Topic",
    whatItIsNotAbout: "Not topic",
    routingStatus: "Routed",
    readiness: "Opportunity only",
    status: overrides.status ?? "To review",
    suggestedFormat: "article",
    supportingEvidenceCount: 0,
    evidenceFreshness: 0.9,
    editorialOwner: overrides.editorialOwner ?? null,
    editorialNotes: "",
    notionEditsPending: false,
    selectedAt: null,
    lastDigestAt: null,
    createdAt: ts,
    updatedAt: ts,
    primaryEvidenceId: "ev-1",
    enrichmentLogJson: [],
    v1HistoryJson: [],
    dedupFlag: "",
    notionPageId: "np-1",
    notionPageFingerprint: "npf-1",
    primaryEvidence: evidence,
    evidence: [],
    linkedEvidence: []
  } as unknown as OpportunityRow;
}

function buildRepositories() {
  return {
    createSyncRun: vi.fn(async () => ({})),
    updateSyncRun: vi.fn(async () => ({})),
    updateSyncRunNotionSync: vi.fn(async () => ({})),
    addCostEntries: vi.fn(async () => ({})),
    findOpportunityByNotionPageId: vi.fn<(...args: unknown[]) => Promise<OpportunityRow | null>>(async () => null),
    markOpportunitySelected: vi.fn(async () => ({}))
  };
}

function buildNotion() {
  return {
    listSelectedOpportunities: vi.fn(async () => [] as NotionSelectionRow[]),
    syncRun: vi.fn(async () => null)
  };
}

function buildApp(overrides: {
  repositories?: ReturnType<typeof buildRepositories>;
  notion?: ReturnType<typeof buildNotion>;
} = {}) {
  const repositories = overrides.repositories ?? buildRepositories();
  const notion = overrides.notion ?? buildNotion();
  const prisma = { $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})) };
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const app = new EditorialSignalEngineApp(
    buildEnv(),
    logger,
    {
      prisma: prisma as any,
      repositories: repositories as any,
      llmClient: {} as any,
      notion: notion as any
    }
  );
  return { app, repositories, notion, logger };
}

describe("selection:scan", () => {
  it("complete row marks opportunity as selected with editorial owner", async () => {
    const repositories = buildRepositories();
    const notion = buildNotion();
    const opp = makeOpportunityRow({ status: "To review" });

    notion.listSelectedOpportunities.mockResolvedValue([
      { notionPageId: "np-1", fingerprint: "npf-1", editorialOwner: "Baptiste" }
    ]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(opp);

    const { app, logger } = buildApp({ repositories, notion });
    await app.run("selection:scan", { dryRun: false, companySlug: "default" });

    expect(repositories.markOpportunitySelected).toHaveBeenCalledWith("opp-1", "Baptiste");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("empty fingerprint still marks opportunity selected and emits warning", async () => {
    const repositories = buildRepositories();
    const notion = buildNotion();
    const opp = makeOpportunityRow({ status: "To review" });

    notion.listSelectedOpportunities.mockResolvedValue([
      { notionPageId: "np-1", fingerprint: "", editorialOwner: "Baptiste" }
    ]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(opp);

    const { app, logger } = buildApp({ repositories, notion });
    await app.run("selection:scan", { dryRun: false, companySlug: "default" });

    expect(repositories.markOpportunitySelected).toHaveBeenCalledWith("opp-1", "Baptiste");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ notionPageId: "np-1", opportunityId: "opp-1" }),
      expect.stringContaining("empty fingerprint")
    );
  });

  it("empty editorial owner preserves existing DB owner", async () => {
    const repositories = buildRepositories();
    const notion = buildNotion();
    const opp = makeOpportunityRow({ status: "To review", editorialOwner: "Existing Owner" });

    notion.listSelectedOpportunities.mockResolvedValue([
      { notionPageId: "np-1", fingerprint: "npf-1", editorialOwner: "" }
    ]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(opp);

    const { app, logger } = buildApp({ repositories, notion });
    await app.run("selection:scan", { dryRun: false, companySlug: "default" });

    expect(repositories.markOpportunitySelected).toHaveBeenCalledWith("opp-1", undefined);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ notionPageId: "np-1", opportunityId: "opp-1" }),
      expect.stringContaining("empty editorial owner")
    );
  });

  it("both fields empty does not crash and emits both warnings", async () => {
    const repositories = buildRepositories();
    const notion = buildNotion();
    const opp = makeOpportunityRow({ status: "To review", editorialOwner: "Keep Me" });

    notion.listSelectedOpportunities.mockResolvedValue([
      { notionPageId: "np-1", fingerprint: "", editorialOwner: "" }
    ]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(opp);

    const { app, logger } = buildApp({ repositories, notion });
    await app.run("selection:scan", { dryRun: false, companySlug: "default" });

    expect(repositories.markOpportunitySelected).toHaveBeenCalledWith("opp-1", undefined);

    const warnMessages = logger.warn.mock.calls.map((call: unknown[]) => call[1]);
    expect(warnMessages).toContainEqual(expect.stringContaining("empty fingerprint"));
    expect(warnMessages).toContainEqual(expect.stringContaining("empty editorial owner"));
  });

  it("whitespace-only fingerprint and editorialOwner are treated as empty", async () => {
    const repositories = buildRepositories();
    const notion = buildNotion();
    const opp = makeOpportunityRow({ status: "To review", editorialOwner: "Keep Me" });

    notion.listSelectedOpportunities.mockResolvedValue([
      { notionPageId: "np-1", fingerprint: "  \t ", editorialOwner: "  \n " }
    ]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(opp);

    const { app, logger } = buildApp({ repositories, notion });
    await app.run("selection:scan", { dryRun: false, companySlug: "default" });

    expect(repositories.markOpportunitySelected).toHaveBeenCalledWith("opp-1", undefined);

    const warnMessages = logger.warn.mock.calls.map((call: unknown[]) => call[1]);
    expect(warnMessages).toContainEqual(expect.stringContaining("empty fingerprint"));
    expect(warnMessages).toContainEqual(expect.stringContaining("empty editorial owner"));
  });

  it("padded values are trimmed before use", async () => {
    const repositories = buildRepositories();
    const notion = buildNotion();
    const opp = makeOpportunityRow({ status: "To review" });

    notion.listSelectedOpportunities.mockResolvedValue([
      { notionPageId: "np-1", fingerprint: "  npf-1  ", editorialOwner: " Baptiste " }
    ]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(opp);

    const { app, logger } = buildApp({ repositories, notion });
    await app.run("selection:scan", { dryRun: false, companySlug: "default" });

    expect(repositories.markOpportunitySelected).toHaveBeenCalledWith("opp-1", "Baptiste");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("already-selected opportunity is skipped without warnings", async () => {
    const repositories = buildRepositories();
    const notion = buildNotion();
    const opp = makeOpportunityRow({ status: "Selected" });

    notion.listSelectedOpportunities.mockResolvedValue([
      { notionPageId: "np-1", fingerprint: "", editorialOwner: "" }
    ]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(opp);

    const { app, logger } = buildApp({ repositories, notion });
    await app.run("selection:scan", { dryRun: false, companySlug: "default" });

    expect(repositories.markOpportunitySelected).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("unresolved page is skipped without warnings", async () => {
    const repositories = buildRepositories();
    const notion = buildNotion();

    notion.listSelectedOpportunities.mockResolvedValue([
      { notionPageId: "np-unknown", fingerprint: "", editorialOwner: "" }
    ]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(null);

    const { app, logger } = buildApp({ repositories, notion });
    await app.run("selection:scan", { dryRun: false, companySlug: "default" });

    expect(repositories.markOpportunitySelected).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warnings are persisted into the completed run payload via updateSyncRun", async () => {
    const repositories = buildRepositories();
    const notion = buildNotion();
    const opp = makeOpportunityRow({ status: "To review" });

    notion.listSelectedOpportunities.mockResolvedValue([
      { notionPageId: "np-1", fingerprint: "", editorialOwner: "" }
    ]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(opp);

    const { app } = buildApp({ repositories, notion });
    await app.run("selection:scan", { dryRun: false, companySlug: "default" });

    const updateCalls = repositories.updateSyncRun.mock.calls as unknown[][];
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);

    const finalRun = updateCalls[0][0] as SyncRun;
    expect(finalRun.status).toBe("completed");
    expect(finalRun.warnings).toEqual([
      "Empty fingerprint: notionPageId=np-1, opportunityId=opp-1",
      "Empty editorialOwner: notionPageId=np-1, opportunityId=opp-1"
    ]);
  });
});
