import type { AppEnv } from "../config/env.js";
import type {
  FetchResult,
  GitHubSourceConfig,
  NormalizedSourceItem,
  RawSourceItem,
  RunContext
} from "../domain/types.js";
import { hashParts } from "../lib/ids.js";
import { BaseConnector } from "./base.js";

const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const CURSOR_OVERLAP_SECONDS = 60;
const DEFAULT_MAX_ITEMS_PER_RUN = 500;
const LOW_BUDGET_THRESHOLD = 100;

// --- Linear reference extraction ---

const LINEAR_ID_PATTERN = /\b(?:LIN|[A-Z]{2,6})-\d+\b/g;

export function extractLinearReferences(text: string): string[] {
  const matches = text.match(LINEAR_ID_PATTERN);
  if (!matches) return [];
  return [...new Set(matches)];
}

// --- GitHub connector ---

export class GitHubConnector extends BaseConnector<GitHubSourceConfig> {
  readonly source = "github" as const;

  constructor(private readonly env: AppEnv) {
    super();
  }

  override async fetchSince(cursor: string | null, config: GitHubSourceConfig, context: RunContext): Promise<RawSourceItem[]> {
    const result = await this.fetchSinceV2(cursor, config, context);
    return result.items;
  }

  override async fetchSinceV2(cursor: string | null, config: GitHubSourceConfig, context: RunContext): Promise<FetchResult> {
    if (!config.enabled || !this.env.GITHUB_TOKEN) {
      return { items: [], nextCursor: cursor, warnings: [], partialCompletion: false };
    }

    const maxItems = config.maxItemsPerRun ?? DEFAULT_MAX_ITEMS_PER_RUN;
    const queryCursor = cursor ? subtractSeconds(cursor, CURSOR_OVERLAP_SECONDS) : null;

    let repos: string[];
    try {
      repos = await this.resolveRepos(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        items: [],
        nextCursor: cursor,
        warnings: [`Failed to resolve repos for ${config.orgSlug}: ${message}`],
        partialCompletion: true
      };
    }

    const items: RawSourceItem[] = [];
    const warnings: string[] = [];
    let partialCompletion = false;
    const repoMaxCursors: string[] = [];

    for (const repo of repos) {
      if (items.length >= maxItems) {
        partialCompletion = true;
        break;
      }

      try {
        const remaining = maxItems - items.length;
        const repoItems = await this.fetchRepoItems(config, repo, queryCursor, remaining);
        items.push(...repoItems);

        for (const item of repoItems) {
          if (item.cursor) repoMaxCursors.push(item.cursor);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        warnings.push(`Failed to fetch ${config.orgSlug}/${repo}: ${message}`);
        partialCompletion = true;
      }
    }

    // Cursor advancement logic
    let nextCursor: string | null;
    if (partialCompletion && warnings.length > 0) {
      // Repo-level failures: don't advance cursor at all
      nextCursor = cursor;
    } else if (items.length >= maxItems) {
      // Cap hit: advance to last processed item
      const sorted = [...items].sort((a, b) => a.cursor.localeCompare(b.cursor));
      nextCursor = sorted[sorted.length - 1]?.cursor ?? cursor;
      partialCompletion = true;
    } else if (repoMaxCursors.length > 0) {
      // Full success: advance to max of all items
      nextCursor = repoMaxCursors.reduce((max, c) => c > max ? c : max, repoMaxCursors[0]);
    } else {
      nextCursor = cursor;
    }

    return {
      items: items.sort((a, b) => a.cursor.localeCompare(b.cursor)),
      nextCursor,
      warnings,
      partialCompletion
    };
  }

  override async normalize(rawItem: RawSourceItem, config: GitHubSourceConfig, context: RunContext): Promise<NormalizedSourceItem> {
    const payload = rawItem.payload as GitHubRawPayload;
    const itemType = payload.itemType as "merged-pr" | "closed-issue" | "release";
    const repo = String(payload.repoName ?? "");
    const org = config.orgSlug;

    const text = payload.body ?? payload.description ?? "";
    const number = payload.number != null ? Number(payload.number) : undefined;
    const tagName = payload.tagName ? String(payload.tagName) : undefined;

    const sourceItemId = tagName
      ? `${org}/${repo}@${tagName}`
      : `${org}/${repo}#${number}`;

    const externalId = `github:${sourceItemId}`;

    const occurredAt = String(
      payload.mergedAt ?? payload.closedAt ?? payload.publishedAt
      ?? payload.updatedAt ?? context.now.toISOString()
    );

    const labels = extractLabels(payload);

    return {
      source: "github",
      sourceItemId,
      externalId,
      sourceFingerprint: hashParts(["github", repo, number ?? tagName ?? rawItem.id, text]),
      sourceUrl: String(payload.url ?? ""),
      title: String(payload.title ?? payload.name ?? `GitHub item ${rawItem.id}`),
      text,
      summary: text.slice(0, 200),
      occurredAt,
      ingestedAt: context.now.toISOString(),
      metadata: {
        itemType,
        repoName: repo,
        orgSlug: org,
        labels,
        authorLogin: payload.authorLogin ?? null,
        reviewerLogins: payload.reviewerLogins ?? [],
        mergedAt: payload.mergedAt ?? null,
        closedAt: payload.closedAt ?? null,
        publishedAt: payload.publishedAt ?? null,
        milestoneName: payload.milestoneName ?? null,
        additions: payload.additions ?? null,
        deletions: payload.deletions ?? null,
        linkedIssueNumbers: payload.linkedIssueNumbers ?? [],
        linkedLinearDisplayIds: extractLinearReferences(text),
        releaseTagName: tagName ?? null,
        isPrerelease: payload.isPrerelease ?? false,
        isDraft: payload.isDraft ?? false,
        stateReason: payload.stateReason ?? null,
        storeRawText: config.storeRawText
      },
      rawPayload: rawItem.payload,
      rawText: config.storeRawText ? text : null
    };
  }

  override async backfill(range: { from: Date; to: Date }, config: GitHubSourceConfig, context: RunContext): Promise<RawSourceItem[]> {
    return this.fetchSince(range.from.toISOString(), config, context);
  }

  // --- Private helpers ---

  private async resolveRepos(config: GitHubSourceConfig): Promise<string[]> {
    if (config.repos.length === 1 && config.repos[0] === "*") {
      return this.listOrgRepos(config);
    }
    return config.repos;
  }

  private async listOrgRepos(config: GitHubSourceConfig): Promise<string[]> {
    type RepoPage = { nodes: Array<{ name: string; isArchived: boolean }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    const repos: string[] = [];
    let after: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const data = await this.queryGitHub<{ organization: { repositories: RepoPage } }>(config, `
        query ListRepos($org: String!, $after: String) {
          organization(login: $org) {
            repositories(first: 100, after: $after, isFork: false) {
              nodes { name isArchived }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `, { org: config.orgSlug, after });

      const page: RepoPage = data.organization.repositories;
      for (const repo of page.nodes) {
        if (!repo.isArchived) repos.push(repo.name);
      }
      hasMore = page.pageInfo.hasNextPage;
      after = page.pageInfo.endCursor;
    }

    return repos;
  }

  private async fetchRepoItems(
    config: GitHubSourceConfig,
    repo: string,
    cursor: string | null,
    maxItems: number
  ): Promise<RawSourceItem[]> {
    const items: RawSourceItem[] = [];
    const excludeLabels = new Set(config.labelFilters?.exclude?.map(l => l.toLowerCase()) ?? []);

    if (config.includeMergedPRs) {
      const prs = await this.fetchMergedPRs(config, repo, cursor, maxItems - items.length);
      for (const pr of prs) {
        if (items.length >= maxItems) break;
        if (hasExcludedLabel(pr, excludeLabels)) continue;
        items.push(pr);
      }
    }

    if (config.includeClosedIssues && items.length < maxItems) {
      const issues = await this.fetchClosedIssues(config, repo, cursor, maxItems - items.length);
      for (const issue of issues) {
        if (items.length >= maxItems) break;
        if (hasExcludedLabel(issue, excludeLabels)) continue;
        items.push(issue);
      }
    }

    if (config.includeReleases && items.length < maxItems) {
      const releases = await this.fetchReleases(config, repo, cursor, maxItems - items.length);
      for (const release of releases) {
        if (items.length >= maxItems) break;
        items.push(release);
      }
    }

    return items;
  }

  private async fetchMergedPRs(config: GitHubSourceConfig, repo: string, cursor: string | null, limit: number): Promise<RawSourceItem[]> {
    type PRPage = { nodes: Array<Record<string, unknown>>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    const items: RawSourceItem[] = [];
    let after: string | null = null;
    let hasMore = true;

    while (hasMore && items.length < limit) {
      const data = await this.queryGitHub<{ repository: { pullRequests: PRPage } }>(config, `
        query MergedPRs($owner: String!, $repo: String!, $after: String) {
          repository(owner: $owner, name: $repo) {
            pullRequests(first: 50, after: $after, states: MERGED, orderBy: {field: UPDATED_AT, direction: ASC}) {
              nodes {
                id number title body url
                mergedAt updatedAt createdAt
                additions deletions
                author { login }
                reviews(first: 5) { nodes { author { login } } }
                labels(first: 10) { nodes { name } }
                milestone { title }
                closingIssuesReferences(first: 5) { nodes { number title } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `, { owner: config.orgSlug, repo, after });

      const page: PRPage = data.repository.pullRequests;
      for (const pr of page.nodes) {
        const updatedAt = String(pr.updatedAt ?? "");
        if (cursor && updatedAt <= cursor) continue;
        if (items.length >= limit) break;

        items.push({
          id: String(pr.id),
          cursor: updatedAt,
          payload: {
            ...flattenPR(pr),
            itemType: "merged-pr",
            repoName: repo
          }
        });
      }

      hasMore = page.pageInfo.hasNextPage;
      after = page.pageInfo.endCursor;
    }

    return items;
  }

  private async fetchClosedIssues(config: GitHubSourceConfig, repo: string, cursor: string | null, limit: number): Promise<RawSourceItem[]> {
    type IssuePage = { nodes: Array<Record<string, unknown>>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    const items: RawSourceItem[] = [];
    let after: string | null = null;
    let hasMore = true;

    while (hasMore && items.length < limit) {
      const data = await this.queryGitHub<{ repository: { issues: IssuePage } }>(config, `
        query ClosedIssues($owner: String!, $repo: String!, $after: String, $since: DateTime) {
          repository(owner: $owner, name: $repo) {
            issues(first: 50, after: $after, states: CLOSED, filterBy: {since: $since}, orderBy: {field: UPDATED_AT, direction: ASC}) {
              nodes {
                id number title body url
                closedAt updatedAt createdAt
                stateReason
                author { login }
                labels(first: 10) { nodes { name } }
                milestone { title }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `, { owner: config.orgSlug, repo, after, since: cursor });

      const page: IssuePage = data.repository.issues;
      for (const issue of page.nodes) {
        const updatedAt = String(issue.updatedAt ?? "");
        if (cursor && updatedAt <= cursor) continue;
        // Only include issues closed as "completed" (not "not_planned")
        const stateReason = String(issue.stateReason ?? "").toUpperCase();
        if (stateReason === "NOT_PLANNED") continue;
        if (items.length >= limit) break;

        items.push({
          id: String(issue.id),
          cursor: updatedAt,
          payload: {
            ...flattenIssue(issue),
            itemType: "closed-issue",
            repoName: repo
          }
        });
      }

      hasMore = page.pageInfo.hasNextPage;
      after = page.pageInfo.endCursor;
    }

    return items;
  }

  private async fetchReleases(config: GitHubSourceConfig, repo: string, cursor: string | null, limit: number): Promise<RawSourceItem[]> {
    type ReleasePage = { nodes: Array<Record<string, unknown>>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    const items: RawSourceItem[] = [];
    let after: string | null = null;
    let hasMore = true;

    while (hasMore && items.length < limit) {
      const data = await this.queryGitHub<{ repository: { releases: ReleasePage } }>(config, `
        query Releases($owner: String!, $repo: String!, $after: String) {
          repository(owner: $owner, name: $repo) {
            releases(first: 20, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
              nodes {
                id name tagName description url
                publishedAt createdAt
                isPrerelease isDraft
                author { login }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `, { owner: config.orgSlug, repo, after });

      const page: ReleasePage = data.repository.releases;
      for (const release of page.nodes) {
        const publishedAt = String(release.publishedAt ?? release.createdAt ?? "");
        if (cursor && publishedAt <= cursor) continue;
        // Only include final, published releases
        if (release.isPrerelease || release.isDraft) continue;
        if (items.length >= limit) break;

        items.push({
          id: String(release.id),
          cursor: publishedAt,
          payload: {
            ...flattenRelease(release),
            itemType: "release",
            repoName: repo
          }
        });
      }

      hasMore = page.pageInfo.hasNextPage;
      after = page.pageInfo.endCursor;
    }

    return items;
  }

  private async queryGitHub<T>(config: GitHubSourceConfig, query: string, variables: Record<string, unknown>): Promise<T> {
    return this.executeWithRateLimit(config, async () => {
      const response = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `bearer ${this.env.GITHUB_TOKEN}`
        },
        body: JSON.stringify({ query, variables })
      });

      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        if ((response.status === 403 || response.status === 429) && remaining === "0") {
          const resetAt = response.headers.get("x-ratelimit-reset");
          const resetMs = resetAt ? (Number(resetAt) * 1000 - Date.now()) : 60_000;
          throw new Error(`GitHub rate limit exhausted, resets in ${Math.ceil(resetMs / 1000)}s`);
        }
        throw new Error(`GitHub request failed with ${response.status}`);
      }

      // Proactive low-budget throttling: pause before we exhaust the limit
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining !== null) {
        const budget = Number(remaining);
        if (budget > 0 && budget <= LOW_BUDGET_THRESHOLD) {
          const resetAt = response.headers.get("x-ratelimit-reset");
          const resetMs = resetAt ? Math.max(0, Number(resetAt) * 1000 - Date.now()) : 60_000;
          const delayMs = Math.min(resetMs / Math.max(1, budget), 10_000);
          if (delayMs > 100) await this.pause(delayMs);
        }
      }

      const payload = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
      if (payload.errors?.length) {
        throw new Error(payload.errors.map(e => e.message ?? "Unknown GitHub error").join("; "));
      }
      if (!payload.data) {
        throw new Error("GitHub response missing data");
      }
      return payload.data;
    });
  }
}

