import { describe, expect, it, vi } from "vitest";

import { EditorialSignalEngineApp } from "../src/app.js";
import type { ContentOpportunity, EvidenceReference, NotionEditRequest, SourceKind } from "../src/domain/types.js";

vi.mock("../src/services/convergence.js", () => ({
  ensureConvergenceFoundation: vi.fn(async () => ({
    id: "company-1",
    slug: "default",
    name: "Default Company"
  }))
}));

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
    LLM_MODEL: "gpt-5.4-mini",
    NANO_LLM_PROVIDER: "openai" as const,
    NANO_LLM_MODEL: "gpt-5.4-nano",
    LLM_TIMEOUT_MS: 100,
    HTTP_PORT: 3000,
    LOG_LEVEL: "info"
  };
}

function makeEvidence(overrides: Partial<{
  id: string;
  source: SourceKind;
  sourceItemId: string;
  sourceUrl: string;
  timestamp: string;
  excerpt: string;
  excerptHash: string;
  freshnessScore: number;
}> = {}): EvidenceReference {
  return {
    id: overrides.id ?? "ev-1",
    source: overrides.source ?? "notion",
    sourceItemId: overrides.sourceItemId ?? "si-1",
    sourceUrl: overrides.sourceUrl ?? "https://example.com/source",
    timestamp: overrides.timestamp ?? "2026-03-14T09:00:00.000Z",
    excerpt: overrides.excerpt ?? "Evidence excerpt text for testing readiness.",
    excerptHash: overrides.excerptHash ?? "hash-1",
    freshnessScore: overrides.freshnessScore ?? 0.9
  };
}

function makeOpportunityRow(overrides: Partial<{
  id: string;
  companyId: string;
  notionPageId: string | null;
  notionPageFingerprint: string;
  notionEditsPending: boolean;
  editorialNotes: string;
  primaryEvidenceId: string | null;
  sourceUrl: string;
  title: string;
  angle: string;
}> = {}) {
  const evidence = makeEvidence({ sourceUrl: overrides.sourceUrl });
  return {
    id: overrides.id ?? "opp-1",
    companyId: overrides.companyId ?? COMPANY_ID,
    sourceFingerprint: "sf-1",
    title: overrides.title ?? "Original Title",
    ownerProfile: null,
    ownerUserId: null,
    narrativePillar: "",
    targetSegment: "",
    editorialPillar: "",
    awarenessTarget: "",
    buyerFriction: "",
    contentMotion: "",
    angle: overrides.angle ?? "Original angle on compliance automation",
    whyNow: "Regulation Q2",
    whatItIsAbout: "Compliance",
    whatItIsNotAbout: "Manual work",
    routingStatus: "Routed",
    readiness: "Opportunity only",
    status: "To review",
    suggestedFormat: "article",
    supportingEvidenceCount: 0,
    evidenceFreshness: 0.9,
    editorialOwner: null,
    editorialNotes: overrides.editorialNotes ?? "",
    notionEditsPending: overrides.notionEditsPending ?? false,
    selectedAt: null,
    lastDigestAt: null,
    updatedAt: new Date("2026-03-14T09:00:00.000Z"),
    primaryEvidenceId: overrides.primaryEvidenceId ?? "ev-1",
    enrichmentLogJson: [],
    v1HistoryJson: [],
    notionPageId: overrides.notionPageId ?? "np-1",
    notionPageFingerprint: overrides.notionPageFingerprint ?? "npf-1",
    primaryEvidence: {
      ...evidence,
      timestamp: new Date(evidence.timestamp),
      speakerOrAuthor: null
    },
    evidence: [{
      ...evidence,
      timestamp: new Date(evidence.timestamp),
      speakerOrAuthor: null
    }],
    linkedEvidence: []
  };
}

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
    updateSyncRun: vi.fn(async () => ({})),
    updateSyncRunNotionSync: vi.fn(async () => ({})),
    addCostEntries: vi.fn(async () => ({})),
    listUsers: vi.fn(async () => []),
    findOpportunityByNotionPageId: vi.fn(async () => null),
    findOpportunityByNotionPageFingerprint: vi.fn(async () => null),
    findOpportunityById: vi.fn(async () => null),
    updateOpportunityEditableFields: vi.fn(async () => ({})),
    updateEvidenceSourceUrl: vi.fn(async () => ({})),
    updateOpportunityNotionSync: vi.fn(async () => ({})),
    markEditsPending: vi.fn(async () => ({})),
    clearEditsPending: vi.fn(async () => ({})),
    findEditsPendingOpportunities: vi.fn(async () => [] as Array<{ id: string; notionPageId: string | null; notionPageFingerprint: string }>),
    listSourceItemsByIds: vi.fn(async () => [])
  };
}

