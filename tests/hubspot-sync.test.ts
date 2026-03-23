import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  parseSyncCursor,
  serializeSyncCursor,
  tryGraduate,
  advanceCursorForBatch,
  validateDoctrineForSync,
  REPLAY_MS,
  HubSpotSyncService,
  type HubSpotApiPort,
  type SyncCursor,
  type DealSearchResult,
} from "../src/sales/connectors/hubspot.js";
import type { RawHubSpotObject } from "../src/sales/connectors/hubspot-mappers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EPOCH = "1970-01-01T00:00:00.000Z";
const T = "2026-03-20T10:00:00.000Z";
const T_PLUS_1MS = new Date(Date.parse(T) + 1).toISOString();
const T_MINUS_REPLAY = new Date(Date.parse(T) - REPLAY_MS).toISOString();

function makeDeal(id: string, lastModified: string): RawHubSpotObject {
  return {
    id,
    properties: {
      dealname: `Deal ${id}`,
      dealstage: "negotiation",
      pipeline: "pipeline-1",
      amount: "10000",
      hubspot_owner_id: "owner-1",
      closedate: "2026-06-01T00:00:00.000Z",
      notes_last_updated: null,
      hs_lastmodifieddate: lastModified,
    },
    updatedAt: lastModified,
  };
}

function buildMockApi(overrides?: Partial<HubSpotApiPort>): HubSpotApiPort {
  return {
    searchDeals: vi.fn<any>().mockResolvedValue({ total: 0, results: [] } satisfies DealSearchResult),
    getContactById: vi.fn<any>().mockResolvedValue({ id: "c1", properties: {} }),
    getCompanyById: vi.fn<any>().mockResolvedValue({ id: "co1", properties: {} }),
    getAssociations: vi.fn<any>().mockResolvedValue([]),
    getEngagementById: vi.fn<any>().mockResolvedValue({ id: "e1", properties: {} }),
    ...overrides,
  };
}

function buildMockRepos(doctrineOverrides?: Record<string, unknown>) {
  const cursors = new Map<string, string>();
  const upsertDeal = vi.fn<any>().mockResolvedValue({});
  const upsertContact = vi.fn<any>().mockResolvedValue({});
  const upsertHubspotCompany = vi.fn<any>().mockResolvedValue({});
  const upsertActivity = vi.fn<any>().mockResolvedValue({});
  const linkDealContact = vi.fn<any>().mockResolvedValue({});
  const linkDealCompany = vi.fn<any>().mockResolvedValue({});
  const createSyncRun = vi.fn<any>().mockResolvedValue({ id: "run-1" });
  const finalizeSyncRun = vi.fn<any>().mockResolvedValue({});

  const repos = {
    getLatestDoctrine: vi.fn<any>().mockResolvedValue({
      doctrineJson: {
        hubspotPipelineId: "pipeline-1",
        stalenessThresholdDays: 21,
        ...doctrineOverrides,
      },
    }),
    getCursor: vi.fn().mockImplementation((...args: unknown[]) =>
      Promise.resolve(cursors.get(args[1] as string) ?? null)
    ),
    setCursor: vi.fn().mockImplementation((...args: unknown[]) => {
      const source = args[1] as string;
      const cursor = args[2] as string;
      cursors.set(source, cursor);
      return Promise.resolve({});
    }),
    createSyncRun,
    finalizeSyncRun,
    upsertDeal,
    upsertContact,
    upsertHubspotCompany,
    upsertActivity,
    linkDealContact,
    linkDealCompany,
    transaction: vi.fn().mockImplementation(async (...args: unknown[]) => {
      const fn = args[0] as (tx: unknown) => Promise<unknown>;
      return fn(repos);
    }),
  } as any;

  return { repos, cursors, spies: { upsertDeal, upsertContact, upsertHubspotCompany, upsertActivity, linkDealContact, linkDealCompany, createSyncRun, finalizeSyncRun } };
}

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

// ---------------------------------------------------------------------------
// parseSyncCursor
// ---------------------------------------------------------------------------

