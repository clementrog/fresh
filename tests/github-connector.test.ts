import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { GitHubConnector, extractLinearReferences } from "../src/connectors/github.js";
import type { GitHubSourceConfig, RunContext } from "../src/domain/types.js";

const defaultConfig: GitHubSourceConfig = {
  source: "github",
  enabled: true,
  storeRawText: false,
  retentionDays: 30,
  rateLimit: { requestsPerMinute: 60, maxRetries: 1, initialDelayMs: 0 },
  orgSlug: "linc-fr",
  repos: ["app"],
  includeMergedPRs: true,
  includeClosedIssues: true,
  includeReleases: true,
  maxItemsPerRun: 100
};

const defaultContext: RunContext = {
  dryRun: false,
  now: new Date("2026-03-31T12:00:00Z")
};

describe("extractLinearReferences", () => {
  it("extracts LIN-NNN references from text", () => {
    expect(extractLinearReferences("Fixes LIN-123 and LIN-456")).toEqual(["LIN-123", "LIN-456"]);
  });

  it("extracts team-prefixed references", () => {
    expect(extractLinearReferences("Closes ENG-42")).toEqual(["ENG-42"]);
  });

  it("deduplicates references", () => {
    expect(extractLinearReferences("LIN-123 and LIN-123")).toEqual(["LIN-123"]);
  });

  it("returns empty for no references", () => {
    expect(extractLinearReferences("Just a normal PR body")).toEqual([]);
  });
});

describe("GitHubConnector.normalize", () => {
  let connector: GitHubConnector;

  beforeEach(() => {
    connector = new GitHubConnector({ GITHUB_TOKEN: "test-token", DATABASE_URL: "test" });
  });

  it("normalizes a merged PR", async () => {
    const raw = {
      id: "PR_abc",
      cursor: "2026-03-30T10:00:00Z",
      payload: {
        itemType: "merged-pr",
        repoName: "app",
        title: "Add HCR convention support",
        body: "Full HCR support. Fixes LIN-99.",
        url: "https://github.com/linc-fr/app/pull/42",
        number: 42,
        mergedAt: "2026-03-30T10:00:00Z",
        updatedAt: "2026-03-30T10:00:00Z",
        createdAt: "2026-03-28T08:00:00Z",
        additions: 200,
        deletions: 10,
        authorLogin: "dev",
        reviewerLogins: ["reviewer"],
        labels: ["feature"],
        milestoneName: "Q1",
        linkedIssueNumbers: [10]
      }
    };

    const result = await connector.normalize(raw, defaultConfig, defaultContext);

    expect(result.source).toBe("github");
    expect(result.externalId).toBe("github:linc-fr/app#42");
    expect(result.sourceItemId).toBe("linc-fr/app#42");
    expect(result.title).toBe("Add HCR convention support");
    expect(result.text).toBe("Full HCR support. Fixes LIN-99.");
    expect(result.metadata.itemType).toBe("merged-pr");
    expect(result.metadata.labels).toEqual(["feature"]);
    expect(result.metadata.linkedLinearDisplayIds).toEqual(["LIN-99"]);
    expect(result.metadata.repoName).toBe("app");
    expect(result.metadata.orgSlug).toBe("linc-fr");
  });

  it("normalizes a release", async () => {
    const raw = {
      id: "REL_abc",
      cursor: "2026-03-30T12:00:00Z",
      payload: {
        itemType: "release",
        repoName: "app",
        name: "v2.5.0",
        tagName: "v2.5.0",
        description: "HCR convention fully supported",
        url: "https://github.com/linc-fr/app/releases/tag/v2.5.0",
        publishedAt: "2026-03-30T12:00:00Z",
        createdAt: "2026-03-30T11:00:00Z",
        isPrerelease: false,
        isDraft: false,
        authorLogin: "release-bot"
      }
    };

    const result = await connector.normalize(raw, defaultConfig, defaultContext);

    expect(result.externalId).toBe("github:linc-fr/app@v2.5.0");
    expect(result.sourceItemId).toBe("linc-fr/app@v2.5.0");
    expect(result.title).toBe("v2.5.0");
    expect(result.metadata.itemType).toBe("release");
    expect(result.metadata.releaseTagName).toBe("v2.5.0");
    expect(result.metadata.isPrerelease).toBe(false);
  });

  it("normalizes a closed issue", async () => {
    const raw = {
      id: "ISSUE_abc",
      cursor: "2026-03-29T08:00:00Z",
      payload: {
        itemType: "closed-issue",
        repoName: "app",
        title: "DSN validation fails for multi-establishment",
        body: "Fixed the validation edge case for multi-establishment companies",
        url: "https://github.com/linc-fr/app/issues/55",
        number: 55,
        closedAt: "2026-03-29T08:00:00Z",
        updatedAt: "2026-03-29T08:00:00Z",
        createdAt: "2026-03-25T10:00:00Z",
        authorLogin: "user-1",
        labels: ["bug"],
        stateReason: "COMPLETED"
      }
    };

    const result = await connector.normalize(raw, defaultConfig, defaultContext);

    expect(result.externalId).toBe("github:linc-fr/app#55");
    expect(result.metadata.itemType).toBe("closed-issue");
    expect(result.metadata.stateReason).toBe("COMPLETED");
  });
});