// --- Payload flattening helpers ---

interface GitHubRawPayload {
  itemType?: string;
  repoName?: string;
  title?: string;
  name?: string;
  body?: string;
  description?: string;
  url?: string;
  number?: number;
  tagName?: string;
  mergedAt?: string;
  closedAt?: string;
  publishedAt?: string;
  updatedAt?: string;
  createdAt?: string;
  authorLogin?: string;
  reviewerLogins?: string[];
  labels?: string[];
  milestoneName?: string;
  additions?: number;
  deletions?: number;
  linkedIssueNumbers?: number[];
  isPrerelease?: boolean;
  isDraft?: boolean;
  stateReason?: string;
}

function flattenPR(pr: Record<string, unknown>): GitHubRawPayload {
  const author = pr.author as { login?: string } | null;
  const reviews = pr.reviews as { nodes?: Array<{ author?: { login?: string } }> } | null;
  const labels = pr.labels as { nodes?: Array<{ name?: string }> } | null;
  const milestone = pr.milestone as { title?: string } | null;
  const closingIssues = pr.closingIssuesReferences as { nodes?: Array<{ number?: number; title?: string }> } | null;

  return {
    title: pr.title as string,
    body: pr.body as string,
    url: pr.url as string,
    number: pr.number as number,
    mergedAt: pr.mergedAt as string,
    updatedAt: pr.updatedAt as string,
    createdAt: pr.createdAt as string,
    additions: pr.additions as number,
    deletions: pr.deletions as number,
    authorLogin: author?.login,
    reviewerLogins: reviews?.nodes?.map(r => r.author?.login).filter(Boolean) as string[] ?? [],
    labels: labels?.nodes?.map(l => l.name).filter(Boolean) as string[] ?? [],
    milestoneName: milestone?.title,
    linkedIssueNumbers: closingIssues?.nodes?.map(i => i.number).filter(Boolean) as number[] ?? []
  };
}

