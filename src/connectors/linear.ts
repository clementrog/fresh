import type { AppEnv } from "../config/env.js";
import type {
  LinearSourceConfig,
  NormalizedSourceItem,
  RawSourceItem,
  RunContext
} from "../domain/types.js";
import { hashParts } from "../lib/ids.js";
import { BaseConnector } from "./base.js";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

export class LinearConnector extends BaseConnector<LinearSourceConfig> {
  readonly source = "linear" as const;

  constructor(private readonly env: AppEnv) {
    super();
  }

  override async fetchSince(cursor: string | null, config: LinearSourceConfig, _context: RunContext): Promise<RawSourceItem[]> {
    if (!config.enabled || !this.env.LINEAR_API_KEY) {
      return [];
    }

    const items: RawSourceItem[] = [];
    if (config.includeIssues) {
      const issues = await this.paginateNodes<Record<string, unknown>>(
        config,
        "issues",
        `
          id
          title
          description
          updatedAt
          createdAt
          completedAt
          url
          identifier
          priority
          state { name }
          team { name }
          labels { nodes { name } }
          project { name }
        `
      );

      for (const issue of issues) {
        const updatedAt = String(issue.updatedAt ?? "");
        if (cursor && updatedAt <= cursor) {
          continue;
        }
        items.push({
          id: String(issue.id),
          cursor: updatedAt,
          payload: {
            ...issue,
            itemType: "issue"
          }
        });
      }
    }

    if (config.includeProjectUpdates) {
      const updates = await this.paginateNodes<Record<string, unknown>>(
        config,
        "projectUpdates",
        `
          id
          url
          body
          createdAt
          updatedAt
          health
          project { name state }
        `
      );

      for (const update of updates) {
        const updatedAt = String(update.updatedAt ?? update.createdAt ?? "");
        if (cursor && updatedAt <= cursor) {
          continue;
        }
        items.push({
          id: String(update.id),
          cursor: updatedAt,
          payload: {
            ...update,
            itemType: "project_update"
          }
        });
      }
    }

    return items.sort((left, right) => left.cursor.localeCompare(right.cursor));
  }

  override async normalize(rawItem: RawSourceItem, config: LinearSourceConfig, context: RunContext): Promise<NormalizedSourceItem> {
    const payload = rawItem.payload as {
      id?: string;
      title?: string;
      description?: string;
      body?: string;
      url?: string;
      updatedAt?: string;
      createdAt?: string;
      completedAt?: string;
      itemType?: string;
      identifier?: string;
      priority?: number;
      state?: { name?: string };
      team?: { name?: string };
      labels?: { nodes?: Array<{ name?: string }> };
      project?: { name?: string; state?: string };
      health?: string;
    };
    const text = payload.description ?? payload.body ?? "";
    const sourceItemId = String(payload.id ?? rawItem.id);
    const sourceUrl = payload.url
      || (payload.itemType === "project_update" && payload.project?.name
        ? `https://linear.app/project-update/${sourceItemId}`
        : "");
    return {
      source: "linear",
      sourceItemId,
      externalId: `linear:${sourceItemId}`,
      sourceFingerprint: hashParts(["linear", sourceItemId, text]),
      sourceUrl,
      title: payload.title
        ?? (payload.project?.name ? `Project update: ${payload.project.name}` : undefined)
        ?? payload.identifier
        ?? `Linear item ${rawItem.id}`,
      text,
      summary: text.slice(0, 200),
      occurredAt: payload.updatedAt ?? payload.createdAt ?? context.now.toISOString(),
      ingestedAt: context.now.toISOString(),
      metadata: {
        itemType: payload.itemType ?? "issue",
        stateName: payload.state?.name,
        teamName: payload.team?.name,
        priority: payload.priority,
        labels: payload.labels?.nodes?.map(l => l.name) ?? [],
        projectName: payload.project?.name,
        createdAt: payload.createdAt,
        completedAt: payload.completedAt,
        projectHealth: payload.health,
        projectState: payload.project?.state,
        includeIssueComments: config.includeIssueComments,
        storeRawText: config.storeRawText
      },
      rawPayload: rawItem.payload,
      rawText: config.storeRawText ? text : null
    };
  }

  override async backfill(range: { from: Date; to: Date }, config: LinearSourceConfig, context: RunContext): Promise<RawSourceItem[]> {
    return this.fetchSince(range.from.toISOString(), config, {
      dryRun: false,
      now: context.now
    });
  }

  private async paginateNodes<T extends Record<string, unknown>>(config: LinearSourceConfig, fieldName: string, selection: string) {
    const nodes: T[] = [];
    let after: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const data: Record<string, { nodes?: T[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }> = await this.queryLinear(
        config,
        `
          query PaginatedNodes($after: String) {
            ${fieldName}(first: 100, after: $after) {
              nodes {
                ${selection}
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        { after }
      );

      const page: { nodes?: T[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } | undefined = data[fieldName];
      nodes.push(...(page?.nodes ?? []));
      hasNextPage = Boolean(page?.pageInfo?.hasNextPage);
      after = page?.pageInfo?.endCursor ?? null;
    }

    return nodes;
  }

  private async queryLinear<T>(config: LinearSourceConfig, query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.executeWithRateLimit(config, () =>
      fetch(LINEAR_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.env.LINEAR_API_KEY ?? ""
        },
        body: JSON.stringify({ query, variables })
      })
    );

    if (!response.ok) {
      throw new Error(`Linear request failed with ${response.status}`);
    }

    const payload = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((error) => error.message ?? "Unknown Linear error").join("; "));
    }

    if (!payload.data) {
      throw new Error("Linear response missing data");
    }

    return payload.data;
  }
}
