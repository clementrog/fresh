import type { AppEnv } from "../config/env.js";
import type {
  FetchResult,
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

  override async fetchSince(cursor: string | null, config: LinearSourceConfig, context: RunContext): Promise<RawSourceItem[]> {
    const result = await this.fetchSinceV2(cursor, config, context);
    return result.items;
  }

  override async fetchSinceV2(cursor: string | null, config: LinearSourceConfig, _context: RunContext): Promise<FetchResult> {
    if (!config.enabled || !this.env.LINEAR_API_KEY) {
      return { items: [], nextCursor: cursor, warnings: [], partialCompletion: false };
    }

    const { perEntity, legacyFallback } = parseLinearCursors(cursor);
    const updatedCursors: LinearCursorMap = {
      issues: perEntity.issues ?? legacyFallback,
      projectUpdates: perEntity.projectUpdates ?? legacyFallback,
      // Projects: intentionally null on first run to backfill historical releases
      projects: perEntity.projects ?? null
    };

    const items: RawSourceItem[] = [];
    const warnings: string[] = [];

    if (config.includeIssues) {
      const teamFilter = buildTeamFilter(config.teamKeys);
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
          team { name key }
          labels { nodes { name } }
          project { name }
        `,
        teamFilter ? `filter: ${teamFilter}` : undefined
      );

      for (const issue of issues) {
        const updatedAt = String(issue.updatedAt ?? "");
        if (updatedCursors.issues && updatedAt <= updatedCursors.issues) {
          continue;
        }
        items.push({
          id: String(issue.id),
          cursor: updatedAt,
          payload: { ...issue, itemType: "issue" }
        });
        if (!updatedCursors.issues || updatedAt > updatedCursors.issues) {
          updatedCursors.issues = updatedAt;
        }
      }
    }

    if (config.includeProjectUpdates) {
      const projectTeamFilter = buildProjectTeamFilter(config.teamKeys);
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
        `,
        projectTeamFilter ? `filter: ${projectTeamFilter}` : undefined
      );

      for (const update of updates) {
        const updatedAt = String(update.updatedAt ?? update.createdAt ?? "");
        if (updatedCursors.projectUpdates && updatedAt <= updatedCursors.projectUpdates) {
          continue;
        }
        items.push({
          id: String(update.id),
          cursor: updatedAt,
          payload: { ...update, itemType: "project_update" }
        });
        if (!updatedCursors.projectUpdates || updatedAt > updatedCursors.projectUpdates) {
          updatedCursors.projectUpdates = updatedAt;
        }
      }
    }

    if (config.includeProjects) {
      const projectItems = await this.fetchProjects(config, updatedCursors.projects ?? null);
      items.push(...projectItems);
      for (const item of projectItems) {
        if (!updatedCursors.projects || item.cursor > updatedCursors.projects) {
          updatedCursors.projects = item.cursor;
        }
      }
    }

    return {
      items: items.sort((a, b) => a.cursor.localeCompare(b.cursor)),
      nextCursor: serializeLinearCursors(updatedCursors),
      warnings,
      partialCompletion: false
    };
  }

  override async normalize(rawItem: RawSourceItem, config: LinearSourceConfig, context: RunContext): Promise<NormalizedSourceItem> {
    const payload = rawItem.payload as LinearRawPayload;

    if (payload.itemType === "project") {
      return this.normalizeProject(rawItem, payload, config, context);
    }

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
        stateName: typeof payload.state === "object" ? payload.state?.name : undefined,
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

  private normalizeProject(rawItem: RawSourceItem, payload: LinearRawPayload, config: LinearSourceConfig, context: RunContext): NormalizedSourceItem {
    const latestUpdate = payload.projectUpdates?.nodes?.[0];
    const description = payload.description ?? "";
    const updateBody = latestUpdate?.body ?? "";
    const text = description + (updateBody ? `\n\n---\n\n${updateBody}` : "");
    const sourceItemId = String(payload.id ?? rawItem.id);

    return {
      source: "linear",
      sourceItemId,
      externalId: `linear:${sourceItemId}`,
      sourceFingerprint: hashParts(["linear", sourceItemId, text]),
      sourceUrl: payload.url ?? "",
      title: payload.name ?? `Linear project ${rawItem.id}`,
      text,
      summary: text.slice(0, 200),
      occurredAt: payload.updatedAt ?? payload.completedAt ?? context.now.toISOString(),
      ingestedAt: context.now.toISOString(),
      metadata: {
        itemType: "project",
        projectState: payload.state,
        projectStartDate: payload.startDate,
        projectTargetDate: payload.targetDate,
        projectCompletedAt: payload.completedAt,
        projectLabels: payload.labels?.nodes?.map(l => l.name) ?? [],
        projectTeams: payload.teams?.nodes?.map(t => t.key) ?? [],
        projectHealth: latestUpdate?.health,
        projectName: payload.name,
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

  private async fetchProjects(config: LinearSourceConfig, cursor: string | null): Promise<RawSourceItem[]> {
    const filterParts: string[] = [];
    if (config.teamKeys?.length) {
      filterParts.push(`accessibleTeams: { some: { key: { in: ${JSON.stringify(config.teamKeys)} } } }`);
    }
    if (config.projectStateFilter?.length) {
      filterParts.push(`state: { in: ${JSON.stringify(config.projectStateFilter)} }`);
    }
    const filterArg = filterParts.length > 0 ? `filter: { ${filterParts.join(", ")} }` : "";

    // Page size reduced from 100 to 50: the nested projectUpdates, labels,
    // and teams selections push per-project complexity high enough that 100
    // projects exceeds Linear's 10,000 complexity budget (12,650 at 100).
    const projects = await this.paginateNodes<Record<string, unknown>>(
      config,
      "projects",
      `
        id
        name
        description
        state
        url
        updatedAt
        startDate
        targetDate
        completedAt
        labels { nodes { name } }
        teams { nodes { key name } }
        projectUpdates(first: 3, orderBy: createdAt) {
          nodes { body health createdAt }
        }
      `,
      filterArg || undefined,
      50
    );

    const items: RawSourceItem[] = [];
    for (const project of projects) {
      const updatedAt = String(project.updatedAt ?? "");
      if (cursor && updatedAt <= cursor) {
        continue;
      }
      items.push({
        id: String(project.id),
        cursor: updatedAt,
        payload: { ...project, itemType: "project" }
      });
    }
    return items;
  }

  private async paginateNodes<T extends Record<string, unknown>>(
    config: LinearSourceConfig,
    fieldName: string,
    selection: string,
    filterArg?: string,
    pageSize: number = 100
  ) {
    const nodes: T[] = [];
    let after: string | null = null;
    let hasNextPage = true;
    const filterClause = filterArg ? `, ${filterArg}` : "";

    while (hasNextPage) {
      const data: Record<string, { nodes?: T[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }> = await this.queryLinear(
        config,
        `
          query PaginatedNodes($after: String) {
            ${fieldName}(first: ${pageSize}, after: $after${filterClause}) {
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
      let body = "";
      try { body = await response.text(); } catch { /* ignore read errors */ }
      throw new Error(`Linear request failed with ${response.status}: ${body.slice(0, 500)}`);
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

// --- Raw payload type ---

interface LinearRawPayload {
  id?: string;
  title?: string;
  name?: string;
  description?: string;
  body?: string;
  url?: string;
  updatedAt?: string;
  createdAt?: string;
  completedAt?: string;
  startDate?: string;
  targetDate?: string;
  state?: string | { name?: string };
  itemType?: string;
  identifier?: string;
  priority?: number;
  team?: { name?: string; key?: string };
  labels?: { nodes?: Array<{ name?: string }> };
  teams?: { nodes?: Array<{ key?: string; name?: string }> };
  project?: { name?: string; state?: string };
  projectUpdates?: { nodes?: Array<{ body?: string; health?: string; createdAt?: string }> };
  health?: string;
}

// --- Composite cursor helpers ---

type LinearCursorMap = {
  issues?: string | null;
  projectUpdates?: string | null;
  projects?: string | null;
};

export function parseLinearCursors(raw: string | null): { perEntity: LinearCursorMap; legacyFallback: string | null } {
  if (!raw) return { perEntity: {}, legacyFallback: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { perEntity: parsed as LinearCursorMap, legacyFallback: null };
    }
  } catch {
    // Not JSON — legacy plain ISO-string cursor
  }
  return { perEntity: {}, legacyFallback: raw };
}

export function serializeLinearCursors(cursors: LinearCursorMap): string {
  return JSON.stringify(cursors);
}

// --- Team filter helpers ---

function buildTeamFilter(teamKeys?: string[]): string | null {
  if (!teamKeys?.length) return null;
  return `{ team: { key: { in: ${JSON.stringify(teamKeys)} } } }`;
}

function buildProjectTeamFilter(teamKeys?: string[]): string | null {
  if (!teamKeys?.length) return null;
  return `{ project: { accessibleTeams: { some: { key: { in: ${JSON.stringify(teamKeys)} } } } } }`;
}
