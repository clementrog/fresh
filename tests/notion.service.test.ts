import { describe, expect, it, vi } from "vitest";

import { mapReadinessTierToSelect, NotionService, REQUIRED_DATABASES } from "../src/services/notion.js";

function makeNotionClient(overrides: Record<string, unknown> = {}) {
  return {
    pages: {
      create: vi.fn(async () => ({ id: "page-created" })),
      update: vi.fn(async () => ({}))
    },
    databases: {
      query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
      create: vi.fn(async ({ title }: { title: Array<{ text: { content: string } }> }) => ({
        id: `db-${title[0]?.text.content ?? "unknown"}`
      })),
      retrieve: vi.fn(async () => ({ properties: {} })),
      update: vi.fn(async () => ({}))
    },
    search: vi.fn(async () => ({ results: [] })),
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

function makeClaapReviewItem(overrides: Record<string, unknown> = {}) {
  return {
    signalTitle: "Signal review title",
    publishabilityRisk: "reframeable" as const,
    originalSignalSummary: "The customer validated the outcome but described a trust gap during rollout.",
    keyExcerpts: [
      "We had doubts at first because the calculation trace was hard to follow.",
      "After testing, the result was correct and the team adopted it."
    ],
    whyBlocked: "Blocked as reframeable because the current framing still foregrounds customer doubt about the product.",
    reframingSuggestion: "Reframe around the validated outcome",
    transcriptLink: "https://app.claap.io/rec-1",
    occurredAt: "2026-03-19T10:00:00.000Z",
    reviewFingerprint: "claap-review-fp-1",
    claapSourceItemId: "si-claap-1",
    notionPageId: undefined as string | undefined,
    ...overrides
  };
}

describe("notion service", () => {
  it("ensureSchema creates exactly 5 databases", async () => {
    const client = makeNotionClient();
    const service = new NotionService("", "parent-page", { client });

    const result = await service.ensureSchema();

    expect(result.databases).toHaveLength(6);
    expect(REQUIRED_DATABASES).toEqual(["Content Opportunities", "Claap Review", "Linear Review", "GitHub Review", "Profiles", "Sync Runs"]);
  });

  it("ensureDatabase lazily patches missing properties on existing required databases", async () => {
    const databasesRetrieve = vi.fn(async () => ({
      object: "database",
      id: "db-opps",
      title: [{ plain_text: "Content Opportunities" }],
      parent: { type: "page_id", page_id: "parent-page" },
      properties: {
        Title: { title: {} },
        "Draft readiness": { id: "old-readiness", select: {} }
      }
    }));
    const databasesUpdate = vi.fn(async () => ({}));
    const client = makeNotionClient({
      databases: {
        query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
        create: vi.fn(async () => ({ id: "db-opps" })),
        retrieve: databasesRetrieve,
        update: databasesUpdate
      },
      search: vi.fn(async ({ query }: { query: string }) => {
        if (query === "Content Opportunities") {
          return {
            results: [{
              object: "database",
              id: "db-opps",
              title: [{ plain_text: "Content Opportunities" }],
              parent: { type: "page_id", page_id: "parent-page" }
            }]
          };
        }
        return { results: [] };
      })
    });

    const service = new NotionService("", "parent-page", { client });
    const opp = makeOpportunity();

    await service.syncOpportunity(opp, null);

    // Should have called databases.update to patch missing properties
    expect(databasesUpdate).toHaveBeenCalledTimes(1);
    const patchCall = (databasesUpdate.mock.calls[0] as any[])[0];
    expect(patchCall.database_id).toBe("db-opps");
    expect(patchCall.properties["Draft readiness"]).toEqual({ name: "How close is this to a draft?" });
    // Should include new properties like Enrichment log that aren't in the existing DB
    expect(patchCall.properties).toHaveProperty("Enrichment log");
    expect(patchCall.properties).not.toHaveProperty("How close is this to a draft?");

    // Second call should NOT patch again (cached)
    databasesUpdate.mockClear();
    databasesRetrieve.mockClear();
    await service.syncOpportunity(opp, null);
    expect(databasesUpdate).not.toHaveBeenCalled();
  });

  it("syncOpportunity on update writes editable fields when no pending request", async () => {
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

    expect(pagesUpdate).toHaveBeenCalledTimes(1);
    const updateProps = (pagesUpdate.mock.calls[0] as any[])[0].properties;
    expect(updateProps).not.toHaveProperty("Status");
    expect(updateProps).toHaveProperty("Title");
    expect(updateProps).toHaveProperty("Angle");
    expect(updateProps).toHaveProperty("Why now");
    expect(updateProps).toHaveProperty("What it is about");
    expect(updateProps).toHaveProperty("What it is not about");
    expect(updateProps).toHaveProperty("Source URL");
    expect(updateProps).toHaveProperty("Editorial notes");
    expect(updateProps).toHaveProperty("Editorial owner");
    expect(updateProps).toHaveProperty("How close is this to a draft?");
    expect(updateProps).toHaveProperty("Evidence count");
    expect(updateProps).not.toHaveProperty("Request re-evaluation");
    expect(updateProps).not.toHaveProperty("Draft readiness");
  });

  it("syncOpportunity on update suppresses editable fields when edits pending", async () => {
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

    expect(pagesUpdate).toHaveBeenCalledTimes(1);
    const updateProps = (pagesUpdate.mock.calls[0] as any[])[0].properties;
    // System fields still written
    expect(updateProps).toHaveProperty("How close is this to a draft?");
    expect(updateProps).toHaveProperty("Evidence count");
    expect(updateProps).toHaveProperty("Editorial owner");
    // Editable fields suppressed
    expect(updateProps).not.toHaveProperty("Title");
    expect(updateProps).not.toHaveProperty("Angle");
    expect(updateProps).not.toHaveProperty("Why now");
    expect(updateProps).not.toHaveProperty("What it is about");
    expect(updateProps).not.toHaveProperty("What it is not about");
    expect(updateProps).not.toHaveProperty("Source URL");
    expect(updateProps).not.toHaveProperty("Editorial notes");
    // Checkbox never touched
    expect(updateProps).not.toHaveProperty("Request re-evaluation");
  });

  it("syncOpportunity on create includes Status, Editorial notes, Editorial owner", async () => {
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
    const opp = makeOpportunity();

    await service.syncOpportunity(opp, null);

    expect(pagesCreate).toHaveBeenCalledTimes(1);
    const createProps = (pagesCreate.mock.calls[0] as any[])[0].properties;
    expect(createProps).toHaveProperty("Status");
    expect(createProps).toHaveProperty("Editorial notes");
    expect(createProps).toHaveProperty("Title");
    expect(createProps).toHaveProperty("Angle");
    expect(createProps).toHaveProperty("Editorial owner");
    expect(createProps).toHaveProperty("How close is this to a draft?");
    expect(createProps).not.toHaveProperty("Draft readiness");
    expect(createProps).not.toHaveProperty("Request re-evaluation");
  });

  it("syncOpportunity does not write Related signals, Routing status, Readiness, V1 history", async () => {
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
    const opp = makeOpportunity();

    await service.syncOpportunity(opp, null);

    const createProps = (pagesCreate.mock.calls[0] as any[])[0].properties;
    expect(createProps).not.toHaveProperty("Related signals");
    expect(createProps).not.toHaveProperty("Routing status");
    expect(createProps).not.toHaveProperty("Readiness");
    expect(createProps).not.toHaveProperty("V1 history");
  });

  it("syncOpportunity uses ownerDisplayName when provided", async () => {
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
    const opp = makeOpportunity();

    await service.syncOpportunity(opp, null, { ownerDisplayName: "Quentin Dupont" });

    const createProps = (pagesCreate.mock.calls[0] as any[])[0].properties;
    expect(createProps["Owner profile"].rich_text[0].text.content).toBe("Quentin Dupont");
  });

  it("syncOpportunity formats enrichmentLog entries correctly", async () => {
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
    const opp = makeOpportunity({
      enrichmentLog: [
        {
          createdAt: "2026-03-12T10:00:00Z",
          rawSourceItemId: "item-1",
          evidenceIds: ["e1"],
          contextComment: "Market report supports why-now",
          confidence: 0.6,
          reason: "enrichment"
        },
        {
          createdAt: "2026-03-13T10:00:00Z",
          rawSourceItemId: "item-2",
          evidenceIds: ["e2", "e3"],
          contextComment: "New customer feedback corroborates angle",
          confidence: 0.8,
          reason: "enrichment"
        }
      ]
    });

    await service.syncOpportunity(opp, null);

    const createProps = (pagesCreate.mock.calls[0] as any[])[0].properties;
    const logText = createProps["Enrichment log"].rich_text[0].text.content;
    expect(logText).toContain("[2026-03-12] +1 evidence, confidence 0.6");
    expect(logText).toContain("[2026-03-13] +2 evidence, confidence 0.8");
  });

  it("syncUser writes expected properties to Profiles database", async () => {
    const pagesCreate = vi.fn(async () => ({ id: "page-created" }));
    const client = makeNotionClient({
      pages: {
        create: pagesCreate,
        update: vi.fn(async () => ({}))
      },
      databases: {
        query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
        create: vi.fn(async () => ({ id: "db-profiles" })),
        retrieve: vi.fn(async () => ({ properties: {} })),
        update: vi.fn(async () => ({}))
      },
      search: vi.fn(async () => ({ results: [] }))
    });

    const service = new NotionService("", "parent-page", { client });

    await service.syncUser({
      displayName: "Quentin Dupont",
      type: "human",
      language: "fr",
      baseProfile: {
        toneSummary: "Direct and engaging",
        preferredStructure: "Hook > Context > Insight",
        typicalPhrases: ["en fait", "concrètement"],
        avoidRules: ["no jargon", "no clickbait"],
        contentTerritories: ["SaaS", "Product"],
        weakFitTerritories: ["Finance"],
        sampleExcerpts: ["Sample 1", "Sample 2"]
      },
      notionPageFingerprint: "user-fp-1"
    });

    expect(pagesCreate).toHaveBeenCalledTimes(1);
    const createProps = (pagesCreate.mock.calls[0] as any[])[0].properties;
    expect(createProps["Profile name"].title[0].text.content).toBe("Quentin Dupont");
    expect(createProps["Role"].rich_text[0].text.content).toBe("human");
    expect(createProps["Language preference"].rich_text[0].text.content).toBe("fr");
    expect(createProps["Tone summary"].rich_text[0].text.content).toBe("Direct and engaging");
    expect(createProps["Typical phrases"].rich_text[0].text.content).toBe("en fait, concrètement");
    expect(createProps["Content territories"].rich_text[0].text.content).toBe("SaaS, Product");
    // Old learned-layer fields should not be present
    expect(createProps).not.toHaveProperty("Base source");
    expect(createProps).not.toHaveProperty("Learned excerpt count");
    expect(createProps).not.toHaveProperty("Weekly recomputed at");
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
          retrieve: vi.fn(async () => ({ properties: {} })),
          update: vi.fn(async () => ({}))
        },
        search: vi.fn(async () => ({
          results: [
            {
              object: "database",
              id: "db-1",
              title: [{ plain_text: "Content Opportunities" }],
              parent: { type: "page_id", page_id: "parent-page" }
            },
            {
              object: "database",
              id: "db-2",
              title: [{ plain_text: "Content Opportunities" }],
              parent: { type: "page_id", page_id: "parent-page" }
            }
          ]
        }))
      } as never
    });

    await expect(
      service.ensureSchema()
    ).rejects.toThrow('Multiple Notion databases named "Content Opportunities" were found under the configured parent page.');
  });

  it("normalizes copied Notion parent page ids before creating databases", async () => {
    const databasesCreate = vi.fn(async () => ({ id: "db-created" }));
    const service = new NotionService("", "Org-chart-scorecards-e18a1733a60c4bbc8808243bd2006424", {
      client: {
        pages: {
          create: vi.fn(async () => ({ id: "page-created" })),
          update: vi.fn(async () => ({}))
        },
        databases: {
          query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
          create: databasesCreate,
          retrieve: vi.fn(async () => ({ properties: {} })),
          update: vi.fn(async () => ({}))
        },
        search: vi.fn(async ({ query }: { query: string }) => {
          if (query === "Editorial Signal Engine Operations Guide") {
            return { results: [] };
          }

          return { results: [] };
        })
      } as never
    });

    await service.ensureSchema();

    expect(databasesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: {
          type: "page_id",
          page_id: "e18a1733-a60c-4bbc-8808-243bd2006424"
        }
      })
    );
  });

  it("does not fail schema setup if the optional operations guide page cannot be created", async () => {
    const onWarning = vi.fn();
    const service = new NotionService("", "69156d08-b832-4135-9436-fc9cfdfe864e", {
      onWarning,
      client: {
        pages: {
          create: vi.fn(async () => {
            throw {
              status: 404,
              code: "object_not_found",
              message: "Could not find page"
            };
          }),
          update: vi.fn(async () => ({}))
        },
        databases: {
          query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
          create: vi.fn(async ({ title }: { title: Array<{ text: { content: string } }> }) => ({
            id: `db-${title[0]?.text.content ?? "unknown"}`
          })),
          retrieve: vi.fn(async () => ({ properties: {} })),
          update: vi.fn(async () => ({}))
        },
        search: vi.fn(async ({ query }: { query: string }) => {
          if (query === "Editorial Signal Engine Operations Guide") {
            return { results: [] };
          }

          return { results: [] };
        })
      } as never
    });

    const result = await service.ensureSchema();

    expect(result.databases).toHaveLength(6);
    expect(onWarning).toHaveBeenCalledWith(
      "Skipping Operations Guide creation because the configured Notion parent cannot accept child pages."
    );
  });

  it("manualReviewViewSpecs returns opportunity-centric views", async () => {
    const client = makeNotionClient();
    const service = new NotionService("", "parent-page", { client });
    const result = await service.ensureSchema();

    const viewNames = result.viewSpecs.map((v) => v.name);
    expect(viewNames).toContain("Content Opportunities / To review");
    expect(viewNames).toContain("Content Opportunities / Picked");
    expect(viewNames).toContain("Content Opportunities / Draft ready");
    expect(viewNames).toContain("Claap Review / Needs review");
    expect(viewNames).toContain("Claap Review / Needs rewrite");
    expect(viewNames).toContain("Claap Review / Rejected");
    expect(viewNames).toContain("Claap Review / Approved");
    expect(viewNames).toContain("Sync Runs / Recent");
    // Old signal-centric views should not be present
    expect(viewNames).not.toContain("Signal Feed / Needs review");
    expect(viewNames).not.toContain("Signal Feed / Sensitive review");
    expect(viewNames).not.toContain("Content Opportunities / Needs routing");
  });

  it("syncClaapReviewItem creates a review row with the expected fields", async () => {
    const pagesCreate = vi.fn(async () => ({ id: "review-page-created" }));
    const client = makeNotionClient({
      pages: {
        create: pagesCreate,
        update: vi.fn(async () => ({})),
        retrieve: vi.fn(async () => null)
      },
      databases: {
        query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
        create: vi.fn(async () => ({ id: "db-review" })),
        retrieve: vi.fn(async () => ({ properties: {} })),
        update: vi.fn(async () => ({}))
      }
    });
    const service = new NotionService("", "parent-page", { client });

    await service.syncClaapReviewItem(makeClaapReviewItem());

    expect(pagesCreate).toHaveBeenCalledTimes(1);
    const createProps = (pagesCreate.mock.calls[0] as any[])[0].properties;
    expect(createProps["Signal title"].title[0].text.content).toBe("Signal review title");
    expect(createProps["Publishability risk"].select.name).toBe("reframeable");
    expect(createProps["Original signal summary"].rich_text[0].text.content).toContain("validated the outcome");
    expect(createProps["Key excerpts"].rich_text[0].text.content).toContain("We had doubts at first");
    expect(createProps["Why blocked"].rich_text[0].text.content).toContain("Blocked as reframeable");
    expect(createProps["Reframing suggestion"].rich_text[0].text.content).toBe("Reframe around the validated outcome");
    expect(createProps["Transcript link"].url).toBe("https://app.claap.io/rec-1");
    expect(createProps.Decision.select).toBeNull();
  });

  it("syncClaapReviewItem preserves an existing non-empty decision on normal resync", async () => {
    const pagesUpdate = vi.fn(async () => ({}));
    const client = makeNotionClient({
      pages: {
        create: vi.fn(async () => ({ id: "review-page-created" })),
        update: pagesUpdate,
        retrieve: vi.fn(async () => ({
          id: "existing-review-page",
          properties: {
            "Signal title": { type: "title", title: [{ plain_text: "Signal review title" }] },
            "Publishability risk": { type: "select", select: { name: "reframeable" } },
            "Original signal summary": { type: "rich_text", rich_text: [{ plain_text: "The customer validated the outcome but described a trust gap during rollout." }] },
            "Reframing suggestion": { type: "rich_text", rich_text: [{ plain_text: "Reframe around the validated outcome" }] },
            Decision: { type: "select", select: { name: "needs rewrite" } }
          }
        }))
      }
    });
    const service = new NotionService("", "parent-page", { client });

    await service.syncClaapReviewItem(makeClaapReviewItem({ notionPageId: "existing-review-page" }));

    const updateProps = (pagesUpdate.mock.calls[0] as any[])[0].properties;
    expect(updateProps.Decision.select.name).toBe("needs rewrite");
  });

  it("syncClaapReviewItem resets decision when the review basis changes materially", async () => {
    const pagesUpdate = vi.fn(async () => ({}));
    const client = makeNotionClient({
      pages: {
        create: vi.fn(async () => ({ id: "review-page-created" })),
        update: pagesUpdate,
        retrieve: vi.fn(async () => ({
          id: "existing-review-page",
          properties: {
            "Signal title": { type: "title", title: [{ plain_text: "Old title" }] },
            "Publishability risk": { type: "select", select: { name: "reframeable" } },
            "Original signal summary": { type: "rich_text", rich_text: [{ plain_text: "Old summary" }] },
            "Reframing suggestion": { type: "rich_text", rich_text: [{ plain_text: "Old suggestion" }] },
            Decision: { type: "select", select: { name: "approve" } }
          }
        }))
      }
    });
    const service = new NotionService("", "parent-page", { client });

    await service.syncClaapReviewItem(makeClaapReviewItem({ notionPageId: "existing-review-page" }));

    const updateProps = (pagesUpdate.mock.calls[0] as any[])[0].properties;
    expect(updateProps.Decision.select).toBeNull();
  });

  it("archiveClaapReviewItem archives the review page", async () => {
    const pagesUpdate = vi.fn(async () => ({}));
    const service = new NotionService("", "parent-page", {
      client: makeNotionClient({
        pages: {
          create: vi.fn(async () => ({ id: "page-created" })),
          update: pagesUpdate,
          retrieve: vi.fn(async () => null)
        }
      })
    });

    await service.archiveClaapReviewItem("review-page-1");

    expect(pagesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        page_id: "review-page-1",
        archived: true
      })
    );
  });
});

