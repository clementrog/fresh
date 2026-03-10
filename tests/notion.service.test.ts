import { describe, expect, it, vi } from "vitest";

import { NotionService } from "../src/services/notion.js";

describe("notion service", () => {
  it("updates an existing page instead of creating a duplicate when page id is known", async () => {
    const pagesCreate = vi.fn(async () => ({ id: "page-created" }));
    const pagesUpdate = vi.fn(async () => ({}));
    const databasesQuery = vi.fn(async () => ({ results: [], has_more: false, next_cursor: null }));
    const databasesCreate = vi.fn(async () => ({ id: "db-signal" }));
    const databasesRetrieve = vi.fn(async () => ({
      object: "database",
      id: "db-signal",
      title: [{ plain_text: "Signal Feed" }],
      parent: { type: "page_id", page_id: "parent-page" }
    }));
    const search = vi.fn(async ({ query }: { query: string }) => {
      if (query === "Signal Feed") {
        return {
          results: [
            {
              object: "database",
              id: "db-signal",
              title: [{ plain_text: "Signal Feed" }],
              parent: { type: "page_id", page_id: "parent-page" }
            }
          ]
        };
      }

      return { results: [] };
    });

    const service = new NotionService("", "parent-page", {
      client: {
        pages: {
          create: pagesCreate,
          update: pagesUpdate
        },
        databases: {
          query: databasesQuery,
          create: databasesCreate,
          retrieve: databasesRetrieve
        },
        search
      } as never
    });

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

    expect(databasesRetrieve).not.toHaveBeenCalled();
    expect(pagesCreate).not.toHaveBeenCalled();
    expect(pagesUpdate).toHaveBeenCalledTimes(1);
  });

  it("reuses a persisted binding without searching globally", async () => {
    const bindingLookup = vi.fn(async () => ({ databaseId: "db-bound" }));
    const bindingUpsert = vi.fn(async () => ({}));
    const search = vi.fn(async () => ({ results: [] }));
    const databasesRetrieve = vi.fn(async () => ({
      object: "database",
      id: "db-bound",
      title: [{ plain_text: "Signal Feed" }],
      parent: { type: "page_id", page_id: "parent-page" }
    }));
    const pagesCreate = vi.fn(async () => ({ id: "page-created" }));
    const service = new NotionService("", "parent-page", {
      bindings: {
        getNotionDatabaseBinding: bindingLookup,
        upsertNotionDatabaseBinding: bindingUpsert
      },
      client: {
        pages: {
          create: pagesCreate,
          update: vi.fn(async () => ({}))
        },
        databases: {
          query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
          create: vi.fn(async () => ({ id: "db-created" })),
          retrieve: databasesRetrieve
        },
        search
      } as never
    });

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

    expect(bindingLookup).toHaveBeenCalledWith("parent-page", "Signal Feed");
    expect(databasesRetrieve).toHaveBeenCalledWith({ database_id: "db-bound" });
    expect(search).not.toHaveBeenCalled();
    expect(bindingUpsert).not.toHaveBeenCalled();
    expect(pagesCreate).not.toHaveBeenCalled();
  });

  it("fails closed when multiple same-name databases exist under the configured parent", async () => {
    const service = new NotionService("", "parent-page", {
      client: {
        pages: {
          create: vi.fn(async () => ({ id: "page-created" })),
          update: vi.fn(async () => ({}))
        },
        databases: {
          query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
          create: vi.fn(async () => ({ id: "db-created" })),
          retrieve: vi.fn(async () => ({}))
        },
        search: vi.fn(async () => ({
          results: [
            {
              object: "database",
              id: "db-1",
              title: [{ plain_text: "Signal Feed" }],
              parent: { type: "page_id", page_id: "parent-page" }
            },
            {
              object: "database",
              id: "db-2",
              title: [{ plain_text: "Signal Feed" }],
              parent: { type: "page_id", page_id: "parent-page" }
            }
          ]
        }))
      } as never
    });

    await expect(
      service.ensureSchema()
    ).rejects.toThrow('Multiple Notion databases named "Signal Feed" were found under the configured parent page.');
  });
});