describe("GitHubConnector.fetchSinceV2", () => {
  it("returns empty result when disabled", async () => {
    const connector = new GitHubConnector({ GITHUB_TOKEN: "test", DATABASE_URL: "test" });
    const disabledConfig = { ...defaultConfig, enabled: false };

    const result = await connector.fetchSinceV2(null, disabledConfig, defaultContext);

    expect(result.items).toEqual([]);
    expect(result.partialCompletion).toBe(false);
  });

  it("returns empty result when no token", async () => {
    const connector = new GitHubConnector({ DATABASE_URL: "test" });

    const result = await connector.fetchSinceV2(null, defaultConfig, defaultContext);

    expect(result.items).toEqual([]);
    expect(result.partialCompletion).toBe(false);
  });
});

// --- Helpers for fetch-mocking tests ---

function graphqlResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(`Error ${status}`, { status, headers });
}

function repoListPayload(repos: string[]) {
  return {
    organization: {
      repositories: {
        nodes: repos.map(name => ({ name, isArchived: false })),
        pageInfo: { hasNextPage: false, endCursor: null }
      }
    }
  };
}

function mergedPRsPayload(prs: Array<{ id: string; number: number; title: string; updatedAt: string }>) {
  return {
    repository: {
      pullRequests: {
        nodes: prs.map(pr => ({
          id: pr.id, number: pr.number, title: pr.title,
          body: "", url: `https://github.com/linc-fr/app/pull/${pr.number}`,
          mergedAt: pr.updatedAt, updatedAt: pr.updatedAt, createdAt: pr.updatedAt,
          additions: 10, deletions: 2,
          author: { login: "dev" }, reviews: { nodes: [] },
          labels: { nodes: [] }, milestone: null, closingIssuesReferences: { nodes: [] }
        })),
        pageInfo: { hasNextPage: false, endCursor: null }
      }
    }
  };
}

