import { describe, expect, it, vi } from "vitest";

import { EditorialSignalEngineApp } from "../src/app.js";
import { scopeEvidenceReferences } from "../src/services/evidence.js";

function buildRepairRow() {
  const timestamp = new Date("2026-03-10T10:00:00.000Z");
  return {
    id: "opp_1",
    sourceFingerprint: "opp-fp-1",
    title: "Repair me",
    ownerProfile: "quentin",
    narrativePillar: "sales",
    angle: "Angle",
    whyNow: "Why now",
    whatItIsAbout: "About",
    whatItIsNotAbout: "Not about",
    routingStatus: "Routed",
    readiness: "Draft candidate",
    status: "Ready for V1",
    suggestedFormat: "Narrative lesson post",
    supportingEvidenceCount: 0,
    evidenceFreshness: 0.9,
    editorialOwner: null,
    selectedAt: null,
    lastDigestAt: null,
    updatedAt: new Date("2026-03-10T12:00:00.000Z"),
    primaryEvidenceId: "wrong_evidence_id",
    v1HistoryJson: [],
    notionPageId: null,
    notionPageFingerprint: "opp-fp-1",
    primaryEvidence: {
      id: "wrong_evidence_id",
      source: "slack",
      sourceItemId: "source-1",
      sourceUrl: "https://example.com",
      timestamp,
      excerpt: "Proof",
      excerptHash: "hash-1",
      speakerOrAuthor: null,
      freshnessScore: 0.9
    },
    relatedSignals: [
      {
        signalId: "signal_1",
        signal: {
          evidence: [
            {
              id: "signal_evidence_1",
              source: "slack",
              sourceItemId: "source-1",
              sourceUrl: "https://example.com",
              timestamp,
              excerpt: "Proof",
              excerptHash: "hash-1",
              speakerOrAuthor: null,
              freshnessScore: 0.9
            }
          ]
        }
      }
    ],
    evidence: [
      {
        id: "wrong_evidence_id",
        source: "slack",
        sourceItemId: "source-1",
        sourceUrl: "https://example.com",
        timestamp,
        excerpt: "Proof",
        excerptHash: "hash-1",
        speakerOrAuthor: null,
        freshnessScore: 0.9
      }
    ]
  };
}

describe("repair command", () => {
  it("repairs opportunities whose evidence counts look correct but IDs are not deterministically scoped", async () => {
    const unrepaired = buildRepairRow();
    const repairedEvidence = scopeEvidenceReferences("opportunity", unrepaired.id, [
      {
        id: "signal_evidence_1",
        source: "slack",
        sourceItemId: "source-1",
        sourceUrl: "https://example.com",
        timestamp: unrepaired.evidence[0].timestamp.toISOString(),
        excerpt: "Proof",
        excerptHash: "hash-1",
        freshnessScore: 0.9
      }
    ]);
    const repairedRow = {
      ...unrepaired,
      primaryEvidenceId: repairedEvidence[0]?.id ?? null,
      primaryEvidence: {
        ...unrepaired.primaryEvidence,
        id: repairedEvidence[0]?.id ?? ""
      },
      evidence: repairedEvidence.map((item) => ({
        id: item.id,
        source: item.source,
        sourceItemId: item.sourceItemId,
        sourceUrl: item.sourceUrl,
        timestamp: new Date(item.timestamp),
        excerpt: item.excerpt,
        excerptHash: item.excerptHash,
        speakerOrAuthor: item.speakerOrAuthor ?? null,
        freshnessScore: item.freshnessScore
      }))
    };

    const repositories = {
      createSyncRun: vi.fn(async () => ({})),
      listOpportunitiesForEvidenceRepairBatch: vi
        .fn()
        .mockResolvedValueOnce([unrepaired])
        .mockResolvedValueOnce([]),
      repairOpportunityEvidence: vi.fn(async () => repairedRow),
      updateSyncRun: vi.fn(async () => ({})),
      addCostEntries: vi.fn(async () => ({}))
    } as any;

    const app = new EditorialSignalEngineApp(
      {
        DATABASE_URL: "",
        NOTION_TOKEN: "",
        NOTION_PARENT_PAGE_ID: "parent-page",
        SLACK_BOT_TOKEN: "token",
        SLACK_EDITORIAL_OPERATOR_ID: "U123",
        OPENAI_API_KEY: "",
        CLAAP_API_KEY: "",
        LINEAR_API_KEY: "",
        DEFAULT_TIMEZONE: "Europe/Paris",
        LLM_MODEL: "test",
        LLM_TIMEOUT_MS: 100,
        LOG_LEVEL: "info"
      },
      {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
      },
      {
        repositories,
        notion: {
          syncOpportunity: vi.fn(async () => null),
          syncRun: vi.fn(async () => null)
        } as any,
        slack: {
          sendOperationalAlert: vi.fn(async () => ({}))
        } as any
      }
    );

    await app.run("repair:opportunity-evidence");

    expect(repositories.repairOpportunityEvidence).toHaveBeenCalledTimes(1);
    expect(repositories.repairOpportunityEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        opportunityId: "opp_1",
        primaryEvidenceId: repairedEvidence[0]?.id
      })
    );
  });
});
