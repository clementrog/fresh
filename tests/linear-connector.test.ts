import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { LinearConnector, parseLinearCursors, serializeLinearCursors } from "../src/connectors/linear.js";
import type { LinearSourceConfig, RunContext } from "../src/domain/types.js";

const defaultConfig: LinearSourceConfig = {
  source: "linear",
  enabled: true,
  storeRawText: false,
  retentionDays: 30,
  rateLimit: { requestsPerMinute: 60, maxRetries: 1, initialDelayMs: 0 },
  workspaceIds: [],
  includeIssues: true,
  includeProjectUpdates: true,
  includeIssueComments: false
};

const defaultContext: RunContext = {
  dryRun: false,
  now: new Date("2026-04-01T12:00:00Z")
};

function graphqlResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function emptyPage(fieldName: string) {
  return { [fieldName]: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
}

function issuePage(issues: Array<Record<string, unknown>>) {
  return { issues: { nodes: issues, pageInfo: { hasNextPage: false, endCursor: null } } };
}

function projectUpdatePage(updates: Array<Record<string, unknown>>) {
  return { projectUpdates: { nodes: updates, pageInfo: { hasNextPage: false, endCursor: null } } };
}

function projectPage(projects: Array<Record<string, unknown>>) {
  return { projects: { nodes: projects, pageInfo: { hasNextPage: false, endCursor: null } } };
}

// --- Composite cursor tests ---

describe("parseLinearCursors", () => {
  it("returns all-null for null input", () => {
    const result = parseLinearCursors(null);
    expect(result.perEntity).toEqual({});
    expect(result.legacyFallback).toBeNull();
  });

  it("migrates legacy ISO string cursor", () => {
    const result = parseLinearCursors("2026-04-01T13:39:00.031Z");
    expect(result.perEntity).toEqual({});
    expect(result.legacyFallback).toBe("2026-04-01T13:39:00.031Z");
  });

  it("parses composite JSON cursor", () => {
    const cursor = JSON.stringify({ issues: "A", projectUpdates: "B", projects: "C" });
    const result = parseLinearCursors(cursor);
    expect(result.perEntity).toEqual({ issues: "A", projectUpdates: "B", projects: "C" });
    expect(result.legacyFallback).toBeNull();
  });

  it("round-trips composite cursor", () => {
    const original = { issues: "2026-01-01T00:00:00Z", projectUpdates: "2026-02-01T00:00:00Z", projects: "2026-03-01T00:00:00Z" };
    const serialized = serializeLinearCursors(original);
    const parsed = parseLinearCursors(serialized);
    expect(parsed.perEntity).toEqual(original);
    expect(parsed.legacyFallback).toBeNull();
  });

  it("legacy cursor: issues/projectUpdates use fallback, projects use null", () => {
    const { perEntity, legacyFallback } = parseLinearCursors("2026-04-01T13:39:00.031Z");
    // Simulating the resolution logic from fetchSinceV2
    const issuesCursor = perEntity.issues ?? legacyFallback;
    const projectUpdatesCursor = perEntity.projectUpdates ?? legacyFallback;
    const projectsCursor = perEntity.projects ?? null; // intentionally NOT fallback
    expect(issuesCursor).toBe("2026-04-01T13:39:00.031Z");
    expect(projectUpdatesCursor).toBe("2026-04-01T13:39:00.031Z");
    expect(projectsCursor).toBeNull();
  });
});

// --- fetchSinceV2 tests ---

describe("LinearConnector.fetchSinceV2", () => {
  let connector: LinearConnector;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connector = new LinearConnector({ LINEAR_API_KEY: "test-token", DATABASE_URL: "test" } as any);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty when disabled", async () => {
    const result = await connector.fetchSinceV2(null, { ...defaultConfig, enabled: false }, defaultContext);
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("returns authoritative nextCursor as JSON map", async () => {
    fetchMock
      .mockResolvedValueOnce(graphqlResponse(issuePage([
        { id: "i1", title: "Test", updatedAt: "2026-04-01T10:00:00Z", state: { name: "Done" }, team: { name: "Eng" }, labels: { nodes: [] }, project: null }
      ])))
      .mockResolvedValueOnce(graphqlResponse(emptyPage("projectUpdates")));

    const result = await connector.fetchSinceV2(null, defaultConfig, defaultContext);
    expect(result.items).toHaveLength(1);

    const cursor = JSON.parse(result.nextCursor!);
    expect(cursor.issues).toBe("2026-04-01T10:00:00Z");
    expect(cursor).toHaveProperty("projectUpdates");
  });

  it("idempotent: no new items → cursor unchanged", async () => {
    const existingCursor = serializeLinearCursors({
      issues: "2026-04-01T10:00:00Z",
      projectUpdates: "2026-04-01T10:00:00Z",
      projects: null
    });

    fetchMock
      .mockResolvedValueOnce(graphqlResponse(emptyPage("issues")))
      .mockResolvedValueOnce(graphqlResponse(emptyPage("projectUpdates")));

    const result = await connector.fetchSinceV2(existingCursor, defaultConfig, defaultContext);
    expect(result.items).toHaveLength(0);

    const cursor = JSON.parse(result.nextCursor!);
    expect(cursor.issues).toBe("2026-04-01T10:00:00Z");
    expect(cursor.projectUpdates).toBe("2026-04-01T10:00:00Z");
  });

  it("includes team filter in GraphQL query when teamKeys set", async () => {
    fetchMock
      .mockResolvedValueOnce(graphqlResponse(emptyPage("issues")))
      .mockResolvedValueOnce(graphqlResponse(emptyPage("projectUpdates")));

    await connector.fetchSinceV2(null, { ...defaultConfig, teamKeys: ["LINC"] }, defaultContext);

    const issuesCall = fetchMock.mock.calls[0];
    const issuesBody = JSON.parse(issuesCall[1].body);
    expect(issuesBody.query).toContain("filter:");
    expect(issuesBody.query).toContain("LINC");
  });

  it("fetches projects when includeProjects is true", async () => {
    fetchMock
      .mockResolvedValueOnce(graphqlResponse(emptyPage("issues")))
      .mockResolvedValueOnce(graphqlResponse(emptyPage("projectUpdates")))
      .mockResolvedValueOnce(graphqlResponse(projectPage([
        {
          id: "proj1", name: "HCR Support", description: "Full HCR convention",
          state: "completed", url: "https://linear.app/proj/1", updatedAt: "2026-03-30T10:00:00Z",
          startDate: "2026-02-01", targetDate: "2026-03-15", completedAt: "2026-03-14T10:00:00Z",
          labels: { nodes: [{ name: "M" }] },
          teams: { nodes: [{ key: "LINC", name: "Product & Tech" }] },
          projectUpdates: { nodes: [{ body: "Shipped!", health: "onTrack", createdAt: "2026-03-14T10:00:00Z" }] }
        }
      ])));

    const result = await connector.fetchSinceV2(null, {
      ...defaultConfig,
      includeProjects: true,
      projectStateFilter: ["completed"]
    }, defaultContext);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].payload).toHaveProperty("itemType", "project");
    const cursor = JSON.parse(result.nextCursor!);
    expect(cursor.projects).toBe("2026-03-30T10:00:00Z");
  });

  it("migrates legacy cursor: issues/updates continue, projects backfill", async () => {
    const legacyCursor = "2026-04-01T10:00:00Z";

    // Issue older than cursor → skipped
    fetchMock
      .mockResolvedValueOnce(graphqlResponse(issuePage([
        { id: "i1", title: "Old", updatedAt: "2026-04-01T09:00:00Z", state: { name: "Done" }, team: { name: "Eng" }, labels: { nodes: [] }, project: null }
      ])))
      .mockResolvedValueOnce(graphqlResponse(emptyPage("projectUpdates")))
      // Project with no cursor → all fetched (backfill)
      .mockResolvedValueOnce(graphqlResponse(projectPage([
        {
          id: "proj1", name: "Old project", description: "Released long ago",
          state: "completed", url: "", updatedAt: "2026-01-15T10:00:00Z",
          labels: { nodes: [] }, teams: { nodes: [] },
          projectUpdates: { nodes: [] }
        }
      ])));

    const result = await connector.fetchSinceV2(legacyCursor, {
      ...defaultConfig,
      includeProjects: true,
      projectStateFilter: ["completed"]
    }, defaultContext);

    // Old issue filtered by cursor, but project is fetched (null cursor = backfill)
    expect(result.items).toHaveLength(1);
    expect(result.items[0].payload).toHaveProperty("itemType", "project");

    const cursor = JSON.parse(result.nextCursor!);
    expect(cursor.issues).toBe("2026-04-01T10:00:00Z"); // unchanged
    expect(cursor.projects).toBe("2026-01-15T10:00:00Z"); // advanced from null
  });
});

