import { describe, expect, it, vi } from "vitest";

import { EditorialSignalEngineApp } from "../src/app.js";
import { sourceItemDbId } from "../src/db/repositories.js";
import { buildIntelligenceEvidence } from "../src/services/intelligence.js";
import type { ContentOpportunity, EvidenceReference, SourceKind } from "../src/domain/types.js";

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
    supportingEvidenceCount: overrides.supportingEvidenceCount ?? Math.max(0, evidence.length - 1),
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

function makeOpportunityRow(opportunity: ContentOpportunity) {
  return {
    id: opportunity.id,
    companyId: opportunity.companyId,
    sourceFingerprint: opportunity.sourceFingerprint,
    title: opportunity.title,
    ownerProfile: opportunity.ownerProfile ?? null,
    ownerUserId: opportunity.ownerUserId ?? null,
    narrativePillar: opportunity.narrativePillar,
    angle: opportunity.angle,
    whyNow: opportunity.whyNow,
    whatItIsAbout: opportunity.whatItIsAbout,
    whatItIsNotAbout: opportunity.whatItIsNotAbout,
    routingStatus: opportunity.routingStatus,
    readiness: opportunity.readiness,
    status: opportunity.status,
    suggestedFormat: opportunity.suggestedFormat,
    supportingEvidenceCount: opportunity.supportingEvidenceCount,
    evidenceFreshness: opportunity.evidenceFreshness,
    editorialOwner: null,
    selectedAt: null,
    lastDigestAt: null,
    updatedAt: new Date("2026-03-14T09:00:00.000Z"),
    primaryEvidenceId: opportunity.primaryEvidence.id,
    enrichmentLogJson: opportunity.enrichmentLog,
    v1HistoryJson: opportunity.v1History,
    notionPageId: null,
    notionPageFingerprint: opportunity.notionPageFingerprint,
    primaryEvidence: {
      ...opportunity.primaryEvidence,
      timestamp: new Date(opportunity.primaryEvidence.timestamp),
      speakerOrAuthor: opportunity.primaryEvidence.speakerOrAuthor ?? null
    },
    evidence: opportunity.evidence.map((e) => ({
      ...e,
      timestamp: new Date(e.timestamp),
      speakerOrAuthor: e.speakerOrAuthor ?? null
    })),
    linkedEvidence: []
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
    addCostEntries: vi.fn(async () => ({})),
    listRecentActiveOpportunities: vi.fn(async () => []),
    listCandidateSourceItems: vi.fn(async () => [] as any[]),
    persistStandaloneEvidence: vi.fn(async () => ({})),
    enrichOpportunity: vi.fn(async () => ({})),
    listSourceItemsByIds: vi.fn(async () => [] as any[])
  };
}

function buildPrisma() {
  return {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({}))
  };
}