function emptyIssuesPayload() {
  return { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
}

function emptyReleasesPayload() {
  return { repository: { releases: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
}

describe("GitHubConnector retry and failure handling", () => {
  let connector: GitHubConnector;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connector = new GitHubConnector({ GITHUB_TOKEN: "test-token", DATABASE_URL: "test" });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries transient HTTP 500 inside the retry wrapper", async () => {
    const prConfig: GitHubSourceConfig = {
      ...defaultConfig,
      repos: ["app"],
      includeMergedPRs: true,
      includeClosedIssues: false,
      includeReleases: false,
      rateLimit: { requestsPerMinute: 600, maxRetries: 1, initialDelayMs: 0 }
    };

    // PR fetch: first attempt → 500, second attempt → success
    fetchMock
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(graphqlResponse(
        mergedPRsPayload([{ id: "PR_1", number: 1, title: "feat: ship it", updatedAt: "2026-03-31T10:00:00Z" }])
      ));

    const result = await connector.fetchSinceV2(null, prConfig, defaultContext);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  it("retries GraphQL-level errors inside the retry wrapper", async () => {
    const prConfig: GitHubSourceConfig = {
      ...defaultConfig,
      repos: ["app"],
      includeMergedPRs: true,
      includeClosedIssues: false,
      includeReleases: false,
      rateLimit: { requestsPerMinute: 600, maxRetries: 1, initialDelayMs: 0 }
    };

    // First attempt: GraphQL error, second attempt: success
    fetchMock
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ errors: [{ message: "temporary issue" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ))
      .mockResolvedValueOnce(graphqlResponse(
        mergedPRsPayload([{ id: "PR_1", number: 1, title: "feat: ship it", updatedAt: "2026-03-31T10:00:00Z" }])
      ));

    const result = await connector.fetchSinceV2(null, prConfig, defaultContext);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(1);
  });

  it("wraps wildcard repo discovery failure as warning, does not throw", async () => {
    const wildcardConfig: GitHubSourceConfig = {
      ...defaultConfig,
      repos: ["*"],
      rateLimit: { requestsPerMinute: 600, maxRetries: 0, initialDelayMs: 0 }
    };

    fetchMock.mockRejectedValue(new Error("DNS resolution failed"));

    const result = await connector.fetchSinceV2(null, wildcardConfig, defaultContext);

    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Failed to resolve repos");
    expect(result.warnings[0]).toContain("DNS resolution failed");
    expect(result.partialCompletion).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  it("preserves existing cursor on wildcard repo discovery failure", async () => {
    const wildcardConfig: GitHubSourceConfig = {
      ...defaultConfig,
      repos: ["*"],
      rateLimit: { requestsPerMinute: 600, maxRetries: 0, initialDelayMs: 0 }
    };

    fetchMock.mockRejectedValue(new Error("Network timeout"));

    const existingCursor = "2026-03-30T12:00:00Z";
    const result = await connector.fetchSinceV2(existingCursor, wildcardConfig, defaultContext);

    expect(result.nextCursor).toBe(existingCursor);
    expect(result.partialCompletion).toBe(true);
  });

  it("isolates per-repo failures: succeeds for repo-a, fails for repo-b", async () => {
    const multiRepoConfig: GitHubSourceConfig = {
      ...defaultConfig,
      repos: ["repo-a", "repo-b"],
      includeMergedPRs: true,
      includeClosedIssues: false,
      includeReleases: false,
      rateLimit: { requestsPerMinute: 600, maxRetries: 0, initialDelayMs: 0 }
    };

    fetchMock
      // repo-a PRs: success
      .mockResolvedValueOnce(graphqlResponse(
        mergedPRsPayload([{ id: "PR_a1", number: 1, title: "feat: a", updatedAt: "2026-03-31T10:00:00Z" }])
      ))
      // repo-b PRs: failure
      .mockResolvedValueOnce(errorResponse(500));

    const result = await connector.fetchSinceV2(null, multiRepoConfig, defaultContext);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("PR_a1");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("repo-b");
    expect(result.partialCompletion).toBe(true);
  });

  it("does not advance cursor when repo-level failures occur", async () => {
    const multiRepoConfig: GitHubSourceConfig = {
      ...defaultConfig,
      repos: ["repo-a", "repo-b"],
      includeMergedPRs: true,
      includeClosedIssues: false,
      includeReleases: false,
      rateLimit: { requestsPerMinute: 600, maxRetries: 0, initialDelayMs: 0 }
    };

    const existingCursor = "2026-03-29T00:00:00Z";

    fetchMock
      .mockResolvedValueOnce(graphqlResponse(
        mergedPRsPayload([{ id: "PR_a1", number: 1, title: "feat: a", updatedAt: "2026-03-31T10:00:00Z" }])
      ))
      .mockResolvedValueOnce(errorResponse(500));

    const result = await connector.fetchSinceV2(existingCursor, multiRepoConfig, defaultContext);

    // Cursor stays at existing value because of partial failure
    expect(result.nextCursor).toBe(existingCursor);
    expect(result.partialCompletion).toBe(true);
  });

  it("applies maxItemsPerRun cap and sets partialCompletion", async () => {
    const cappedConfig: GitHubSourceConfig = {
      ...defaultConfig,
      repos: ["app"],
      includeMergedPRs: true,
      includeClosedIssues: true,
      includeReleases: false,
      maxItemsPerRun: 2,
      rateLimit: { requestsPerMinute: 600, maxRetries: 0, initialDelayMs: 0 }
    };

    // Return 3 PRs, but cap is 2
    fetchMock
      .mockResolvedValueOnce(graphqlResponse(
        mergedPRsPayload([
          { id: "PR_1", number: 1, title: "feat: one", updatedAt: "2026-03-31T08:00:00Z" },
          { id: "PR_2", number: 2, title: "feat: two", updatedAt: "2026-03-31T09:00:00Z" },
          { id: "PR_3", number: 3, title: "feat: three", updatedAt: "2026-03-31T10:00:00Z" }
        ])
      ));
    // Issues fetch should not happen since cap is already hit

    const result = await connector.fetchSinceV2(null, cappedConfig, defaultContext);

    expect(result.items.length).toBeLessThanOrEqual(2);
    expect(result.partialCompletion).toBe(true);
    // Cursor advances to last processed item, not beyond
    expect(result.nextCursor).toBeTruthy();
  });

  it("rate-limit exhaustion (403 with remaining=0) is retried then propagated as per-repo warning", async () => {
    const config: GitHubSourceConfig = {
      ...defaultConfig,
      repos: ["app"],
      includeMergedPRs: true,
      includeClosedIssues: false,
      includeReleases: false,
      rateLimit: { requestsPerMinute: 600, maxRetries: 1, initialDelayMs: 0 }
    };

    // Both attempts hit rate limit
    fetchMock
      .mockResolvedValueOnce(errorResponse(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" }))
      .mockResolvedValueOnce(errorResponse(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" }));

    const result = await connector.fetchSinceV2(null, config, defaultContext);

    // Per-repo catch turns the exhaustion into a warning
    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("rate limit exhausted");
    expect(result.partialCompletion).toBe(true);
  });
});