// --- Archive idempotency ---

describe("archive idempotency", () => {
  it("archiveLinearReviewItem is a no-op when the page is already archived", async () => {
    const error = Object.assign(new Error("Can't edit block that is archived."), {
      status: 400, code: "validation_error"
    });
    const service = new NotionService("", "parent-page", {
      client: makeNotionClient({
        pages: {
          create: vi.fn(async () => ({ id: "page-created" })),
          update: vi.fn(async () => { throw error; }),
          retrieve: vi.fn(async () => null)
        }
      })
    });

    await expect(service.archiveLinearReviewItem("archived-page")).resolves.toBeUndefined();
  });

  it("archiveLinearReviewItem is a no-op when the page does not exist", async () => {
    const error = Object.assign(new Error("Could not find page"), {
      status: 404, code: "object_not_found"
    });
    const service = new NotionService("", "parent-page", {
      client: makeNotionClient({
        pages: {
          create: vi.fn(async () => ({ id: "page-created" })),
          update: vi.fn(async () => { throw error; }),
          retrieve: vi.fn(async () => null)
        }
      })
    });

    await expect(service.archiveLinearReviewItem("missing-page")).resolves.toBeUndefined();
  });

  it("archiveLinearReviewItem rethrows non-archive validation_error", async () => {
    const error = Object.assign(new Error("Title must not be empty"), {
      status: 400, code: "validation_error"
    });
    const service = new NotionService("", "parent-page", {
      client: makeNotionClient({
        pages: {
          create: vi.fn(async () => ({ id: "page-created" })),
          update: vi.fn(async () => { throw error; }),
          retrieve: vi.fn(async () => null)
        }
      })
    });

    await expect(service.archiveLinearReviewItem("page-1")).rejects.toThrow("Title must not be empty");
  });

  it("archiveLinearReviewItem rethrows unexpected errors", async () => {
    const error = new Error("network timeout");
    const service = new NotionService("", "parent-page", {
      client: makeNotionClient({
        pages: {
          create: vi.fn(async () => ({ id: "page-created" })),
          update: vi.fn(async () => { throw error; }),
          retrieve: vi.fn(async () => null)
        }
      })
    });

    await expect(service.archiveLinearReviewItem("page-1")).rejects.toThrow("network timeout");
  });

  it("archiveClaapReviewItem is a no-op when the page is already archived", async () => {
    const error = Object.assign(new Error("Can't edit block that is archived."), {
      status: 400, code: "validation_error"
    });
    const service = new NotionService("", "parent-page", {
      client: makeNotionClient({
        pages: {
          create: vi.fn(async () => ({ id: "page-created" })),
          update: vi.fn(async () => { throw error; }),
          retrieve: vi.fn(async () => null)
        }
      })
    });

    await expect(service.archiveClaapReviewItem("archived-page")).resolves.toBeUndefined();
  });
});

