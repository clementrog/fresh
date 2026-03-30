import { describe, it, expect, vi } from "vitest";
import { NotionService, getDatabaseProperties } from "../src/services/notion.js";

function makeNotionClient(overrides: Record<string, unknown> = {}) {
  return {
    pages: {
      create: vi.fn(async () => ({ id: "page-created" })),
      update: vi.fn(async () => ({})),
      retrieve: vi.fn(async () => ({}))
    },
    databases: {
      query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
      create: vi.fn(async () => ({ id: "db-opps" })),
      retrieve: vi.fn(async () => ({ properties: {} })),
      update: vi.fn(async () => ({}))
    },
    search: vi.fn(async () => ({ results: [] })),
    blocks: { children: { list: vi.fn(async () => ({ results: [], has_more: false })) } },
    ...overrides
  } as never;
}

function makeOpportunity(overrides: Record<string, unknown> = {}) {
  return {
    id: "opp-1",
    sourceFingerprint: "opp-fp-1",
    title: "Opportunity",
    ownerProfile: "quentin" as const,
    narrativePillar: "Pillar",
    angle: "Angle",
    whyNow: "Why now",
    whatItIsAbout: "About",
    whatItIsNotAbout: "Not about",
    evidence: [
      {
        id: "e1",
        source: "notion" as const,
        sourceItemId: "slack:1",
        sourceUrl: "https://example.com",
        timestamp: new Date().toISOString(),
        excerpt: "Evidence excerpt",
        excerptHash: "hash-1",
        freshnessScore: 0.8
      }
    ],
    primaryEvidence: {
      id: "e1",
      source: "notion" as const,
      sourceItemId: "slack:1",
      sourceUrl: "https://example.com",
      timestamp: new Date().toISOString(),
      excerpt: "Evidence excerpt",
      excerptHash: "hash-1",
      freshnessScore: 0.8
    },
    supportingEvidenceCount: 0,
    evidenceFreshness: 0.8,
    evidenceExcerpts: ["Evidence excerpt"],
    routingStatus: "Routed" as const,
    readiness: "Opportunity only" as const,
    status: "To review" as const,
    suggestedFormat: "Article",
    enrichmentLog: [],
    editorialOwner: undefined,
    editorialNotes: "",
    notionEditsPending: false,
    selectedAt: undefined,
    v1History: [],
    notionPageId: undefined as string | undefined,
    notionPageFingerprint: "opp-fp-1",
    ...overrides
  };
}

function makeNotionPage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    object: "page",
    id,
    properties: {
      Title: { type: "title", title: [{ plain_text: "Edited Title" }] },
      Angle: { type: "rich_text", rich_text: [{ plain_text: "Edited Angle" }] },
      "Why now": { type: "rich_text", rich_text: [{ plain_text: "Edited Why now" }] },
      "What it is about": { type: "rich_text", rich_text: [{ plain_text: "Edited About" }] },
      "What it is not about": { type: "rich_text", rich_text: [{ plain_text: "Edited Not about" }] },
      "Source URL": { type: "rich_text", rich_text: [{ plain_text: "https://edited.com" }] },
      "Editorial notes": { type: "rich_text", rich_text: [{ plain_text: "User notes" }] },
      "Opportunity fingerprint": { type: "rich_text", rich_text: [{ plain_text: "opp-fp-1" }] },
      "Request re-evaluation": { type: "checkbox", checkbox: true },
      ...overrides
    }
  };
}