function buildApp(overrides: {
  repositories?: ReturnType<typeof buildRepositories>;
  prisma?: ReturnType<typeof buildPrisma>;
  logger?: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
} = {}) {
  const repositories = overrides.repositories ?? buildRepositories();
  const prisma = overrides.prisma ?? buildPrisma();
  const logger = overrides.logger ?? { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const app = new EditorialSignalEngineApp(
    buildEnv(),
    logger,
    {
      prisma: prisma as any,
      repositories: repositories as any,
      llmClient: {} as any
    }
  );
  return { app, repositories, prisma, logger };
}

describe("backfill:evidence command", () => {
  it("does not persist or sync during dry-run", async () => {
    const { app, repositories, logger } = buildApp();

    const opp = makeOpportunity();
    repositories.listRecentActiveOpportunities.mockResolvedValue([makeOpportunityRow(opp)] as any);
    repositories.listCandidateSourceItems.mockResolvedValue([
      makeSourceItemRow({
        source: "market-research",
        sourceItemId: sourceItemDbId(COMPANY_ID, "support-1"),
        externalId: "support-1",
        title: "Payroll compliance automation trends",
        text: "Payroll recalculation automation improves compliance when regulations change across enterprise customers.",
        summary: "Payroll recalculation automation compliance trends."
      })
    ] as any);

    await app.run("backfill:evidence", { dryRun: true });

    expect(repositories.createSyncRun).not.toHaveBeenCalled();
    expect(repositories.persistStandaloneEvidence).not.toHaveBeenCalled();
    expect(repositories.enrichOpportunity).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ opportunityId: opp.id }),
      expect.stringContaining("[dry-run] Would add")
    );
  });

  it("persists and enriches opportunity when new evidence is found", async () => {
    const { app, repositories } = buildApp();

    const primaryEvidence = makeEvidence({
      id: "ev-origin",
      sourceItemId: sourceItemDbId(COMPANY_ID, "origin-1"),
      excerpt: "Automatic payroll recalculation streamlines compliance workflows when regulation changes arrive."
    });
    const opp = makeOpportunity({
      evidence: [primaryEvidence],
      primaryEvidence,
      supportingEvidenceCount: 0,
      enrichmentLog: []
    });

    repositories.listRecentActiveOpportunities.mockResolvedValue([makeOpportunityRow(opp)] as any);
    repositories.listCandidateSourceItems.mockResolvedValue([
      makeSourceItemRow({
        source: "market-research",
        sourceItemId: sourceItemDbId(COMPANY_ID, "support-1"),
        externalId: "support-1",
        title: "Payroll compliance automation trends",
        text: "Payroll recalculation automation improves compliance when regulations change across enterprise customers.",
        summary: "Payroll recalculation automation compliance trends."
      })
    ] as any);
    (repositories.listSourceItemsByIds as any).mockImplementation(async (ids: string[]) => {
      const rows = [
        makeSourceItemRow({
          sourceItemId: sourceItemDbId(COMPANY_ID, "origin-1"),
          externalId: "origin-1"
        }),
        makeSourceItemRow({
          source: "market-research",
          sourceItemId: sourceItemDbId(COMPANY_ID, "support-1"),
          externalId: "support-1",
          title: "Payroll compliance automation trends",
          text: "Payroll recalculation automation improves compliance when regulations change across enterprise customers.",
          summary: "Payroll recalculation automation compliance trends."
        })
      ];
      return rows.filter((row) => ids.includes(row.sourceItemId));
    });

    await app.run("backfill:evidence");

    expect(repositories.createSyncRun).toHaveBeenCalledTimes(1);
    expect(repositories.persistStandaloneEvidence).toHaveBeenCalledTimes(1);
    expect(repositories.enrichOpportunity).toHaveBeenCalledTimes(1);
  });

  it("is idempotent at the command path when equivalent evidence is already attached", async () => {
    const { app, repositories } = buildApp();

    const candidate = makeSourceItemRow({
      source: "market-research",
      sourceItemId: sourceItemDbId(COMPANY_ID, "market-research:mq-1:hash-1"),
      externalId: "market-research:mq-1:hash-1",
      title: "Enterprise buyers demand onboarding proof",
      text: "Enterprise buyers increasingly demand concrete proof of simple onboarding before purchasing decisions.",
      summary: "Onboarding proof for enterprise buyers"
    });

    const preBuiltEvidence = buildIntelligenceEvidence({
      source: "market-research",
      sourceItemId: candidate.sourceItemId,
      externalId: candidate.externalId,
      sourceFingerprint: candidate.fingerprint,
      sourceUrl: candidate.sourceUrl,
      title: candidate.title,
      text: candidate.text,
      summary: candidate.summary,
      occurredAt: candidate.occurredAt.toISOString(),
      ingestedAt: candidate.ingestedAt.toISOString(),
      metadata: {},
      rawPayload: {}
    }, COMPANY_ID, 1);

    const opp = makeOpportunity({
      evidence: preBuiltEvidence,
      primaryEvidence: preBuiltEvidence[0],
      supportingEvidenceCount: 0
    });

    repositories.listRecentActiveOpportunities.mockResolvedValue([makeOpportunityRow(opp)] as any);
    repositories.listCandidateSourceItems.mockResolvedValue([candidate] as any);

    await app.run("backfill:evidence");

    expect(repositories.persistStandaloneEvidence).not.toHaveBeenCalled();
    expect(repositories.enrichOpportunity).not.toHaveBeenCalled();
  });
});