// --- mapReadinessTierToSelect ---

describe("mapReadinessTierToSelect", () => {
  it("ready → 'Draft now'", () => {
    expect(mapReadinessTierToSelect("ready")).toBe("Draft now");
  });

  it("promising → 'Good idea — one more input' (em-dash, no comma)", () => {
    const result = mapReadinessTierToSelect("promising");
    expect(result).toBe("Good idea — one more input");
    expect(result).not.toContain(","); // Notion API rejects commas in select options
  });

  it("undefined → 'Too early'", () => {
    expect(mapReadinessTierToSelect(undefined)).toBe("Too early");
  });

  it("needs-more-proof → 'Too early'", () => {
    expect(mapReadinessTierToSelect("needs-more-proof")).toBe("Too early");
  });
});

// --- readToneOfVoiceProfiles: body fallback ---

describe("readToneOfVoiceProfiles body fallback", () => {
  function makeTonePageWithProperties(profileName: string, voiceSummary: string, preferredPatterns: string, avoid: string) {
    return {
      object: "page",
      id: `page-${profileName.toLowerCase().replace(/\s/g, "-")}`,
      properties: {
        Profile: { type: "title", title: [{ plain_text: profileName }] },
        "Voice summary": { type: "rich_text", rich_text: voiceSummary ? [{ plain_text: voiceSummary }] : [] },
        "Preferred patterns": { type: "rich_text", rich_text: preferredPatterns ? [{ plain_text: preferredPatterns }] : [] },
        Avoid: { type: "rich_text", rich_text: avoid ? [{ plain_text: avoid }] : [] }
      }
    };
  }

  function makeBlocksResponse(blocks: Array<{ type: string; text: string; has_children?: boolean; id?: string }>) {
    return {
      results: blocks.map((b, i) => ({
        id: b.id ?? `block-${i}`,
        type: b.type,
        has_children: b.has_children ?? false,
        [b.type]: { rich_text: [{ plain_text: b.text }] }
      })),
      has_more: false,
      next_cursor: null
    };
  }

  it("reads page body when all properties are empty", async () => {
    const blocksChildrenList = vi.fn(async () =>
      makeBlocksResponse([
        { type: "heading_2", text: "Qui est Quentin sur la page" },
        { type: "paragraph", text: "Direct, conversational" },
        { type: "heading_2", text: "Comment il structure sa pensée" },
        { type: "paragraph", text: "Hook then insight" },
        { type: "heading_2", text: "Anti-modèles explicites" },
        { type: "paragraph", text: "No jargon" }
      ])
    );

    const databasesQuery = vi.fn(async () => ({
      results: [makeTonePageWithProperties("New Quentin", "", "", "")],
      has_more: false,
      next_cursor: null
    }));

    const client = makeNotionClient({
      databases: {
        query: databasesQuery,
        create: vi.fn(async () => ({ id: "db-tone" })),
        retrieve: vi.fn(async () => ({ properties: {} })),
        update: vi.fn(async () => ({}))
      },
      blocks: { children: { list: blocksChildrenList } }
    });

    const service = new NotionService("token", "parent-page", { client });
    const result = await service.readToneOfVoiceProfiles("db-tone");

    expect(blocksChildrenList).toHaveBeenCalledWith(
      expect.objectContaining({ block_id: "page-new-quentin" })
    );
    expect(result).toHaveLength(1);
    expect(result[0].voiceSummary).toBe("Direct, conversational");
    expect(result[0].preferredPatterns).toBe("Hook then insight");
    expect(result[0].avoid).toBe("No jargon");
    expect(result[0].source).toBe("body");
    expect(result[0].pageId).toBe("page-new-quentin");
  });

  it("does NOT read page body when properties are populated", async () => {
    const blocksChildrenList = vi.fn();

    const databasesQuery = vi.fn(async () => ({
      results: [makeTonePageWithProperties("Baptiste Le Bihan", "Confident tone", "Statement > Evidence", "Hedging")],
      has_more: false,
      next_cursor: null
    }));

    const client = makeNotionClient({
      databases: {
        query: databasesQuery,
        create: vi.fn(async () => ({ id: "db-tone" })),
        retrieve: vi.fn(async () => ({ properties: {} })),
        update: vi.fn(async () => ({}))
      },
      blocks: { children: { list: blocksChildrenList } }
    });

    const service = new NotionService("token", "parent-page", { client });
    const result = await service.readToneOfVoiceProfiles("db-tone");

    expect(blocksChildrenList).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].voiceSummary).toBe("Confident tone");
    expect(result[0].preferredPatterns).toBe("Statement > Evidence");
    expect(result[0].avoid).toBe("Hedging");
    expect(result[0].source).toBe("properties");
  });

  it("does NOT read page body when only some properties are populated (partial)", async () => {
    const blocksChildrenList = vi.fn();

    const databasesQuery = vi.fn(async () => ({
      results: [makeTonePageWithProperties("Thomas", "Only voice summary filled", "", "")],
      has_more: false,
      next_cursor: null
    }));

    const client = makeNotionClient({
      databases: {
        query: databasesQuery,
        create: vi.fn(async () => ({ id: "db-tone" })),
        retrieve: vi.fn(async () => ({ properties: {} })),
        update: vi.fn(async () => ({}))
      },
      blocks: { children: { list: blocksChildrenList } }
    });

    const service = new NotionService("token", "parent-page", { client });
    const result = await service.readToneOfVoiceProfiles("db-tone");

    expect(blocksChildrenList).not.toHaveBeenCalled();
    expect(result[0].voiceSummary).toBe("Only voice summary filled");
    expect(result[0].preferredPatterns).toBe("");
    expect(result[0].avoid).toBe("");
    expect(result[0].source).toBe("properties");
  });

  it("recurses into child blocks", async () => {
    const blocksChildrenList = vi.fn(async ({ block_id }: { block_id: string }) => {
      if (block_id === "page-quentin") {
        return {
          results: [
            {
              id: "toggle-1",
              type: "heading_2",
              has_children: true,
              heading_2: { rich_text: [{ plain_text: "Règles" }] }
            }
          ],
          has_more: false,
          next_cursor: null
        };
      }
      if (block_id === "toggle-1") {
        return {
          results: [
            {
              id: "child-1",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "Nested rule content" }] }
            }
          ],
          has_more: false,
          next_cursor: null
        };
      }
      return { results: [], has_more: false, next_cursor: null };
    });

    const databasesQuery = vi.fn(async () => ({
      results: [{
        object: "page",
        id: "page-quentin",
        properties: {
          Profile: { type: "title", title: [{ plain_text: "Quentin" }] },
          "Voice summary": { type: "rich_text", rich_text: [] },
          "Preferred patterns": { type: "rich_text", rich_text: [] },
          Avoid: { type: "rich_text", rich_text: [] }
        }
      }],
      has_more: false,
      next_cursor: null
    }));

    const client = makeNotionClient({
      databases: {
        query: databasesQuery,
        create: vi.fn(async () => ({ id: "db-tone" })),
        retrieve: vi.fn(async () => ({ properties: {} })),
        update: vi.fn(async () => ({}))
      },
      blocks: { children: { list: blocksChildrenList } }
    });

    const service = new NotionService("token", "parent-page", { client });
    const result = await service.readToneOfVoiceProfiles("db-tone");

    expect(result[0].avoid).toBe("Nested rule content");
  });

  it("property-backed equivalence: identical output for populated properties", async () => {
    const blocksChildrenList = vi.fn();

    const databasesQuery = vi.fn(async () => ({
      results: [
        makeTonePageWithProperties("Baptiste Le Bihan", "Confident", "Statement > Evidence", "Hedging"),
        makeTonePageWithProperties("Thomas", "Analytical", "Data > Conclusion", "Vagueness")
      ],
      has_more: false,
      next_cursor: null
    }));

    const client = makeNotionClient({
      databases: {
        query: databasesQuery,
        create: vi.fn(async () => ({ id: "db-tone" })),
        retrieve: vi.fn(async () => ({ properties: {} })),
        update: vi.fn(async () => ({}))
      },
      blocks: { children: { list: blocksChildrenList } }
    });

    const service = new NotionService("token", "parent-page", { client });
    const result = await service.readToneOfVoiceProfiles("db-tone");

    // No block API calls made
    expect(blocksChildrenList).not.toHaveBeenCalled();

    // Same field values as property-based extraction
    expect(result[0]).toMatchObject({
      profileName: "Baptiste Le Bihan",
      voiceSummary: "Confident",
      preferredPatterns: "Statement > Evidence",
      avoid: "Hedging",
      source: "properties"
    });
    expect(result[1]).toMatchObject({
      profileName: "Thomas",
      voiceSummary: "Analytical",
      preferredPatterns: "Data > Conclusion",
      avoid: "Vagueness",
      source: "properties"
    });
  });

  it("syncOpportunity includes 'Dedup flag' select property when dedupFlag is set", async () => {
    const pagesCreate = vi.fn(async () => ({ id: "page-created" }));
    const client = makeNotionClient({
      pages: { create: pagesCreate, update: vi.fn(async () => ({})) },
      databases: {
        query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
        create: vi.fn(async () => ({ id: "db-opps" })),
        retrieve: vi.fn(async () => ({ properties: {} })),
        update: vi.fn(async () => ({}))
      },
      search: vi.fn(async () => ({ results: [] }))
    });

    const service = new NotionService("", "parent-page", { client });
    const opp = makeOpportunity({ dedupFlag: "Possible duplicate" });

    await service.syncOpportunity(opp, null);

    expect(pagesCreate).toHaveBeenCalledTimes(1);
    const createProps = (pagesCreate.mock.calls[0] as any[])[0].properties;
    expect(createProps).toHaveProperty("Dedup flag");
    expect(createProps["Dedup flag"]).toEqual({
      select: { name: "Possible duplicate" }
    });
  });

  it("syncOpportunity clears 'Dedup flag' when dedupFlag is not set", async () => {
    const pagesCreate = vi.fn(async () => ({ id: "page-created" }));
    const client = makeNotionClient({
      pages: { create: pagesCreate, update: vi.fn(async () => ({})) },
      databases: {
        query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
        create: vi.fn(async () => ({ id: "db-opps" })),
        retrieve: vi.fn(async () => ({ properties: {} })),
        update: vi.fn(async () => ({}))
      },
      search: vi.fn(async () => ({ results: [] }))
    });

    const service = new NotionService("", "parent-page", { client });
    const opp = makeOpportunity();  // no dedupFlag

    await service.syncOpportunity(opp, null);

    expect(pagesCreate).toHaveBeenCalledTimes(1);
    const createProps = (pagesCreate.mock.calls[0] as any[])[0].properties;
    expect(createProps).toHaveProperty("Dedup flag");
    expect(createProps["Dedup flag"]).toEqual({ select: null });
  });

  it("writes GTM fields as editable properties on initial creation", async () => {
    const pagesCreate = vi.fn(async () => ({ id: "page-created" }));
    const client = makeNotionClient({
      pages: { create: pagesCreate, update: vi.fn(async () => ({})) }
    });
    const service = new NotionService("", "parent-page", { client });

    const opp = makeOpportunity({
      targetSegment: "production-manager",
      editorialPillar: "proof",
      awarenessTarget: "problem-aware",
      buyerFriction: "Calculation opacity",
      contentMotion: "demand-capture"
    });

    await service.syncOpportunity(opp as any, null);

    expect(pagesCreate).toHaveBeenCalledTimes(1);
    const createProps = (pagesCreate.mock.calls[0] as any[])[0].properties;
    expect(createProps["Target segment"]).toEqual({ select: { name: "production-manager" } });
    expect(createProps["Editorial pillar"]).toEqual({ select: { name: "proof" } });
    expect(createProps["Awareness target"]).toEqual({ select: { name: "problem-aware" } });
    expect(createProps["Buyer friction"]).toHaveProperty("rich_text");
    expect(createProps["Content motion"]).toEqual({ select: { name: "demand-capture" } });
  });

  it("does not overwrite GTM fields when notionEditsPending is true", async () => {
    const pagesUpdate = vi.fn(async () => ({}));
    const pagesCreate = vi.fn(async () => ({ id: "page-existing" }));
    const client = makeNotionClient({
      pages: { create: pagesCreate, update: pagesUpdate },
      databases: {
        query: vi.fn(async () => ({
          results: [{
            object: "page",
            id: "page-existing",
            properties: {
              "Opportunity fingerprint": { type: "rich_text", rich_text: [{ plain_text: "opp-fp-1" }] }
            }
          }],
          has_more: false,
          next_cursor: null
        })),
        create: vi.fn(async () => ({ id: "db-1" })),
        retrieve: vi.fn(async () => ({ properties: {} })),
        update: vi.fn(async () => ({}))
      }
    });
    const service = new NotionService("", "parent-page", { client });

    const opp = makeOpportunity({
      notionEditsPending: true,
      notionPageId: "page-existing",
      targetSegment: "production-manager",
      editorialPillar: "proof"
    });

    await service.syncOpportunity(opp as any, null);

    expect(pagesUpdate).toHaveBeenCalledTimes(1);
    const updateProps = (pagesUpdate.mock.calls[0] as any[])[0].properties;
    // When notionEditsPending is true, editable properties (including GTM) are NOT written
    expect(updateProps).not.toHaveProperty("Target segment");
    expect(updateProps).not.toHaveProperty("Editorial pillar");
    expect(updateProps).not.toHaveProperty("Title");
  });
});
