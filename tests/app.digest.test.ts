import { describe, expect, it, vi } from "vitest";

import { EditorialSignalEngineApp } from "../src/app.js";
import { hashParts } from "../src/lib/ids.js";

function buildOpportunityRow(overrides: Record<string, unknown> = {}) {
  return {
    ...baseOpportunityRow(),
    ...overrides
  } as ReturnType<typeof baseOpportunityRow>;
}

function baseOpportunityRow() {
  const timestamp = new Date("2026-03-10T10:00:00.000Z");
  return {
    id: "opp_1",
    sourceFingerprint: "opp-fp-1",
    title: "Proof-led angle",
    ownerProfile: "quentin",
    narrativePillar: "sales",
    angle: "Angle",
    whyNow: "Fresh field proof is piling up this week.",
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
    primaryEvidenceId: "evidence_1",
    v1HistoryJson: [],
    notionPageId: "12345678-1234-1234-1234-1234567890ab",
    notionPageFingerprint: "opp-fp-1",
    primaryEvidence: {
      id: "evidence_1",
      source: "slack",
      sourceItemId: "source-1",
      sourceUrl: "https://example.com",
      timestamp,
      excerpt: "Prospects keep asking for proof of adoption in late-stage deals.",
      excerptHash: "hash-1",
      speakerOrAuthor: null,
      freshnessScore: 0.9
    },
    relatedSignals: [{ signalId: "signal_1" }],
    evidence: [
      {
        id: "evidence_1",
        source: "slack",
        sourceItemId: "source-1",
        sourceUrl: "https://example.com",
        timestamp,
        excerpt: "Prospects keep asking for proof of adoption in late-stage deals.",
        excerptHash: "hash-1",
        speakerOrAuthor: null,
        freshnessScore: 0.9
      }
    ]
  };
}

function buildDigestKey(items: Array<{ id: string; updatedAt: string }>, channel: string) {
  return hashParts([
    channel,
    ...items
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((item) => [item.id, item.updatedAt])
  ]);
}

function buildApp(repositories: any, slack: any, notion: any) {
  return new EditorialSignalEngineApp(
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
      notion,
      slack
    }
  );
}

