import { describe, expect, it, vi } from "vitest";

import { EditorialSignalEngineApp } from "../src/app.js";
import { sourceItemDbId } from "../src/db/repositories.js";
import type { ContentOpportunity, EvidenceReference, SourceKind } from "../src/domain/types.js";

vi.mock("../src/services/intelligence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/intelligence.js")>();
  return {
    ...actual,
    runIntelligencePipeline: vi.fn()
  };
});

vi.mock("../src/services/convergence.js", () => ({
  ensureConvergenceFoundation: vi.fn(async () => ({
    id: "company-1",
    slug: "default",
    name: "Default Company"
  }))
}));

import { runIntelligencePipeline } from "../src/services/intelligence.js";

const mockedPipeline = vi.mocked(runIntelligencePipeline);

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

const COMPANY_ID = "company-1";

function makeEvidence(overrides: Partial<{
  id: string;
  source: SourceKind;
  sourceItemId: string;
  sourceUrl: string;
  timestamp: string;
  excerpt: string;
  excerptHash: string;
  speakerOrAuthor: string;
  freshnessScore: number;
}> = {}): EvidenceReference {
  return {
    id: overrides.id ?? "ev-1",
    source: overrides.source ?? "notion",
    sourceItemId: overrides.sourceItemId ?? sourceItemDbId(COMPANY_ID, "ext-1"),
    sourceUrl: overrides.sourceUrl ?? "https://notion.so/page-1",
    timestamp: overrides.timestamp ?? "2026-03-14T09:00:00.000Z",
    excerpt: overrides.excerpt ?? "Automatic payroll recalculation streamlines compliance workflows when regulation changes arrive.",
    excerptHash: overrides.excerptHash ?? "hash-1",
    speakerOrAuthor: overrides.speakerOrAuthor,
    freshnessScore: overrides.freshnessScore ?? 0.9
  };
}

function makeSourceItemRow(overrides: Partial<{
  source: string;
  sourceItemId: string;
  externalId: string;
  fingerprint: string;
  sourceUrl: string;
  title: string;
  text: string;
  summary: string;
  authorName: string | null;
  speakerName: string | null;
  occurredAt: Date;
  ingestedAt: Date;
  metadataJson: unknown;
  rawPayloadJson: unknown;
  rawText: string | null;
  chunksJson: unknown;
}> = {}) {
  return {
    source: overrides.source ?? "notion",
    sourceItemId: overrides.sourceItemId ?? sourceItemDbId(COMPANY_ID, "ext-1"),
    externalId: overrides.externalId ?? "ext-1",
    fingerprint: overrides.fingerprint ?? "fp-1",
    sourceUrl: overrides.sourceUrl ?? "https://notion.so/page-1",
    title: overrides.title ?? "Payroll recalculation",
    text: overrides.text ?? "Automatic payroll recalculation streamlines compliance workflows.",
    summary: overrides.summary ?? "Payroll recalculation summary",
    authorName: overrides.authorName ?? null,
    speakerName: overrides.speakerName ?? null,
    occurredAt: overrides.occurredAt ?? new Date("2026-03-14T09:00:00.000Z"),
    ingestedAt: overrides.ingestedAt ?? new Date("2026-03-14T09:00:00.000Z"),
    metadataJson: overrides.metadataJson ?? {},
    rawPayloadJson: overrides.rawPayloadJson ?? {},
    rawText: overrides.rawText ?? null,
    chunksJson: overrides.chunksJson ?? null
  };
}

function makeOpportunity(overrides: Partial<{
  id: string;
  title: string;
  angle: string;
  whyNow: string;
  whatItIsAbout: string;
  whatItIsNotAbout: string;
  evidence: EvidenceReference[];
  primaryEvidence: EvidenceReference;
  enrichmentLog: unknown[];
  supportingEvidenceCount: number;
  evidenceFreshness: number;
  evidenceExcerpts: string[];
  suggestedFormat: string;
  status: string;
  sourceFingerprint: string;
  notionPageFingerprint: string;
}> = {}): ContentOpportunity {
  const evidence = overrides.evidence ?? [makeEvidence()];
  const primary = overrides.primaryEvidence ?? evidence[0];
  return {
    id: overrides.id ?? "opp-1",
    companyId: COMPANY_ID,
    sourceFingerprint: overrides.sourceFingerprint ?? "sf-1",
    title: overrides.title ?? "Payroll recalculation enables faster compliance updates",
    ownerProfile: undefined,
    ownerUserId: undefined,
    narrativePillar: "",
    angle: overrides.angle ?? "Automatic recalculation streamlines compliance when regulation changes arrive",
    whyNow: overrides.whyNow ?? "New payroll regulation coming Q2",
    whatItIsAbout: overrides.whatItIsAbout ?? "Payroll automation and compliance",
    whatItIsNotAbout: overrides.whatItIsNotAbout ?? "Manual payroll processes",
    evidence,
    primaryEvidence: primary,
    supportingEvidenceCount: overrides.supportingEvidenceCount ?? 0,
    evidenceFreshness: overrides.evidenceFreshness ?? 0.9,
    evidenceExcerpts: overrides.evidenceExcerpts ?? evidence.map(e => e.excerpt),
    routingStatus: "Routed",
    readiness: "Opportunity only",
    status: (overrides.status ?? "To review") as ContentOpportunity["status"],
    suggestedFormat: overrides.suggestedFormat ?? "article",
    enrichmentLog: (overrides.enrichmentLog ?? []) as ContentOpportunity["enrichmentLog"],
    v1History: [],
    notionPageFingerprint: overrides.notionPageFingerprint ?? "npf-1"
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
    updateOpportunityNotionSync: vi.fn(async () => ({})),
    markSourceItemsProcessed: vi.fn(async () => ({})),
    saveScreeningResults: vi.fn(async () => ({}))
  };
}