function flattenIssue(issue: Record<string, unknown>): GitHubRawPayload {
  const author = issue.author as { login?: string } | null;
  const labels = issue.labels as { nodes?: Array<{ name?: string }> } | null;
  const milestone = issue.milestone as { title?: string } | null;

  return {
    title: issue.title as string,
    body: issue.body as string,
    url: issue.url as string,
    number: issue.number as number,
    closedAt: issue.closedAt as string,
    updatedAt: issue.updatedAt as string,
    createdAt: issue.createdAt as string,
    authorLogin: author?.login,
    labels: labels?.nodes?.map(l => l.name).filter(Boolean) as string[] ?? [],
    milestoneName: milestone?.title,
    stateReason: issue.stateReason as string
  };
}

function flattenRelease(release: Record<string, unknown>): GitHubRawPayload {
  const author = release.author as { login?: string } | null;

  return {
    name: release.name as string,
    tagName: release.tagName as string,
    description: release.description as string,
    url: release.url as string,
    publishedAt: release.publishedAt as string,
    createdAt: release.createdAt as string,
    isPrerelease: release.isPrerelease as boolean,
    isDraft: release.isDraft as boolean,
    authorLogin: author?.login
  };
}

function extractLabels(payload: GitHubRawPayload): string[] {
  return (payload.labels ?? []).filter(Boolean);
}

function hasExcludedLabel(item: RawSourceItem, excludeLabels: Set<string>): boolean {
  if (excludeLabels.size === 0) return false;
  const labels = item.payload.labels;
  if (!Array.isArray(labels)) return false;
  return labels.some(l => excludeLabels.has(String(l).toLowerCase()));
}

function subtractSeconds(isoDate: string, seconds: number): string {
  const date = new Date(isoDate);
  date.setTime(date.getTime() - seconds * 1000);
  return date.toISOString();
}
