import { describe, expect, it, vi } from "vitest";

import { NotionService } from "../src/services/notion.js";

describe("notion service", () => {
  it("updates an existing page instead of creating a duplicate when page id is known", async () => {
    const pagesCreate = vi.fn(async () => ({ id: "page-created" }));
    const pagesUpdate = vi.fn(async () => ({}));
    const databasesQuery = vi.fn(async () => ({ results: [], has_more: false, next_cursor: null }));
    const databasesCreate = vi.fn(async () => ({ id: "db-signal" }));
    const search = vi.fn(async ({ query }: { query: string }) => {
      if (query === "Signal Feed") {
        return {
          results: [
            {
              object: "database",
              id: "db-signal",
              title: [{ plain_text: "Signal Feed" }]
            }
          ]
        };
      }

      return { results: [] };
    });

    const service = new NotionService("", "parent-page", {
      pages: {
        create: pagesCreate,
        update: pagesUpdate
      },
      databases: {
        query: databasesQuery,
        create: databasesCreate
      },
      search
    } as never);

    await service.syncSignal({
      id: "signal-1",
      sourceFingerprint: "signal-fp-1",
      title: "Signal",
      summary: "Summary",
      type: "quote",
      freshness: 0.8,
      confidence: 0.9,
      probableOwnerProfile: "quentin",
      suggestedAngle: "Angle",
      status: "New",
      evidence: [
        {
          id: "e1",
          source: "slack",
          sourceItemId: "slack:1",
          sourceUrl: "https://example.com",
          timestamp: new Date().toISOString(),
          excerpt: "Proof from Slack",
          excerptHash: "hash-1",
          freshnessScore: 0.8
        }
      ],
      sourceItemIds: ["slack:1"],
      sensitivity: {
        blocked: false,
        categories: [],
        rationale: "",
        stageOneMatchedRules: [],
        stageTwoScore: 0.1
      },
      notionPageId: "page-existing",
      notionPageFingerprint: "signal-fp-1"
    });

    expect(pagesCreate).not.toHaveBeenCalled();
    expect(pagesUpdate).toHaveBeenCalledTimes(1);
  });
});