function buildNotion() {
  return {
    listReEvaluationRequests: vi.fn(async () => [] as NotionEditRequest[]),
    clearReEvaluationCheckbox: vi.fn(async () => {}),
    syncOpportunity: vi.fn(async () => ({ notionPageId: "np-1", action: "updated" as const })),
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

function makeEditRequest(overrides: Partial<{
  notionPageId: string;
  fingerprint: string;
  title: string;
  angle: string;
  sourceUrl: string;
  editorialNotes: string;
}> = {}) {
  return {
    notionPageId: overrides.notionPageId ?? "np-1",
    fingerprint: overrides.fingerprint ?? "npf-1",
    title: overrides.title ?? "Edited Title",
    angle: overrides.angle ?? "Edited Angle",
    whyNow: "Edited Why now",
    whatItIsAbout: "Edited About",
    whatItIsNotAbout: "Edited Not about",
    sourceUrl: overrides.sourceUrl ?? "https://edited.com/source",
    editorialNotes: overrides.editorialNotes ?? "User notes",
    targetSegment: "",
    editorialPillar: "",
    awarenessTarget: "",
    buyerFriction: "",
    contentMotion: ""
  };
}

describe("opportunity:pull-notion-edits command", () => {
  it("successful re-evaluation: persists edits, recomputes readiness, syncs, clears flags", async () => {
    const { app, repositories, notion } = buildApp();
    const row = makeOpportunityRow();

    notion.listReEvaluationRequests.mockResolvedValue([makeEditRequest()]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(row as any);
    repositories.findOpportunityById.mockResolvedValue(row as any);

    await app.run("opportunity:pull-notion-edits");

    expect(repositories.updateOpportunityEditableFields).toHaveBeenCalledWith({
      opportunityId: "opp-1",
      title: "Edited Title",
      angle: "Edited Angle",
      whyNow: "Edited Why now",
      whatItIsAbout: "Edited About",
      whatItIsNotAbout: "Edited Not about",
      editorialNotes: "User notes",
      targetSegment: "",
      editorialPillar: "",
      awarenessTarget: "",
      buyerFriction: "",
      contentMotion: ""
    });
    expect(repositories.markEditsPending).toHaveBeenCalledWith(["opp-1"], COMPANY_ID);
    expect(notion.syncOpportunity).toHaveBeenCalledTimes(1);
    const syncCall = (notion.syncOpportunity as any).mock.calls[0];
    expect(syncCall[2]).toMatchObject({ writeEditableFields: true });
    // Internal guard cleared FIRST
    expect(repositories.clearEditsPending).toHaveBeenCalledWith("opp-1");
    // Then external trigger
    expect(notion.clearReEvaluationCheckbox).toHaveBeenCalledWith("np-1");
  });

  it("per-item failure leaves checkbox and flag set, continues to next item", async () => {
    const { app, repositories, notion } = buildApp();
    const rowA = makeOpportunityRow({ id: "opp-a", notionPageId: "np-a", notionPageFingerprint: "npf-a" });
    const rowB = makeOpportunityRow({ id: "opp-b", notionPageId: "np-b", notionPageFingerprint: "npf-b" });

    notion.listReEvaluationRequests.mockResolvedValue([
      makeEditRequest({ notionPageId: "np-a", fingerprint: "npf-a" }),
      makeEditRequest({ notionPageId: "np-b", fingerprint: "npf-b" })
    ]);
    (repositories.findOpportunityByNotionPageId as any).mockImplementation(async (pageId: string) => {
      if (pageId === "np-a") return rowA as any;
      if (pageId === "np-b") return rowB as any;
      return null;
    });
    // Item A fails on DB update
    (repositories.updateOpportunityEditableFields as any).mockImplementation(async (params: any) => {
      if (params.opportunityId === "opp-a") throw new Error("DB error for A");
      return {} as any;
    });
    repositories.findOpportunityById.mockResolvedValue(rowB as any);

    await app.run("opportunity:pull-notion-edits");

    // A's checkbox and flag NOT cleared
    expect(repositories.clearEditsPending).not.toHaveBeenCalledWith("opp-a");
    expect(notion.clearReEvaluationCheckbox).not.toHaveBeenCalledWith("np-a");
    // B succeeded
    expect(repositories.clearEditsPending).toHaveBeenCalledWith("opp-b");
    expect(notion.clearReEvaluationCheckbox).toHaveBeenCalledWith("np-b");
  });

  it("unresolved requests are skipped, not processed", async () => {
    const { app, repositories, notion, logger } = buildApp();

    notion.listReEvaluationRequests.mockResolvedValue([
      makeEditRequest({ notionPageId: "np-unknown", fingerprint: "fp-unknown" })
    ]);
    // Both lookups return null
    repositories.findOpportunityByNotionPageId.mockResolvedValue(null);
    repositories.findOpportunityByNotionPageFingerprint.mockResolvedValue(null);

    await app.run("opportunity:pull-notion-edits");

    expect(repositories.updateOpportunityEditableFields).not.toHaveBeenCalled();
    expect(repositories.markEditsPending).not.toHaveBeenCalled();
    expect(notion.syncOpportunity).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("orphan reconciliation clears truly orphaned flags, preserves externally requested", async () => {
    const { app, repositories, notion } = buildApp();
    const row = makeOpportunityRow({ id: "opp-live", notionPageId: "np-live", notionPageFingerprint: "npf-live" });

    // One checked row in Notion
    notion.listReEvaluationRequests.mockResolvedValue([
      makeEditRequest({ notionPageId: "np-live", fingerprint: "npf-live" })
    ]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(row as any);
    repositories.findOpportunityById.mockResolvedValue(row as any);

    // DB has two pending opps: one matches Notion (np-live), one is orphaned (np-orphan)
    repositories.findEditsPendingOpportunities.mockResolvedValue([
      { id: "opp-live", notionPageId: "np-live", notionPageFingerprint: "npf-live" },
      { id: "opp-orphan", notionPageId: "np-orphan", notionPageFingerprint: "npf-orphan" }
    ]);

    await app.run("opportunity:pull-notion-edits");

    // opp-orphan should be cleared (not in Notion results)
    const clearCalls = (repositories.clearEditsPending as any).mock.calls.map((c: any[]) => c[0]);
    expect(clearCalls).toContain("opp-orphan");
    // opp-live was cleared by normal per-item processing, not by reconciliation
    expect(clearCalls).toContain("opp-live");
  });

  it("Source URL clear from Notion (empty string) persists to evidence", async () => {
    const { app, repositories, notion } = buildApp();
    const row = makeOpportunityRow({ sourceUrl: "https://old.com" });

    notion.listReEvaluationRequests.mockResolvedValue([
      makeEditRequest({ sourceUrl: "" })
    ]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(row as any);
    repositories.findOpportunityById.mockResolvedValue(row as any);

    await app.run("opportunity:pull-notion-edits");

    expect(repositories.updateEvidenceSourceUrl).toHaveBeenCalledWith("ev-1", "");
  });

  it("Source URL unchanged in Notion skips evidence update", async () => {
    const { app, repositories, notion } = buildApp();
    const row = makeOpportunityRow({ sourceUrl: "https://same.com" });

    notion.listReEvaluationRequests.mockResolvedValue([
      makeEditRequest({ sourceUrl: "https://same.com" })
    ]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(row as any);
    repositories.findOpportunityById.mockResolvedValue(row as any);

    await app.run("opportunity:pull-notion-edits");

    expect(repositories.updateEvidenceSourceUrl).not.toHaveBeenCalled();
  });

  it("company isolation: only resolves opportunities for the active company", async () => {
    const { app, repositories, notion } = buildApp();

    notion.listReEvaluationRequests.mockResolvedValue([makeEditRequest()]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(null);
    repositories.findOpportunityByNotionPageFingerprint.mockResolvedValue(null);

    await app.run("opportunity:pull-notion-edits");

    // Both lookups must pass company.id
    expect(repositories.findOpportunityByNotionPageId).toHaveBeenCalledWith("np-1", COMPANY_ID);
    expect(repositories.findOpportunityByNotionPageFingerprint).toHaveBeenCalledWith("npf-1", COMPANY_ID);
  });

  it("company isolation: markEditsPending and findEditsPending pass companyId", async () => {
    const { app, repositories, notion } = buildApp();
    const row = makeOpportunityRow();

    notion.listReEvaluationRequests.mockResolvedValue([makeEditRequest()]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(row as any);
    repositories.findOpportunityById.mockResolvedValue(row as any);

    await app.run("opportunity:pull-notion-edits");

    expect(repositories.markEditsPending).toHaveBeenCalledWith(["opp-1"], COMPANY_ID);
    expect(repositories.findEditsPendingOpportunities).toHaveBeenCalledWith(COMPANY_ID);
  });

  it("dry-run performs zero mutations", async () => {
    const { app, repositories, notion } = buildApp();
    const row = makeOpportunityRow();

    notion.listReEvaluationRequests.mockResolvedValue([makeEditRequest()]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(row as any);

    await app.run("opportunity:pull-notion-edits", { dryRun: true });

    expect(repositories.createSyncRun).not.toHaveBeenCalled();
    expect(repositories.markEditsPending).not.toHaveBeenCalled();
    expect(repositories.updateOpportunityEditableFields).not.toHaveBeenCalled();
    expect(repositories.updateEvidenceSourceUrl).not.toHaveBeenCalled();
    expect(notion.syncOpportunity).not.toHaveBeenCalled();
    expect(notion.clearReEvaluationCheckbox).not.toHaveBeenCalled();
    expect(repositories.clearEditsPending).not.toHaveBeenCalled();
  });

  it("fallback to fingerprint when notionPageId lookup fails", async () => {
    const { app, repositories, notion } = buildApp();
    const row = makeOpportunityRow();

    notion.listReEvaluationRequests.mockResolvedValue([makeEditRequest()]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(null);
    repositories.findOpportunityByNotionPageFingerprint.mockResolvedValue(row as any);
    repositories.findOpportunityById.mockResolvedValue(row as any);

    await app.run("opportunity:pull-notion-edits");

    expect(repositories.findOpportunityByNotionPageFingerprint).toHaveBeenCalledWith("npf-1", COMPANY_ID);
    expect(repositories.updateOpportunityEditableFields).toHaveBeenCalled();
  });

  it("sync run is persisted with companyId set", async () => {
    const { app, repositories, notion } = buildApp();
    const row = makeOpportunityRow();

    notion.listReEvaluationRequests.mockResolvedValue([makeEditRequest()]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(row as any);
    repositories.findOpportunityById.mockResolvedValue(row as any);

    await app.run("opportunity:pull-notion-edits");

    expect(repositories.createSyncRun).toHaveBeenCalledTimes(1);
    const syncRun = (repositories.createSyncRun as any).mock.calls[0][0];
    expect(syncRun.companyId).toBe(COMPANY_ID);
    expect(syncRun.runType).toBe("opportunity:pull-notion-edits");
  });

  it("unresolved request produces a durable warning in the sync run", async () => {
    const { app, repositories, notion } = buildApp();

    notion.listReEvaluationRequests.mockResolvedValue([
      makeEditRequest({ notionPageId: "np-ghost", fingerprint: "fp-ghost" })
    ]);
    // Both lookups return null — unresolvable
    repositories.findOpportunityByNotionPageId.mockResolvedValue(null);
    repositories.findOpportunityByNotionPageFingerprint.mockResolvedValue(null);

    await app.run("opportunity:pull-notion-edits");

    // The warning must be persisted via updateSyncRun, not just logged
    expect(repositories.updateSyncRun).toHaveBeenCalled();
    const persistedRun = (repositories.updateSyncRun as any).mock.calls[0][0];
    expect(persistedRun.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Unresolved re-evaluation request")
      ])
    );
    expect(persistedRun.warnings[0]).toContain("np-ghost");
    expect(persistedRun.warnings[0]).toContain("fp-ghost");
    expect(persistedRun.warnings[0]).toContain("unprotected");

    // Notes field surfaces the unresolved count for list-view visibility
    expect(persistedRun.notes).toContain("1 unresolved");
    expect(persistedRun.notes).toContain("see warnings");

    // Checkbox NOT cleared (user can investigate)
    expect(notion.clearReEvaluationCheckbox).not.toHaveBeenCalled();
    // notionEditsPending never set (nothing was resolved)
    expect(repositories.markEditsPending).not.toHaveBeenCalled();
  });

  it("identifier drift: unresolved row has no pending guard, warning surfaces the risk", async () => {
    const { app, repositories, notion } = buildApp();

    // Notion has a checked row whose fingerprint no longer matches any DB record.
    // This simulates identifier drift — the Notion page exists, user edited it,
    // but the opportunity in DB has a different fingerprint (e.g. after re-creation).
    const driftedRequest = makeEditRequest({
      notionPageId: "np-drifted",
      fingerprint: "fp-drifted-no-match"
    });
    notion.listReEvaluationRequests.mockResolvedValue([driftedRequest]);
    repositories.findOpportunityByNotionPageId.mockResolvedValue(null);
    repositories.findOpportunityByNotionPageFingerprint.mockResolvedValue(null);

    await app.run("opportunity:pull-notion-edits");

    // The pending guard was never set for this row, so outbound sync will NOT
    // suppress editable-field writes. The warning makes this visible.
    expect(repositories.markEditsPending).not.toHaveBeenCalled();

    // Warning persisted to run
    const persistedRun = (repositories.updateSyncRun as any).mock.calls[0][0];
    expect(persistedRun.warnings).toHaveLength(1);
    expect(persistedRun.warnings[0]).toContain("np-drifted");
    expect(persistedRun.warnings[0]).toContain("unprotected");

    // Checkbox stays checked so user can investigate
    expect(notion.clearReEvaluationCheckbox).not.toHaveBeenCalled();

    // No edits persisted, no sync-back, no guard cleared
    expect(repositories.updateOpportunityEditableFields).not.toHaveBeenCalled();
    expect(notion.syncOpportunity).not.toHaveBeenCalled();
    expect(repositories.clearEditsPending).not.toHaveBeenCalled();
  });

  it("operator clearing a GTM field in Notion persists empty string to DB", async () => {
    const oppRow = makeOpportunityRow({
      notionPageId: "np-1",
      notionPageFingerprint: "npf-1",
      editorialNotes: "original notes"
    });
    // Simulate: opportunity had GTM values from LLM
    (oppRow as any).targetSegment = "production-manager";
    (oppRow as any).editorialPillar = "proof";

    const editRequest = {
      ...makeEditRequest(),
      // Operator cleared these fields in Notion → pull-edits returns ""
      targetSegment: "",
      editorialPillar: "",
      // Operator set a valid new value for this one
      awarenessTarget: "solution-aware",
      buyerFriction: "",
      contentMotion: ""
    };

    const { app, repositories, notion } = buildApp();
    repositories.findOpportunityByNotionPageId.mockResolvedValue(oppRow as any);
    repositories.findOpportunityByNotionPageFingerprint.mockResolvedValue(null);
    repositories.findOpportunityById.mockResolvedValue(oppRow as any);
    notion.listReEvaluationRequests.mockResolvedValue([editRequest]);

    await app.run("opportunity:pull-notion-edits");

    expect(repositories.updateOpportunityEditableFields).toHaveBeenCalledTimes(1);
    const call = (repositories.updateOpportunityEditableFields.mock.calls[0] as any[])[0];
    // Cleared fields should be written as "" (not skipped)
    expect(call.targetSegment).toBe("");
    expect(call.editorialPillar).toBe("");
    // Valid operator override preserved
    expect(call.awarenessTarget).toBe("solution-aware");
    expect(call.buyerFriction).toBe("");
    expect(call.contentMotion).toBe("");
  });

  it("operator GTM override persists through pull-edits", async () => {
    const oppRow = makeOpportunityRow({
      notionPageId: "np-1",
      notionPageFingerprint: "npf-1"
    });

    const editRequest = {
      ...makeEditRequest(),
      targetSegment: "production-manager",
      editorialPillar: "insight",
      awarenessTarget: "",
      buyerFriction: "Migration risk too high",
      contentMotion: "demand-capture"
    };

    const { app, repositories, notion } = buildApp();
    repositories.findOpportunityByNotionPageId.mockResolvedValue(oppRow as any);
    repositories.findOpportunityById.mockResolvedValue(oppRow as any);
    notion.listReEvaluationRequests.mockResolvedValue([editRequest]);

    await app.run("opportunity:pull-notion-edits");

    const call = (repositories.updateOpportunityEditableFields.mock.calls[0] as any[])[0];
    expect(call.targetSegment).toBe("production-manager");
    expect(call.editorialPillar).toBe("insight");
    expect(call.awarenessTarget).toBe("");
    expect(call.buyerFriction).toBe("Migration risk too high");
    expect(call.contentMotion).toBe("demand-capture");
  });

  it("unsupported non-empty Notion GTM value does not clear existing DB field", async () => {
    const oppRow = makeOpportunityRow({
      notionPageId: "np-1",
      notionPageFingerprint: "npf-1"
    });
    // DB has valid GTM values from LLM
    (oppRow as any).targetSegment = "production-manager";
    (oppRow as any).editorialPillar = "proof";

    const editRequest = {
      ...makeEditRequest(),
      // Operator typed an unsupported value in Notion (not in enum)
      // normalizeGtmFieldsForOperatorEdit returns undefined → conditional spread skips
      targetSegment: undefined, // simulates invalid "ceo" being normalized to undefined
      editorialPillar: undefined, // simulates invalid "hot-take" being normalized to undefined
      // Operator explicitly cleared this one (empty select)
      awarenessTarget: "",
      // Operator set a valid value
      contentMotion: "trust"
    };

    const { app, repositories, notion } = buildApp();
    repositories.findOpportunityByNotionPageId.mockResolvedValue(oppRow as any);
    repositories.findOpportunityById.mockResolvedValue(oppRow as any);
    notion.listReEvaluationRequests.mockResolvedValue([editRequest]);

    await app.run("opportunity:pull-notion-edits");

    const call = (repositories.updateOpportunityEditableFields.mock.calls[0] as any[])[0];
    // Invalid values → undefined → conditional spread skips → DB value preserved
    expect(call.targetSegment).toBeUndefined();
    expect(call.editorialPillar).toBeUndefined();
    // Explicit clear → "" → persisted
    expect(call.awarenessTarget).toBe("");
    // Valid operator choice → persisted
    expect(call.contentMotion).toBe("trust");
  });
});