describe("digest idempotency", () => {
  it("does not resend when a prior pending digest is recovered before candidate recomputation", async () => {
    const firstRow = buildOpportunityRow();
    const secondRow = buildOpportunityRow({
      updatedAt: new Date("2026-03-10T12:30:00.000Z"),
      lastDigestAt: new Date("2026-03-10T13:00:00.000Z")
    });
    const digestKey = buildDigestKey(
      [{ id: firstRow.id, updatedAt: firstRow.updatedAt.toISOString() }],
      "D123"
    );

    const repositories = {
      createSyncRun: vi.fn(async () => ({})),
      listRecoverableDigestDispatches: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            digestKey,
            status: "pending",
            channel: "D123",
            opportunityIds: ["opp_1"],
            leaseExpiresAt: new Date("2026-03-10T11:00:00.000Z").toISOString()
          }
        ]),
      listOpportunitiesForDigest: vi
        .fn()
        .mockResolvedValueOnce([firstRow])
        .mockResolvedValueOnce([secondRow]),
      acquireDigestDispatch: vi.fn(async () => ({
        action: "acquired",
        dispatch: {
          digestKey,
          status: "pending",
          channel: "D123",
          opportunityIds: ["opp_1"]
        }
      })),
      finalizeDigestDispatch: vi
        .fn()
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValueOnce({
          dispatch: {
            digestKey,
            status: "sent",
            channel: "D123",
            opportunityIds: ["opp_1"],
            slackMessageTs: "123.456"
          },
          opportunities: [secondRow]
        }),
      findOpportunitiesByIds: vi.fn(async () => [secondRow]),
      updateOpportunityNotionSync: vi.fn(async () => ({})),
      updateSyncRun: vi.fn(async () => ({})),
      addCostEntries: vi.fn(async () => ({})),
      markDigestDispatchFailed: vi.fn(async () => ({}))
    } as any;

    const slack = {
      resolveDigestChannelId: vi.fn(async () => "D123"),
      sendDigest: vi.fn(async () => ({
        ts: "123.456",
        channel: "D123"
      })),
      findRecentDigestByKey: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          ts: "123.456",
          channel: "D123"
        }),
      sendOperationalAlert: vi.fn(async () => ({}))
    } as any;

    const notion = {
      syncOpportunity: vi.fn(async () => ({
        notionPageId: "12345678-1234-1234-1234-1234567890ab",
        action: "updated"
      })),
      syncRun: vi.fn(async () => null)
    } as any;

    const app = buildApp(repositories, slack, notion);

    await app.run("digest:send");
    await app.run("digest:send");

    expect(slack.sendDigest).toHaveBeenCalledTimes(1);
    expect(slack.findRecentDigestByKey).toHaveBeenCalledTimes(2);
    expect(repositories.listRecoverableDigestDispatches).toHaveBeenCalledTimes(2);
    expect(repositories.finalizeDigestDispatch).toHaveBeenCalledTimes(2);
    expect(slack.sendOperationalAlert).toHaveBeenCalledTimes(1);
  });

  it("only marks the 5 displayed opportunities per profile as digested", async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      buildOpportunityRow({
        id: `opp_${index + 1}`,
        title: `Opportunity ${index + 1}`,
        sourceFingerprint: `opp-fp-${index + 1}`,
        notionPageFingerprint: `opp-fp-${index + 1}`,
        updatedAt: new Date(`2026-03-10T1${index}:00:00.000Z`)
      })
    );

    const repositories = {
      createSyncRun: vi.fn(async () => ({})),
      listRecoverableDigestDispatches: vi.fn(async () => []),
      listOpportunitiesForDigest: vi.fn(async () => rows),
      acquireDigestDispatch: vi.fn(async ({ opportunityIds }: { opportunityIds: string[] }) => ({
        action: "acquired",
        dispatch: {
          digestKey: "digest-key",
          status: "pending",
          channel: "D123",
          opportunityIds
        }
      })),
      finalizeDigestDispatch: vi.fn(async ({ opportunityIds }: { opportunityIds: string[] }) => ({
        dispatch: {
          digestKey: "digest-key",
          status: "sent",
          channel: "D123",
          opportunityIds,
          slackMessageTs: "123.456"
        },
        opportunities: rows.filter((row) => opportunityIds.includes(row.id))
      })),
      updateOpportunityNotionSync: vi.fn(async () => ({})),
      updateSyncRun: vi.fn(async () => ({})),
      addCostEntries: vi.fn(async () => ({})),
      markDigestDispatchFailed: vi.fn(async () => ({}))
    } as any;

    const slack = {
      resolveDigestChannelId: vi.fn(async () => "D123"),
      sendDigest: vi.fn(async () => ({
        ts: "123.456",
        channel: "D123"
      })),
      findRecentDigestByKey: vi.fn(async () => null),
      sendOperationalAlert: vi.fn(async () => ({}))
    } as any;

    const notion = {
      syncOpportunity: vi.fn(async () => null),
      syncRun: vi.fn(async () => null)
    } as any;

    const app = buildApp(repositories, slack, notion);

    await app.run("digest:send");

    expect(slack.sendDigest).toHaveBeenCalledTimes(1);
    const sentPayload = slack.sendDigest.mock.calls[0]?.[0];
    expect(sentPayload?.opportunities).toHaveLength(5);
    expect(repositories.acquireDigestDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        opportunityIds: ["opp_7", "opp_6", "opp_5", "opp_4", "opp_3"]
      })
    );
    expect(repositories.finalizeDigestDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        opportunityIds: ["opp_7", "opp_6", "opp_5", "opp_4", "opp_3"]
      })
    );
  });
});