describe("parseSyncCursor", () => {
  it("returns default cursor for null", () => {
    expect(parseSyncCursor(null)).toEqual({ frontier: EPOCH, checkpoint: EPOCH, settledAt: null });
  });

  it("returns default cursor for empty string", () => {
    expect(parseSyncCursor("")).toEqual({ frontier: EPOCH, checkpoint: EPOCH, settledAt: null });
  });

  it("returns default cursor for non-JSON", () => {
    expect(parseSyncCursor("not-json")).toEqual({ frontier: EPOCH, checkpoint: EPOCH, settledAt: null });
  });

  it("returns default cursor for malformed JSON (missing fields)", () => {
    expect(parseSyncCursor(JSON.stringify({ foo: "bar" }))).toEqual({ frontier: EPOCH, checkpoint: EPOCH, settledAt: null });
  });

  it("returns default cursor for non-ISO dates", () => {
    expect(parseSyncCursor(JSON.stringify({ frontier: "not-a-date", checkpoint: T }))).toEqual({
      frontier: EPOCH, checkpoint: EPOCH, settledAt: null,
    });
  });

  it("returns valid cursor as-is", () => {
    const cursor: SyncCursor = { frontier: T, checkpoint: T, settledAt: null };
    expect(parseSyncCursor(serializeSyncCursor(cursor))).toEqual(cursor);
  });

  it("preserves settledAt when present", () => {
    const cursor: SyncCursor = { frontier: T, checkpoint: T, settledAt: T };
    expect(parseSyncCursor(serializeSyncCursor(cursor))).toEqual(cursor);
  });
});

// ---------------------------------------------------------------------------
// serializeSyncCursor
// ---------------------------------------------------------------------------

describe("serializeSyncCursor", () => {
  it("round-trips correctly with parseSyncCursor", () => {
    const cursor: SyncCursor = { frontier: T, checkpoint: T, settledAt: T };
    expect(parseSyncCursor(serializeSyncCursor(cursor))).toEqual(cursor);
  });
});

// ---------------------------------------------------------------------------
// tryGraduate
// ---------------------------------------------------------------------------

describe("tryGraduate", () => {
  it("no-op when settledAt is null", () => {
    const cursor: SyncCursor = { frontier: T_MINUS_REPLAY, checkpoint: T, settledAt: null };
    expect(tryGraduate(cursor, new Date())).toBe(cursor);
  });

  it("no-op when REPLAY_MS not elapsed", () => {
    const settledAt = new Date().toISOString();
    const cursor: SyncCursor = { frontier: T_MINUS_REPLAY, checkpoint: T, settledAt };
    expect(tryGraduate(cursor, new Date())).toBe(cursor);
  });

  it("advances frontier to checkpoint+1ms when settled long enough", () => {
    const settledAt = new Date(Date.now() - REPLAY_MS - 1000).toISOString();
    const cursor: SyncCursor = { frontier: T_MINUS_REPLAY, checkpoint: T, settledAt };
    const result = tryGraduate(cursor, new Date());
    expect(result.frontier).toBe(T_PLUS_1MS);
  });

  it("checkpoint stays unchanged after graduation", () => {
    const settledAt = new Date(Date.now() - REPLAY_MS - 1000).toISOString();
    const cursor: SyncCursor = { frontier: T_MINUS_REPLAY, checkpoint: T, settledAt };
    const result = tryGraduate(cursor, new Date());
    expect(result.checkpoint).toBe(T);
  });

  it("resets settledAt after graduation", () => {
    const settledAt = new Date(Date.now() - REPLAY_MS - 1000).toISOString();
    const cursor: SyncCursor = { frontier: T_MINUS_REPLAY, checkpoint: T, settledAt };
    const result = tryGraduate(cursor, new Date());
    expect(result.settledAt).toBeNull();
  });

  it("idempotent when frontier already at checkpoint+1ms", () => {
    const settledAt = new Date(Date.now() - REPLAY_MS - 1000).toISOString();
    const cursor: SyncCursor = { frontier: T_PLUS_1MS, checkpoint: T, settledAt };
    const result = tryGraduate(cursor, new Date());
    expect(result.frontier).toBe(T_PLUS_1MS);
    expect(result.checkpoint).toBe(T);
  });
});

// ---------------------------------------------------------------------------
// advanceCursorForBatch
// ---------------------------------------------------------------------------