function buildNotion() {
  return {
    syncOpportunity: vi.fn(async (..._args: any[]) => ({ notionPageId: "np-1", action: "created" as const })),
    syncRun: vi.fn(async () => null),
    syncUser: vi.fn(async () => null)
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
  notion?: ReturnType<typeof buildNotion>;
  prisma?: ReturnType<typeof buildPrisma>;
} = {}) {
  const repositories = overrides.repositories ?? buildRepositories();
  const notion = overrides.notion ?? buildNotion();
  const prisma = overrides.prisma ?? buildPrisma();
  const app = new EditorialSignalEngineApp(
    buildEnv(),
    { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    {
      prisma: prisma as any,
      repositories: repositories as any,
      llmClient: {} as any,
      notion: notion as any
    }
  );
  return { app, repositories, notion, prisma };
}

describe("intelligence sync — created opportunities", () => {
  it("syncs updated evidence to Notion after evidence-pack enrichment", async () => {
    const { app, repositories, notion } = buildApp();

    const primaryEvidence = makeEvidence({
      id: "ev-origin",
      sourceItemId: sourceItemDbId(COMPANY_ID, "ext-origin"),
      excerpt: "Automatic payroll recalculation streamlines compliance workflows when regulation changes arrive."
    });
    const createdOpp = makeOpportunity({
      evidence: [primaryEvidence],
      primaryEvidence,
      enrichmentLog: [],
      supportingEvidenceCount: 0
    });

    mockedPipeline.mockResolvedValue({
      screeningResults: new Map(),
      created: [createdOpp],
      enriched: [],
      skipped: [],
      usageEvents: [],
      processedSourceItemIds: ["ext-origin"],
      linearReviewItems: [],
      linearClassifications: new Map()
    });

    // Candidate with overlapping topic keywords (payroll, recalculation, compliance)
    const candidateRow = makeSourceItemRow({
      source: "market-research",
      sourceItemId: sourceItemDbId(COMPANY_ID, "ext-support"),
      externalId: "ext-support",
      title: "Payroll compliance trends in 2026",
      text: "Payroll recalculation compliance automation is accelerating across European markets as new regulations take effect.",
      summary: "Payroll recalculation compliance automation trends."
    });
    repositories.listCandidateSourceItems.mockResolvedValue([candidateRow] as any);

    // Hydration returns source items for all evidence sourceItemIds
    (repositories.listSourceItemsByIds as any).mockImplementation(async (ids: string[]) => {
      const allRows = [
        makeSourceItemRow({
          sourceItemId: sourceItemDbId(COMPANY_ID, "ext-origin"),
          externalId: "ext-origin"
        }),
        makeSourceItemRow({
          source: "market-research",
          sourceItemId: sourceItemDbId(COMPANY_ID, "ext-support"),
          externalId: "ext-support",
          title: "Payroll compliance trends",
          text: "Payroll recalculation compliance automation is accelerating.",
          summary: "Payroll compliance automation trends."
        })
      ];
      return allRows.filter(r => ids.includes(r.sourceItemId));
    });

    await app.run("intelligence:run");

    // syncOpportunity should have been called with updated evidence
    expect(notion.syncOpportunity).toHaveBeenCalledTimes(1);
    const syncedOpp = (notion.syncOpportunity.mock.calls as any[][])[0][0] as ContentOpportunity;

    // Evidence should include original + support items
    expect(syncedOpp.evidence.length).toBeGreaterThan(1);
    // Supporting evidence count should be consistent
    expect(syncedOpp.supportingEvidenceCount).toBe(syncedOpp.evidence.length - 1);
    // Evidence excerpts should match evidence array
    expect(syncedOpp.evidenceExcerpts.length).toBe(syncedOpp.evidence.length);
    // Enrichment log should have 1 entry (the pack log entry)
    expect(syncedOpp.enrichmentLog.length).toBe(1);
    expect(syncedOpp.enrichmentLog[0].evidenceIds.length).toBeGreaterThan(0);

    // Original opp should be immutable — still has 1 evidence item
    expect(createdOpp.evidence.length).toBe(1);
    expect(createdOpp.enrichmentLog.length).toBe(0);
  });

  it("uses exact source-item hydration, not the pending batch", async () => {
    const { app, repositories } = buildApp();

    const primaryEvidence = makeEvidence({
      id: "ev-origin",
      sourceItemId: sourceItemDbId(COMPANY_ID, "ext-origin"),
      excerpt: "Automatic payroll recalculation streamlines compliance workflows when regulation changes arrive."
    });
    const createdOpp = makeOpportunity({
      evidence: [primaryEvidence],
      primaryEvidence,
      enrichmentLog: [],
      supportingEvidenceCount: 0
    });

    mockedPipeline.mockResolvedValue({
      screeningResults: new Map(),
      created: [createdOpp],
      enriched: [],
      skipped: [],
      usageEvents: [],
      processedSourceItemIds: ["ext-origin"],
      linearReviewItems: [],
      linearClassifications: new Map()
    });

    repositories.listCandidateSourceItems.mockResolvedValue([] as any);

    repositories.listSourceItemsByIds.mockResolvedValue([
      makeSourceItemRow({
        sourceItemId: sourceItemDbId(COMPANY_ID, "ext-origin"),
        externalId: "ext-origin"
      })
    ] as any);

    await app.run("intelligence:run");

    // listSourceItemsByIds should have been called for the created opp's evidence
    expect(repositories.listSourceItemsByIds).toHaveBeenCalled();
    const calledIds = (repositories.listSourceItemsByIds.mock.calls as any[][])[0][0] as string[];
    expect(calledIds).toContain(sourceItemDbId(COMPANY_ID, "ext-origin"));
  });
});

describe("intelligence sync — enriched opportunities", () => {
  it("batch-hydrates all evidence source items, not just the pending batch", async () => {
    const { app, repositories, notion } = buildApp();

    // Evidence from a prior run (notion internal-proof)
    const olderEvidence = makeEvidence({
      id: "ev-old-proof",
      source: "notion",
      sourceItemId: sourceItemDbId(COMPANY_ID, "proof-old"),
      sourceUrl: "https://notion.so/internal-proof",
      excerpt: "Le moteur de recalcul automatique de paie est en production depuis janvier 2026 et gère 15 000 bulletins par mois.",
      excerptHash: "hash-proof-old"
    });

    // Evidence from current run (market research)
    const currentEvidence = makeEvidence({
      id: "ev-current-mr",
      source: "market-research",
      sourceItemId: sourceItemDbId(COMPANY_ID, "mr-current"),
      sourceUrl: "https://example.com/market",
      excerpt: "Payroll compliance automation recalculation is accelerating across European markets as new regulations reshape buyer expectations.",
      excerptHash: "hash-mr-current"
    });

    const enrichedOpp = makeOpportunity({
      id: "opp-enriched",
      title: "Le moteur de recalcul automatique de paie permet une mise en conformité instantanée",
      angle: "Automatic payroll recalculation enables instant compliance when new regulations arrive mid-cycle",
      whatItIsAbout: "Payroll automation fonctionnalité recalcul automatique enables compliance",
      evidence: [olderEvidence, currentEvidence],
      primaryEvidence: olderEvidence,
      supportingEvidenceCount: 1,
      evidenceFreshness: 0.9,
      evidenceExcerpts: [olderEvidence.excerpt, currentEvidence.excerpt]
    });

    const logEntry = {
      createdAt: "2026-03-17T09:00:00.000Z",
      rawSourceItemId: currentEvidence.sourceItemId,
      evidenceIds: [currentEvidence.id],
      contextComment: "Enriched with market research",
      confidence: 0.7,
      reason: "Market data corroborates"
    };

    mockedPipeline.mockResolvedValue({
      screeningResults: new Map(),
      created: [],
      enriched: [{
        opportunity: enrichedOpp,
        logEntry: logEntry as any,
        addedEvidence: [currentEvidence]
      }],
      skipped: [],
      usageEvents: [],
      processedSourceItemIds: ["mr-current"],
      linearReviewItems: [],
      linearClassifications: new Map()
    });

    // Hydration returns both source items — including the older proof
    (repositories.listSourceItemsByIds as any).mockImplementation(async (ids: string[]) => {
      const allRows = [
        makeSourceItemRow({
          source: "notion",
          sourceItemId: sourceItemDbId(COMPANY_ID, "proof-old"),
          externalId: "proof-old",
          title: "Recalcul automatique de paie",
          text: "Le moteur de recalcul automatique de paie est en production depuis janvier 2026 et gère 15 000 bulletins par mois.",
          summary: "Moteur de recalcul paie en production.",
          metadataJson: { notionKind: "internal-proof" }
        }),
        makeSourceItemRow({
          source: "market-research",
          sourceItemId: sourceItemDbId(COMPANY_ID, "mr-current"),
          externalId: "mr-current",
          title: "Payroll compliance automation",
          text: "Payroll compliance automation recalculation is accelerating across European markets.",
          summary: "Market research on payroll compliance."
        })
      ];
      return allRows.filter(r => ids.includes(r.sourceItemId));
    });

    await app.run("intelligence:run");

    // The enriched opp should be synced with readiness "ready" (not downgraded)
    // because the internal-proof with "en production" provides backed-live status
    expect(notion.syncOpportunity).toHaveBeenCalledTimes(1);
    const syncOptions = (notion.syncOpportunity.mock.calls as any[][])[0][2] as { draftReadiness: { tier: string; guidance: string[] } };
    expect(syncOptions.draftReadiness.tier).toBe("ready");

    // Verify batch hydration was called with both source item IDs
    const hydrationIds = (repositories.listSourceItemsByIds.mock.calls as any[][])[0][0] as string[];
    expect(hydrationIds).toContain(sourceItemDbId(COMPANY_ID, "proof-old"));
    expect(hydrationIds).toContain(sourceItemDbId(COMPANY_ID, "mr-current"));
  });
});

describe("intelligence sync — claim-aware downgrade reaches Notion", () => {
  it("downgrades product-claim opportunity without backing to promising", async () => {
    const { app, repositories, notion } = buildApp();

    const primaryEvidence = makeEvidence({
      id: "ev-origin",
      sourceItemId: sourceItemDbId(COMPANY_ID, "ext-origin"),
      sourceUrl: "https://notion.so/page-1",
      excerpt: "Le tableau de bord permet de configurer et automatiser la gestion de paie avec un workflow intégré pour chaque module."
    });
    // Product-claim keywords in title/angle: "fonctionnalité", "permet", "automatiser"
    const createdOpp = makeOpportunity({
      title: "La fonctionnalité de tableau de bord permet d'automatiser la gestion de paie",
      angle: "Le module de paramétrage automatise le workflow de paie et permet une configuration simplifiée",
      whatItIsAbout: "Fonctionnalité tableau de bord automatiser workflow paie",
      evidence: [primaryEvidence],
      primaryEvidence,
      enrichmentLog: [],
      supportingEvidenceCount: 0
    });

    mockedPipeline.mockResolvedValue({
      screeningResults: new Map(),
      created: [createdOpp],
      enriched: [],
      skipped: [],
      usageEvents: [],
      processedSourceItemIds: ["ext-origin"],
      linearReviewItems: [],
      linearClassifications: new Map()
    });

    // Candidate with overlapping topic but NOT internal-proof
    const candidateRow = makeSourceItemRow({
      source: "market-research",
      sourceItemId: sourceItemDbId(COMPANY_ID, "ext-support"),
      externalId: "ext-support",
      title: "Paie automatisation workflow compliance",
      text: "Automatiser la gestion de paie et le workflow associé est un enjeu majeur pour la compliance en 2026 avec le tableau de bord.",
      summary: "Automatisation de la gestion de paie et workflow."
    });
    repositories.listCandidateSourceItems.mockResolvedValue([candidateRow] as any);

    // No internal-proof source items — only market-research
    (repositories.listSourceItemsByIds as any).mockImplementation(async (ids: string[]) => {
      const allRows = [
        makeSourceItemRow({
          sourceItemId: sourceItemDbId(COMPANY_ID, "ext-origin"),
          externalId: "ext-origin",
          title: "Tableau de bord paie",
          text: "Le tableau de bord permet de configurer et automatiser la gestion de paie.",
          summary: "Tableau de bord pour la gestion de paie."
        }),
        makeSourceItemRow({
          source: "market-research",
          sourceItemId: sourceItemDbId(COMPANY_ID, "ext-support"),
          externalId: "ext-support",
          title: "Paie automatisation workflow compliance",
          text: "Automatiser la gestion de paie et le workflow associé est un enjeu majeur pour la compliance en 2026 avec le tableau de bord.",
          summary: "Automatisation de la gestion de paie et workflow."
        })
      ];
      return allRows.filter(r => ids.includes(r.sourceItemId));
    });

    await app.run("intelligence:run");

    expect(notion.syncOpportunity).toHaveBeenCalledTimes(1);
    const syncOptions = (notion.syncOpportunity.mock.calls as any[][])[0][2] as { draftReadiness: { tier: string; guidance: string[] } };
    // Product-claim with no internal-proof backing → downgraded to "promising"
    expect(syncOptions.draftReadiness.tier).toBe("promising");
  });
});