// --- Normalize tests ---

describe("LinearConnector.normalize", () => {
  let connector: LinearConnector;

  beforeEach(() => {
    connector = new LinearConnector({ LINEAR_API_KEY: "test-token", DATABASE_URL: "test" } as any);
  });

  it("normalizes a project item with full metadata", async () => {
    const raw = {
      id: "proj1",
      cursor: "2026-03-30T10:00:00Z",
      payload: {
        id: "proj1",
        name: "Primes conventionnelles",
        description: "Support for conventional bonuses in HCR",
        state: "completed",
        url: "https://linear.app/linc-fr/project/primes",
        updatedAt: "2026-03-30T10:00:00Z",
        startDate: "2026-03-11",
        targetDate: "2026-03-18",
        completedAt: "2026-03-17T16:15:47Z",
        labels: { nodes: [{ name: "M" }] },
        teams: { nodes: [{ key: "LINC", name: "Product & Tech" }] },
        projectUpdates: { nodes: [{ body: "Shipped to production!", health: "onTrack", createdAt: "2026-03-17T16:00:00Z" }] },
        itemType: "project"
      }
    };

    const result = await connector.normalize(raw, defaultConfig, defaultContext);

    expect(result.source).toBe("linear");
    expect(result.title).toBe("Primes conventionnelles");
    expect(result.text).toContain("Support for conventional bonuses");
    expect(result.text).toContain("Shipped to production!");
    expect(result.metadata.itemType).toBe("project");
    expect(result.metadata.projectState).toBe("completed");
    expect(result.metadata.projectStartDate).toBe("2026-03-11");
    expect(result.metadata.projectTargetDate).toBe("2026-03-18");
    expect(result.metadata.projectCompletedAt).toBe("2026-03-17T16:15:47Z");
    expect(result.metadata.projectLabels).toEqual(["M"]);
    expect(result.metadata.projectTeams).toEqual(["LINC"]);
    expect(result.metadata.projectHealth).toBe("onTrack");
  });

  it("normalizes an issue item unchanged", async () => {
    const raw = {
      id: "i1",
      cursor: "2026-04-01T10:00:00Z",
      payload: {
        id: "i1",
        title: "Fix DSN validation",
        description: "Edge case in DSN generation",
        updatedAt: "2026-04-01T10:00:00Z",
        state: { name: "Done" },
        team: { name: "Engineering" },
        labels: { nodes: [{ name: "bug" }] },
        project: { name: "DSN Reliability" },
        itemType: "issue"
      }
    };

    const result = await connector.normalize(raw, defaultConfig, defaultContext);

    expect(result.source).toBe("linear");
    expect(result.title).toBe("Fix DSN validation");
    expect(result.metadata.itemType).toBe("issue");
    expect(result.metadata.stateName).toBe("Done");
    expect(result.metadata.projectName).toBe("DSN Reliability");
  });
});