describe("advanceCursorForBatch", () => {
  it("returns cursor unchanged when batchMax <= checkpoint", () => {
    const cursor: SyncCursor = { frontier: T_MINUS_REPLAY, checkpoint: T, settledAt: null };
    expect(advanceCursorForBatch(T, cursor)).toBe(cursor);
    expect(advanceCursorForBatch(T_MINUS_REPLAY, cursor)).toBe(cursor);
  });

  it("advances checkpoint to batchMax when batchMax > checkpoint", () => {
    const cursor: SyncCursor = { frontier: EPOCH, checkpoint: EPOCH, settledAt: null };
    const result = advanceCursorForBatch(T, cursor);
    expect(result.checkpoint).toBe(T);
  });

  it("sets frontier = checkpoint - REPLAY_MS unconditionally", () => {
    const cursor: SyncCursor = { frontier: EPOCH, checkpoint: EPOCH, settledAt: null };
    const result = advanceCursorForBatch(T, cursor);
    expect(result.frontier).toBe(T_MINUS_REPLAY);
  });

  it("resets settledAt when advancing", () => {
    const cursor: SyncCursor = { frontier: EPOCH, checkpoint: EPOCH, settledAt: T };
    const result = advanceCursorForBatch(T, cursor);
    expect(result.settledAt).toBeNull();
  });

  it("reopens replay window even if frontier had graduated past previous checkpoint", () => {
    // After graduation: frontier = T+1ms, checkpoint = T (frontier > checkpoint)
    const cursor: SyncCursor = { frontier: T_PLUS_1MS, checkpoint: T, settledAt: null };
    const newTimestamp = "2026-03-20T10:00:00.001Z"; // T+1ms
    const result = advanceCursorForBatch(newTimestamp, cursor);
    // checkpoint = T+1ms, frontier = T+1ms - REPLAY_MS (behind checkpoint)
    expect(result.checkpoint).toBe(newTimestamp);
    expect(Date.parse(result.frontier)).toBeLessThan(Date.parse(result.checkpoint));
  });
});

// ---------------------------------------------------------------------------
// validateDoctrineForSync
// ---------------------------------------------------------------------------