describe("Notion pull-edits", () => {
  // === Functional tests ===

  describe("schema", () => {
    it("1. includes Request re-evaluation checkbox property", () => {
      const props = getDatabaseProperties("Content Opportunities");
      expect(props).toHaveProperty("Request re-evaluation");
      expect((props as Record<string, unknown>)["Request re-evaluation"]).toEqual({ checkbox: {} });
    });
  });

  describe("listReEvaluationRequests", () => {
    it("2. returns only checked rows with all editable fields", async () => {
      const page = makeNotionPage("page-1");
      const databasesQuery = vi.fn(async () => ({
        results: [page],
        has_more: false,
        next_cursor: null
      }));
      const client = makeNotionClient({
        databases: {
          query: databasesQuery,
          create: vi.fn(async () => ({ id: "db-opps" })),
          retrieve: vi.fn(async () => ({ properties: {} })),
          update: vi.fn(async () => ({}))
        }
      });

      const service = new NotionService("", "parent-page", { client });
      const results = await service.listReEvaluationRequests();

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        notionPageId: "page-1",
        fingerprint: "opp-fp-1",
        title: "Edited Title",
        angle: "Edited Angle",
        whyNow: "Edited Why now",
        whatItIsAbout: "Edited About",
        whatItIsNotAbout: "Edited Not about",
        sourceUrl: "https://edited.com",
        editorialNotes: "User notes",
        targetSegment: "",
        editorialPillar: "",
        awarenessTarget: "",
        buyerFriction: "",
        contentMotion: ""
      });

      // Verify the filter was applied
      const queryCall = databasesQuery.mock.calls[0] as any[];
      expect(queryCall[0].filter).toEqual({
        property: "Request re-evaluation",
        checkbox: { equals: true }
      });
    });

    it("unsupported non-empty Notion GTM select values normalize to undefined (skipped writes)", async () => {
      const page = makeNotionPage("page-gtm", {
        "Target segment": { type: "select", select: { name: "ceo" } },
        "Editorial pillar": { type: "select", select: { name: "hot-take" } },
        "Awareness target": { type: "select", select: { name: "solution-aware" } },
        "Buyer friction": { type: "rich_text", rich_text: [{ plain_text: "Real friction text" }] },
        "Content motion": { type: "select", select: { name: "brand-awareness" } }
      });
      const client = makeNotionClient({
        databases: {
          query: vi.fn(async () => ({
            results: [page],
            has_more: false,
            next_cursor: null
          })),
          create: vi.fn(async () => ({ id: "db-opps" })),
          retrieve: vi.fn(async () => ({ properties: {} })),
          update: vi.fn(async () => ({}))
        }
      });

      const service = new NotionService("", "parent-page", { client });
      const results = await service.listReEvaluationRequests();

      expect(results).toHaveLength(1);
      const row = results[0];
      // Invalid enum values → undefined (conditional spread will skip, preserving DB)
      expect(row.targetSegment).toBeUndefined();
      expect(row.editorialPillar).toBeUndefined();
      // Valid enum → normalized
      expect(row.awarenessTarget).toBe("solution-aware");
      // Freeform → preserved as-is
      expect(row.buyerFriction).toBe("Real friction text");
      // Invalid enum → undefined
      expect(row.contentMotion).toBeUndefined();
    });

    it("cleared Notion GTM selects normalize to empty string (explicit clear)", async () => {
      const page = makeNotionPage("page-cleared", {
        "Target segment": { type: "select", select: null },
        "Editorial pillar": { type: "select", select: null },
        "Awareness target": { type: "select", select: null },
        "Buyer friction": { type: "rich_text", rich_text: [] },
        "Content motion": { type: "select", select: null }
      });
      const client = makeNotionClient({
        databases: {
          query: vi.fn(async () => ({
            results: [page],
            has_more: false,
            next_cursor: null
          })),
          create: vi.fn(async () => ({ id: "db-opps" })),
          retrieve: vi.fn(async () => ({ properties: {} })),
          update: vi.fn(async () => ({}))
        }
      });

      const service = new NotionService("", "parent-page", { client });
      const results = await service.listReEvaluationRequests();

      expect(results).toHaveLength(1);
      const row = results[0];
      // All cleared → "" (will persist as clear to DB via conditional spread)
      expect(row.targetSegment).toBe("");
      expect(row.editorialPillar).toBe("");
      expect(row.awarenessTarget).toBe("");
      expect(row.buyerFriction).toBe("");
      expect(row.contentMotion).toBe("");
    });

    it("3. returns empty array when no rows are checked", async () => {
      const client = makeNotionClient();
      const service = new NotionService("", "parent-page", { client });
      const results = await service.listReEvaluationRequests();
      expect(results).toEqual([]);
    });
  });

  describe("clearReEvaluationCheckbox", () => {
    it("5. unchecks the checkbox for a specific page", async () => {
      const pagesUpdate = vi.fn(async () => ({}));
      const client = makeNotionClient({
        pages: {
          create: vi.fn(async () => ({ id: "page-created" })),
          update: pagesUpdate,
          retrieve: vi.fn(async () => ({}))
        }
      });

      const service = new NotionService("", "parent-page", { client });
      await service.clearReEvaluationCheckbox("page-1");

      expect(pagesUpdate).toHaveBeenCalledTimes(1);
      const call = (pagesUpdate.mock.calls[0] as any[])[0];
      expect(call.page_id).toBe("page-1");
      expect(call.properties["Request re-evaluation"]).toEqual({ checkbox: false });
    });
  });

  describe("page body ignored", () => {
    it("7. listReEvaluationRequests reads only properties, never page body", async () => {
      const blocksChildrenList = vi.fn(async () => ({ results: [], has_more: false }));
      const client = makeNotionClient({
        databases: {
          query: vi.fn(async () => ({
            results: [makeNotionPage("page-1")],
            has_more: false,
            next_cursor: null
          })),
          create: vi.fn(async () => ({ id: "db-opps" })),
          retrieve: vi.fn(async () => ({ properties: {} })),
          update: vi.fn(async () => ({}))
        },
        blocks: { children: { list: blocksChildrenList } }
      });

      const service = new NotionService("", "parent-page", { client });
      await service.listReEvaluationRequests();

      expect(blocksChildrenList).not.toHaveBeenCalled();
    });
  });

  // === Safeguard tests ===

  describe("safeguards", () => {
    it("8. outbound sync never touches checkbox", async () => {
      const pagesUpdate = vi.fn(async () => ({}));
      const client = makeNotionClient({
        pages: {
          create: vi.fn(async () => ({ id: "page-created" })),
          update: pagesUpdate
        },
        databases: {
          query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
          create: vi.fn(async () => ({ id: "db-opps" })),
          retrieve: vi.fn(async () => ({ properties: {} })),
          update: vi.fn(async () => ({}))
        },
        search: vi.fn(async () => ({ results: [] }))
      });

      const service = new NotionService("", "parent-page", { client });
      const opp = makeOpportunity({ notionPageId: "existing-page" });
      await service.syncOpportunity(opp, null);

      const updateProps = (pagesUpdate.mock.calls[0] as any[])[0].properties;
      expect(updateProps).not.toHaveProperty("Request re-evaluation");
    });

    it("9. outbound sync suppresses editable fields when pending", async () => {
      const pagesUpdate = vi.fn(async () => ({}));
      const client = makeNotionClient({
        pages: {
          create: vi.fn(async () => ({ id: "page-created" })),
          update: pagesUpdate
        },
        databases: {
          query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
          create: vi.fn(async () => ({ id: "db-opps" })),
          retrieve: vi.fn(async () => ({ properties: {} })),
          update: vi.fn(async () => ({}))
        },
        search: vi.fn(async () => ({ results: [] }))
      });

      const service = new NotionService("", "parent-page", { client });
      const opp = makeOpportunity({ notionPageId: "existing-page", notionEditsPending: true });
      await service.syncOpportunity(opp, null);

      const updateProps = (pagesUpdate.mock.calls[0] as any[])[0].properties;
      // System fields still written
      expect(updateProps).toHaveProperty("How close is this to a draft?");
      expect(updateProps).toHaveProperty("Evidence count");
      // Editable fields suppressed
      expect(updateProps).not.toHaveProperty("Title");
      expect(updateProps).not.toHaveProperty("Angle");
      expect(updateProps).not.toHaveProperty("Why now");
      expect(updateProps).not.toHaveProperty("What it is about");
      expect(updateProps).not.toHaveProperty("What it is not about");
      expect(updateProps).not.toHaveProperty("Source URL");
      expect(updateProps).not.toHaveProperty("Editorial notes");
      expect(updateProps).not.toHaveProperty("Request re-evaluation");
    });

    it("10. outbound sync writes editable fields when NOT pending", async () => {
      const pagesUpdate = vi.fn(async () => ({}));
      const client = makeNotionClient({
        pages: {
          create: vi.fn(async () => ({ id: "page-created" })),
          update: pagesUpdate
        },
        databases: {
          query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
          create: vi.fn(async () => ({ id: "db-opps" })),
          retrieve: vi.fn(async () => ({ properties: {} })),
          update: vi.fn(async () => ({}))
        },
        search: vi.fn(async () => ({ results: [] }))
      });

      const service = new NotionService("", "parent-page", { client });
      const opp = makeOpportunity({ notionPageId: "existing-page", notionEditsPending: false });
      await service.syncOpportunity(opp, null);

      const updateProps = (pagesUpdate.mock.calls[0] as any[])[0].properties;
      expect(updateProps).toHaveProperty("Title");
      expect(updateProps).toHaveProperty("Angle");
      expect(updateProps).toHaveProperty("Why now");
      expect(updateProps).toHaveProperty("What it is about");
      expect(updateProps).toHaveProperty("What it is not about");
      expect(updateProps).toHaveProperty("Source URL");
      expect(updateProps).toHaveProperty("Editorial notes");
    });

    it("11. pull-edits sync-back writes editable fields with explicit flag", async () => {
      const pagesUpdate = vi.fn(async () => ({}));
      const client = makeNotionClient({
        pages: {
          create: vi.fn(async () => ({ id: "page-created" })),
          update: pagesUpdate
        },
        databases: {
          query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
          create: vi.fn(async () => ({ id: "db-opps" })),
          retrieve: vi.fn(async () => ({ properties: {} })),
          update: vi.fn(async () => ({}))
        },
        search: vi.fn(async () => ({ results: [] }))
      });

      const service = new NotionService("", "parent-page", { client });
      // Even with notionEditsPending=true, explicit flag overrides
      const opp = makeOpportunity({ notionPageId: "existing-page", notionEditsPending: true });
      await service.syncOpportunity(opp, null, { writeEditableFields: true });

      const updateProps = (pagesUpdate.mock.calls[0] as any[])[0].properties;
      expect(updateProps).toHaveProperty("Title");
      expect(updateProps).toHaveProperty("Angle");
      expect(updateProps).toHaveProperty("Editorial notes");
      expect(updateProps).not.toHaveProperty("Request re-evaluation");
    });

    it("12. create always includes editable fields regardless of pending state", async () => {
      const pagesCreate = vi.fn(async () => ({ id: "page-created" }));
      const client = makeNotionClient({
        pages: {
          create: pagesCreate,
          update: vi.fn(async () => ({}))
        },
        databases: {
          query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
          create: vi.fn(async () => ({ id: "db-opps" })),
          retrieve: vi.fn(async () => ({ properties: {} })),
          update: vi.fn(async () => ({}))
        },
        search: vi.fn(async () => ({ results: [] }))
      });

      const service = new NotionService("", "parent-page", { client });
      // No notionPageId = create path, with notionEditsPending=true
      const opp = makeOpportunity({ notionEditsPending: true });
      await service.syncOpportunity(opp, null);

      const createProps = (pagesCreate.mock.calls[0] as any[])[0].properties;
      expect(createProps).toHaveProperty("Title");
      expect(createProps).toHaveProperty("Angle");
      expect(createProps).toHaveProperty("Editorial notes");
      expect(createProps).toHaveProperty("Status");
      expect(createProps).not.toHaveProperty("Request re-evaluation");
    });
  });
});