describe("validateDoctrineForSync", () => {
  it("fails when hubspotPipelineId is missing", () => {
    expect(() => validateDoctrineForSync({})).toThrow("hubspotPipelineId");
  });

  it("fails when hubspotPipelineId is empty string", () => {
    expect(() => validateDoctrineForSync({ hubspotPipelineId: "" })).toThrow("hubspotPipelineId");
  });

  it("proceeds when doctrine has valid hubspotPipelineId", () => {
    const result = validateDoctrineForSync({ hubspotPipelineId: "pipe-1" });
    expect(result.hubspotPipelineId).toBe("pipe-1");
    expect(result.stalenessThresholdDays).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// HubSpotSyncService
// ---------------------------------------------------------------------------

describe("HubSpotSyncService", () => {
  describe("doctrine validation", () => {
    it("fails when no SalesDoctrine exists", async () => {
      const api = buildMockApi();
      const { repos } = buildMockRepos();
      repos.getLatestDoctrine = vi.fn<any>().mockResolvedValue(null);
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await expect(svc.runSync("comp-1")).rejects.toThrow("No SalesDoctrine found");
    });

    it("fails with field-level error when hubspotPipelineId is empty", async () => {
      const api = buildMockApi();
      const { repos } = buildMockRepos({ hubspotPipelineId: "" });
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await expect(svc.runSync("comp-1")).rejects.toThrow("hubspotPipelineId");
    });
  });

  describe("core sync flow", () => {
    it("creates SyncRun at start and finalizes on completion", async () => {
      const api = buildMockApi();
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      expect(spies.createSyncRun).toHaveBeenCalledWith(expect.objectContaining({ companyId: "comp-1", runType: "sales:sync" }));
      expect(spies.finalizeSyncRun).toHaveBeenCalledWith("run-1", "completed", expect.anything(), expect.anything());
    });

    it("finalizes SyncRun as 'failed' on error", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockRejectedValue(new Error("API error")),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await expect(svc.runSync("comp-1")).rejects.toThrow("API error");
      expect(spies.finalizeSyncRun).toHaveBeenCalledWith("run-1", "failed", expect.anything(), expect.anything(), expect.stringContaining("API error"));
    });

    it("fetches deals filtered by pipeline from doctrine", async () => {
      const api = buildMockApi();
      const { repos } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      expect(api.searchDeals).toHaveBeenCalledWith(
        expect.objectContaining({
          filterGroups: [
            {
              filters: expect.arrayContaining([
                expect.objectContaining({ propertyName: "pipeline", operator: "EQ", value: "pipeline-1" }),
              ]),
            },
          ],
        })
      );
    });

    it("uses cursor frontier as hs_lastmodifieddate GTE filter", async () => {
      const api = buildMockApi();
      const { repos, cursors } = buildMockRepos();
      cursors.set("hubspot:deals", serializeSyncCursor({ frontier: T, checkpoint: T, settledAt: null }));
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      expect(api.searchDeals).toHaveBeenCalledWith(
        expect.objectContaining({
          filterGroups: [
            {
              filters: expect.arrayContaining([
                expect.objectContaining({ propertyName: "hs_lastmodifieddate", operator: "GTE", value: T }),
              ]),
            },
          ],
        })
      );
    });

    it("paginates deal search until no more pages", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>()
          .mockResolvedValueOnce({
            total: 2,
            results: [makeDeal("d1", T)],
            paging: { next: { after: "page2" } },
          })
          .mockResolvedValueOnce({
            total: 2,
            results: [makeDeal("d2", T)],
          }),
      });
      const { repos } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      expect(api.searchDeals).toHaveBeenCalledTimes(2);
    });
  });

  describe("cursor checkpoint + frontier", () => {
    it("first sync uses epoch frontier", async () => {
      const api = buildMockApi();
      const { repos } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      expect(api.searchDeals).toHaveBeenCalledWith(
        expect.objectContaining({
          filterGroups: [
            {
              filters: expect.arrayContaining([
                expect.objectContaining({ propertyName: "hs_lastmodifieddate", operator: "GTE", value: EPOCH }),
              ]),
            },
          ],
        })
      );
    });

    it("advances checkpoint per-batch", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
      });
      const { repos, cursors } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      const saved = parseSyncCursor(cursors.get("hubspot:deals") ?? null);
      expect(saved.checkpoint).toBe(T);
      expect(saved.frontier).toBe(T_MINUS_REPLAY);
    });

    it("does NOT advance cursor when transaction fails", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
      });
      const { repos, cursors } = buildMockRepos();
      repos.transaction = vi.fn<any>().mockRejectedValue(new Error("TX failed"));
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await expect(svc.runSync("comp-1")).rejects.toThrow("TX failed");
      expect(cursors.has("hubspot:deals")).toBe(false);
    });
  });

  describe("settling and graduation", () => {
    it("sets settledAt when no forward progress", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
      });
      const { repos, cursors } = buildMockRepos();
      // Pre-set cursor with checkpoint already at T
      cursors.set("hubspot:deals", serializeSyncCursor({ frontier: T_MINUS_REPLAY, checkpoint: T, settledAt: null }));
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      const saved = parseSyncCursor(cursors.get("hubspot:deals") ?? null);
      expect(saved.settledAt).not.toBeNull();
    });

    it("graduates frontier when REPLAY_MS elapsed", async () => {
      const api = buildMockApi(); // empty results
      const { repos, cursors } = buildMockRepos();
      const settledAt = new Date(Date.now() - REPLAY_MS - 1000).toISOString();
      cursors.set("hubspot:deals", serializeSyncCursor({ frontier: T_MINUS_REPLAY, checkpoint: T, settledAt }));
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      const saved = parseSyncCursor(cursors.get("hubspot:deals") ?? null);
      expect(saved.frontier).toBe(T_PLUS_1MS);
      expect(saved.checkpoint).toBe(T); // checkpoint unchanged
    });
  });

  describe("no-op rerun behavior", () => {
    it("empty results with no prior cursor = zero writes, settledAt set", async () => {
      const api = buildMockApi();
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      const result = await svc.runSync("comp-1");
      expect(result.counters.deals).toBe(0);
      expect(spies.upsertDeal).not.toHaveBeenCalled();
    });
  });

  describe("data persistence", () => {
    it("upserts deal with correct mapped fields", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      expect(spies.upsertDeal).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "comp-1",
          hubspotDealId: "d1",
          dealName: "Deal d1",
          pipeline: "pipeline-1",
        }),
        expect.anything()
      );
    });

    it("fetches and upserts associated contacts with linkDealContact", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
        getAssociations: vi.fn().mockImplementation(
          (fromType: string, _fromId: string, toType: string) => {
            if (fromType === "deals" && toType === "contacts") return Promise.resolve([{ toObjectId: "c1" }]);
            return Promise.resolve([]);
          }
        ),
        getContactById: vi.fn<any>().mockResolvedValue({
          id: "c1",
          properties: { email: "alice@test.com", firstname: "Alice", lastname: "Smith", jobtitle: null, company: null },
        }),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      const result = await svc.runSync("comp-1");
      expect(spies.upsertContact).toHaveBeenCalledWith(
        expect.objectContaining({ hubspotContactId: "c1", email: "alice@test.com" }),
        expect.anything()
      );
      expect(spies.linkDealContact).toHaveBeenCalled();
      expect(result.counters.contacts).toBe(1);
      expect(result.counters.associations).toBeGreaterThanOrEqual(1);
    });

    it("fetches and upserts associated companies with linkDealCompany using internal ID", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
        getAssociations: vi.fn().mockImplementation(
          (fromType: string, _fromId: string, toType: string) => {
            if (fromType === "deals" && toType === "companies") return Promise.resolve([{ toObjectId: "co1" }]);
            return Promise.resolve([]);
          }
        ),
        getCompanyById: vi.fn<any>().mockResolvedValue({
          id: "co1",
          properties: { name: "Acme", domain: "acme.com", industry: "SaaS", numberofemployees: "50" },
        }),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      expect(spies.upsertHubspotCompany).toHaveBeenCalled();
      expect(spies.linkDealCompany).toHaveBeenCalled();
    });

    it("sets rawTextExpiresAt for activities with body text", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
        getAssociations: vi.fn().mockImplementation(
          (fromType: string, _fromId: string, toType: string) => {
            if (fromType === "deals" && toType === "emails") return Promise.resolve([{ toObjectId: "e1" }]);
            return Promise.resolve([]);
          }
        ),
        getEngagementById: vi.fn<any>().mockResolvedValue({
          id: "e1",
          properties: { hs_email_text: "Hello", hs_timestamp: T },
        }),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      expect(spies.upsertActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "Hello",
          rawTextExpiresAt: expect.any(Date),
        }),
        expect.anything()
      );
      const activityCall = spies.upsertActivity.mock.calls[0][0] as { rawTextExpiresAt: Date };
      expect(activityCall.rawTextExpiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("sets rawTextExpiresAt to null for bodyless activities", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
        getAssociations: vi.fn().mockImplementation(
          (fromType: string, _fromId: string, toType: string) => {
            if (fromType === "deals" && toType === "notes") return Promise.resolve([{ toObjectId: "n1" }]);
            return Promise.resolve([]);
          }
        ),
        getEngagementById: vi.fn<any>().mockResolvedValue({
          id: "n1",
          properties: { hs_note_body: null, hs_timestamp: T },
        }),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      expect(spies.upsertActivity).toHaveBeenCalledWith(
        expect.objectContaining({ rawTextExpiresAt: null }),
        expect.anything()
      );
    });
  });

  describe("association deduplication", () => {
    it("dedupes contact IDs before fetching", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
        getAssociations: vi.fn().mockImplementation(
          (fromType: string, _fromId: string, toType: string) => {
            if (fromType === "deals" && toType === "contacts") {
              // HubSpot returns duplicates
              return Promise.resolve([{ toObjectId: "c1" }, { toObjectId: "c1" }, { toObjectId: "c2" }]);
            }
            return Promise.resolve([]);
          }
        ),
        getContactById: vi.fn<any>().mockResolvedValue({
          id: "c1",
          properties: { email: "a@b.com", firstname: null, lastname: null, jobtitle: null, company: null },
        }),
      });
      const { repos } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      // getContactById should be called 2 times (c1 and c2), not 3
      expect(api.getContactById).toHaveBeenCalledTimes(2);
    });
  });

  describe("error handling / partial failures", () => {
    it("contact fetch failure: warning logged, deal still persisted", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
        getAssociations: vi.fn().mockImplementation(
          (fromType: string, _fromId: string, toType: string) => {
            if (fromType === "deals" && toType === "contacts") return Promise.resolve([{ toObjectId: "c1" }]);
            return Promise.resolve([]);
          }
        ),
        getContactById: vi.fn<any>().mockRejectedValue(new Error("404 not found")),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      const result = await svc.runSync("comp-1");
      expect(spies.upsertDeal).toHaveBeenCalled();
      expect(spies.upsertContact).not.toHaveBeenCalled();
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("association discovery failure: warning logged, deal still persisted", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
        getAssociations: vi.fn<any>().mockRejectedValue(new Error("Assoc API error")),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      const result = await svc.runSync("comp-1");
      expect(spies.upsertDeal).toHaveBeenCalled();
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("deal upsert failure rolls back transaction and fails run", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
      });
      const { repos } = buildMockRepos();
      repos.transaction = vi.fn<any>().mockRejectedValue(new Error("upsertDeal failed"));
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await expect(svc.runSync("comp-1")).rejects.toThrow("upsertDeal failed");
    });
  });

  describe("authoritative relationship assignment", () => {
    it("resolves contactId from engagement-contact association", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
        getAssociations: vi.fn().mockImplementation(
          (fromType: string, _fromId: string, toType: string) => {
            if (fromType === "deals" && toType === "emails") return Promise.resolve([{ toObjectId: "e1" }]);
            if (fromType === "emails" && toType === "contacts") return Promise.resolve([{ toObjectId: "c1" }]);
            return Promise.resolve([]);
          }
        ),
        getEngagementById: vi.fn<any>().mockResolvedValue({
          id: "e1",
          properties: { hs_email_text: "Hi", hs_timestamp: T },
        }),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      expect(spies.upsertActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: expect.stringMatching(/^sc_/), // internal deterministic ID
        }),
        expect.anything()
      );
    });

    it("sets contactId to null when no engagement-contact association", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
        getAssociations: vi.fn().mockImplementation(
          (fromType: string, _fromId: string, toType: string) => {
            if (fromType === "deals" && toType === "emails") return Promise.resolve([{ toObjectId: "e1" }]);
            // No engagement-contact association
            return Promise.resolve([]);
          }
        ),
        getEngagementById: vi.fn<any>().mockResolvedValue({
          id: "e1",
          properties: { hs_email_text: "Hi", hs_timestamp: T },
        }),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      expect(spies.upsertActivity).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: null }),
        expect.anything()
      );
    });

    it("fetches engagement-contact not in deal-contact path so FK is safe", async () => {
      // Contact c99 is only associated with the engagement, not with the deal.
      // The service must fetch and upsert c99 before writing the activity FK.
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
        getAssociations: vi.fn().mockImplementation(
          (fromType: string, _fromId: string, toType: string) => {
            if (fromType === "deals" && toType === "contacts") return Promise.resolve([]); // no deal-contact
            if (fromType === "deals" && toType === "emails") return Promise.resolve([{ toObjectId: "e1" }]);
            if (fromType === "emails" && toType === "contacts") return Promise.resolve([{ toObjectId: "c99" }]);
            return Promise.resolve([]);
          }
        ),
        getContactById: vi.fn<any>().mockResolvedValue({
          id: "c99", properties: { email: "eng@test.com", firstname: null, lastname: null, jobtitle: null, company: null },
        }),
        getEngagementById: vi.fn<any>().mockResolvedValue({
          id: "e1", properties: { hs_email_text: "Hi", hs_timestamp: T },
        }),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      const result = await svc.runSync("comp-1");

      // Contact c99 must be upserted (so FK is valid)
      expect(spies.upsertContact).toHaveBeenCalledWith(
        expect.objectContaining({ hubspotContactId: "c99" }),
        expect.anything()
      );
      // Activity contactId must be set (not null)
      expect(spies.upsertActivity).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: expect.stringMatching(/^sc_/) }),
        expect.anything()
      );
      // No deal-contact link created (contact came via engagement path)
      expect(spies.linkDealContact).not.toHaveBeenCalled();
      expect(result.warnings.length).toBe(0);
    });

    it("leaves contactId null when engagement-contact fetch fails", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
        getAssociations: vi.fn().mockImplementation(
          (fromType: string, _fromId: string, toType: string) => {
            if (fromType === "deals" && toType === "emails") return Promise.resolve([{ toObjectId: "e1" }]);
            if (fromType === "emails" && toType === "contacts") return Promise.resolve([{ toObjectId: "c99" }]);
            return Promise.resolve([]);
          }
        ),
        getContactById: vi.fn<any>().mockRejectedValue(new Error("404")),
        getEngagementById: vi.fn<any>().mockResolvedValue({
          id: "e1", properties: { hs_email_text: "Hi", hs_timestamp: T },
        }),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      const result = await svc.runSync("comp-1");

      // Activity persisted with null contactId (FK-safe)
      expect(spies.upsertActivity).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: null }),
        expect.anything()
      );
      // Deal still persisted
      expect(spies.upsertDeal).toHaveBeenCalled();
      // Warning logged
      expect(result.warnings.some((w) => w.includes("contact not persisted"))).toBe(true);
    });
  });

  describe("settling only when no forward progress", () => {
    it("does NOT set settledAt when checkpoint advanced", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
      });
      const { repos, cursors } = buildMockRepos();
      // Start with epoch cursor — checkpoint will advance to T
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      const saved = parseSyncCursor(cursors.get("hubspot:deals") ?? null);
      expect(saved.checkpoint).toBe(T);
      expect(saved.settledAt).toBeNull(); // NOT armed
    });

    it("sets settledAt only when checkpoint stays unchanged", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)], // same data as cursor checkpoint
        }),
      });
      const { repos, cursors } = buildMockRepos();
      // Pre-set cursor at T — no forward progress possible
      cursors.set("hubspot:deals", serializeSyncCursor({ frontier: T_MINUS_REPLAY, checkpoint: T, settledAt: null }));
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      const saved = parseSyncCursor(cursors.get("hubspot:deals") ?? null);
      expect(saved.settledAt).not.toBeNull(); // settling armed
    });
  });

  describe("counters", () => {
    it("counters reflect committed writes", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 2,
          results: [makeDeal("d1", T), makeDeal("d2", T)],
        }),
        getAssociations: vi.fn().mockImplementation(
          (fromType: string, _fromId: string, toType: string) => {
            if (fromType === "deals" && toType === "contacts") return Promise.resolve([{ toObjectId: "c1" }]);
            return Promise.resolve([]);
          }
        ),
        getContactById: vi.fn<any>().mockResolvedValue({
          id: "c1",
          properties: { email: "a@b.com", firstname: null, lastname: null, jobtitle: null, company: null },
        }),
      });
      const { repos } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      const result = await svc.runSync("comp-1");
      expect(result.counters.deals).toBe(2);
      expect(result.counters.contacts).toBe(2); // c1 fetched for each deal
      expect(result.counters.associations).toBe(2); // deal-contact link per deal
    });
  });

  describe("replay safety", () => {
    it("idempotent re-sync: same data twice", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");
      await svc.runSync("comp-1");
      // upsertDeal called on both runs (upsert is no-op for same data)
      expect(spies.upsertDeal).toHaveBeenCalledTimes(2);
    });
  });

  describe("tenant isolation", () => {
    it("company isolation: two companies don't cross-contaminate", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-A");
      await svc.runSync("comp-B");
      const callA = spies.upsertDeal.mock.calls[0][0] as { companyId: string };
      const callB = spies.upsertDeal.mock.calls[1][0] as { companyId: string };
      expect(callA.companyId).toBe("comp-A");
      expect(callB.companyId).toBe("comp-B");
    });
  });

  describe("config isolation", () => {
    it("sync runs without LLM API keys (only HUBSPOT_ACCESS_TOKEN + DB needed)", async () => {
      // This test validates that HubSpotSyncService doesn't require any LLM config
      const api = buildMockApi();
      const { repos } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      // Should not throw - no LLM dependency
      await svc.runSync("comp-1");
    });
  });

  describe("edge cases", () => {
    it("handles empty results gracefully with zero counters", async () => {
      const api = buildMockApi();
      const { repos } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      const result = await svc.runSync("comp-1");
      expect(result.counters.deals).toBe(0);
      expect(result.counters.contacts).toBe(0);
      expect(result.counters.companies).toBe(0);
      expect(result.counters.activities).toBe(0);
      expect(result.counters.associations).toBe(0);
    });
  });

  describe("generalized association resolution", () => {
    it("uses getAssociations for deal-contact, deal-company, deal-engagement, and engagement-contact paths", async () => {
      const getAssocCalls: Array<[string, string, string]> = [];
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
        getAssociations: vi.fn().mockImplementation(
          (fromType: string, fromId: string, toType: string) => {
            getAssocCalls.push([fromType, fromId, toType]);
            if (fromType === "deals" && toType === "contacts") return Promise.resolve([{ toObjectId: "c1" }]);
            if (fromType === "deals" && toType === "emails") return Promise.resolve([{ toObjectId: "e1" }]);
            if (fromType === "emails" && toType === "contacts") return Promise.resolve([{ toObjectId: "c1" }]);
            return Promise.resolve([]);
          }
        ),
        getContactById: vi.fn<any>().mockResolvedValue({
          id: "c1", properties: { email: "a@b.com", firstname: null, lastname: null, jobtitle: null, company: null },
        }),
        getEngagementById: vi.fn<any>().mockResolvedValue({
          id: "e1", properties: { hs_email_text: "Hi", hs_timestamp: T },
        }),
      });
      const { repos } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      await svc.runSync("comp-1");

      // Verify getAssociations called for deal-contacts, deal-companies, deal-emails, and emails-contacts
      const dealContactCalls = getAssocCalls.filter(([f, , t]) => f === "deals" && t === "contacts");
      const dealCompanyCalls = getAssocCalls.filter(([f, , t]) => f === "deals" && t === "companies");
      const dealEmailCalls = getAssocCalls.filter(([f, , t]) => f === "deals" && t === "emails");
      const emailContactCalls = getAssocCalls.filter(([f, , t]) => f === "emails" && t === "contacts");
      expect(dealContactCalls.length).toBeGreaterThanOrEqual(1);
      expect(dealCompanyCalls.length).toBeGreaterThanOrEqual(1);
      expect(dealEmailCalls.length).toBeGreaterThanOrEqual(1);
      expect(emailContactCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("partial failure on engagement-contact lookup doesn't affect deal-contact", async () => {
      const api = buildMockApi({
        searchDeals: vi.fn<any>().mockResolvedValue({
          total: 1,
          results: [makeDeal("d1", T)],
        }),
        getAssociations: vi.fn().mockImplementation(
          (fromType: string, _fromId: string, toType: string) => {
            if (fromType === "deals" && toType === "contacts") return Promise.resolve([{ toObjectId: "c1" }]);
            if (fromType === "deals" && toType === "emails") return Promise.resolve([{ toObjectId: "e1" }]);
            if (fromType === "emails" && toType === "contacts") return Promise.reject(new Error("Assoc fail"));
            return Promise.resolve([]);
          }
        ),
        getContactById: vi.fn<any>().mockResolvedValue({
          id: "c1", properties: { email: "a@b.com", firstname: null, lastname: null, jobtitle: null, company: null },
        }),
        getEngagementById: vi.fn<any>().mockResolvedValue({
          id: "e1", properties: { hs_email_text: "Hi", hs_timestamp: T },
        }),
      });
      const { repos, spies } = buildMockRepos();
      const svc = new HubSpotSyncService(api, repos, mockLogger);
      const result = await svc.runSync("comp-1");
      // Deal-contact link still created despite engagement-contact failure
      expect(spies.linkDealContact).toHaveBeenCalled();
      expect(result.warnings.some((w) => w.includes("engagement-contact"))).toBe(true);
    });
  });
});
