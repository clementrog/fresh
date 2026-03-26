import { Client } from "@hubspot/api-client";
import { addDays } from "date-fns";
import { z } from "zod";
import type { Logger } from "pino";
import type { EngagementType } from "../domain/types.js";
import type { SalesRepositoryBundle } from "../db/sales-repositories.js";
import {
  salesDealDbId,
  salesContactDbId,
  salesHubspotCompanyDbId,
} from "../db/sales-repositories.js";
import {
  mapHubSpotDeal,
  mapHubSpotContact,
  mapHubSpotCompany,
  mapHubSpotActivity,
  DEAL_PROPERTIES,
  CONTACT_PROPERTIES,
  COMPANY_PROPERTIES,
  ENGAGEMENT_PROPERTIES_BY_TYPE,
  type RawHubSpotObject,
} from "./hubspot-mappers.js";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type HubSpotErrorClass =
  | "auth_invalid"
  | "auth_insufficient"
  | "not_found"
  | "doctrine_missing"
  | "doctrine_invalid"
  | "pipeline_not_found"
  | "pipeline_inaccessible"
  | "association_unsupported"
  | "rate_limited"
  | "transient"
  | "schema_mismatch"
  | "unknown";

/** Extract HTTP status code from HubSpot SDK errors (uses .code) or other shapes (.statusCode).
 *  Tolerates non-Error thrown objects (e.g. plain { code: 429 }). */
function extractHttpStatus(error: unknown): number {
  if (typeof error === "object" && error !== null) {
    if ("code" in error && typeof (error as { code: unknown }).code === "number") {
      return (error as { code: number }).code;
    }
    if ("statusCode" in error && typeof (error as { statusCode: unknown }).statusCode === "number") {
      return (error as { statusCode: number }).statusCode;
    }
  }
  return 0;
}

export function classifyHubSpotError(error: unknown): HubSpotErrorClass {
  const status = extractHttpStatus(error);
  if (status === 401) return "auth_invalid";
  if (status === 403) return "auth_insufficient";
  if (status === 404) return "not_found";
  if (status === 400) return "association_unsupported";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "transient";

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("econnrefused") ||
      msg.includes("etimedout") ||
      msg.includes("enotfound") ||
      msg.includes("socket hang up")
    ) {
      return "transient";
    }
  }
  return "unknown";
}

export function translateSalesError(error: unknown): { message: string; exitCode: number } {
  const msg = error instanceof Error ? error.message : String(error);

  // Local prerequisite errors (thrown as plain Errors without HTTP status codes)
  if (msg.includes("HUBSPOT_ACCESS_TOKEN is not configured")) {
    return { message: "HUBSPOT_ACCESS_TOKEN is not configured. Set it in your environment before running sync.", exitCode: 1 };
  }
  if (msg.includes("No SalesDoctrine found")) {
    return { message: "No SalesDoctrine configured for this company. Create one before running sync.", exitCode: 1 };
  }
  if (msg.includes("SalesDoctrine validation failed")) {
    return { message: `SalesDoctrine is invalid: ${msg}. Fix the doctrine configuration.`, exitCode: 1 };
  }

  const cls = classifyHubSpotError(error);
  const table: Record<HubSpotErrorClass, string> = {
    auth_invalid: "HubSpot authentication failed. Check that HUBSPOT_ACCESS_TOKEN is valid and not expired.",
    auth_insufficient: "HubSpot token lacks required permissions. Ensure your Private App has CRM scopes (deals, contacts, companies).",
    not_found: "A requested HubSpot resource was not found. Verify that referenced object IDs exist.",
    rate_limited: "HubSpot rate limit hit. Wait 60 seconds and retry, or reduce concurrent HubSpot processes.",
    transient: "HubSpot is temporarily unreachable. Retry in a few minutes.",
    pipeline_not_found: "Configured pipeline not found in HubSpot. Check hubspotPipelineId in your SalesDoctrine.",
    pipeline_inaccessible: "HubSpot token cannot access the configured pipeline. Check Private App scopes.",
    association_unsupported: "A required HubSpot association path is not available. Check CRM customizations.",
    doctrine_missing: "No SalesDoctrine configured for this company. Create one before running sync.",
    doctrine_invalid: "SalesDoctrine is invalid. Fix the doctrine configuration.",
    schema_mismatch: "HubSpot API returned an unexpected response shape. Check SDK version compatibility.",
    unknown: `Unexpected error: ${msg}`,
  };
  return { message: table[cls], exitCode: 1 };
}

// ---------------------------------------------------------------------------
// Doctrine validation (Zod — validate only fields sync needs)
// ---------------------------------------------------------------------------

const SyncDoctrineSchema = z.object({
  hubspotPipelineId: z.string().min(1, "hubspotPipelineId is required"),
  stalenessThresholdDays: z.number().int().positive().default(21),
});

type SyncDoctrineSlice = z.infer<typeof SyncDoctrineSchema>;

export function validateDoctrineForSync(raw: unknown): SyncDoctrineSlice {
  const result = SyncDoctrineSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`SalesDoctrine validation failed: ${issues}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Two-level cursor: checkpoint + frontier
// ---------------------------------------------------------------------------

export const REPLAY_MS = 120_000; // 2 minutes

export interface SyncCursor {
  frontier: string;         // ISO: visibility-safe search boundary (GTE filter)
  checkpoint: string;       // ISO: highest committed hs_lastmodifieddate
  settledAt: string | null; // ISO wall-clock: when checkpoint was first observed stable
}

const EPOCH = "1970-01-01T00:00:00.000Z";

function defaultCursor(): SyncCursor {
  return { frontier: EPOCH, checkpoint: EPOCH, settledAt: null };
}

export function parseSyncCursor(raw: string | null): SyncCursor {
  if (raw == null || raw === "") return defaultCursor();
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.frontier !== "string" ||
      typeof parsed.checkpoint !== "string" ||
      Number.isNaN(Date.parse(parsed.frontier)) ||
      Number.isNaN(Date.parse(parsed.checkpoint))
    ) {
      return defaultCursor();
    }
    return {
      frontier: parsed.frontier,
      checkpoint: parsed.checkpoint,
      settledAt: typeof parsed.settledAt === "string" ? parsed.settledAt : null,
    };
  } catch {
    return defaultCursor();
  }
}

export function serializeSyncCursor(cursor: SyncCursor): string {
  return JSON.stringify(cursor);
}

export function tryGraduate(cursor: SyncCursor, now: Date): SyncCursor {
  if (cursor.settledAt == null) return cursor;
  const elapsed = now.getTime() - Date.parse(cursor.settledAt);
  if (elapsed < REPLAY_MS) return cursor;
  // Graduate: advance frontier past checkpoint, checkpoint stays unchanged
  const advancedFrontier = new Date(Date.parse(cursor.checkpoint) + 1).toISOString();
  return {
    frontier: advancedFrontier,
    checkpoint: cursor.checkpoint,
    settledAt: null,
  };
}

export function advanceCursorForBatch(
  batchMax: string,
  current: SyncCursor
): SyncCursor {
  if (Date.parse(batchMax) <= Date.parse(current.checkpoint)) return current;
  const newCheckpoint = batchMax;
  const newFrontier = new Date(
    Math.max(Date.parse(EPOCH), Date.parse(newCheckpoint) - REPLAY_MS)
  ).toISOString();
  return {
    frontier: newFrontier,
    checkpoint: newCheckpoint,
    settledAt: null,
  };
}

// ---------------------------------------------------------------------------
// HubSpot API port (abstraction for testability)
// ---------------------------------------------------------------------------

export interface DealSearchRequest {
  filterGroups: Array<{
    filters: Array<{
      propertyName: string;
      operator: string;
      value?: string;
    }>;
  }>;
  properties: string[];
  limit: number;
  after?: string;
  sorts?: Array<{ propertyName: string; direction: string }>;
}

export interface DealSearchResult {
  total: number;
  results: RawHubSpotObject[];
  paging?: { next?: { after: string } };
}

export interface HubSpotApiPort {
  searchDeals(request: DealSearchRequest): Promise<DealSearchResult>;
  getContactById(id: string, properties: string[]): Promise<RawHubSpotObject>;
  getCompanyById(id: string, properties: string[]): Promise<RawHubSpotObject>;
  getAssociations(
    fromType: string,
    fromId: string,
    toType: string
  ): Promise<Array<{ toObjectId: string }>>;
  getEngagementById(
    type: EngagementType,
    id: string,
    properties: string[]
  ): Promise<RawHubSpotObject>;
}

// ---------------------------------------------------------------------------
// Production adapter wrapping @hubspot/api-client
// ---------------------------------------------------------------------------

export function createHubSpotApiAdapter(client: Client): HubSpotApiPort {
  const rateLimiter = new RateLimiter(600, 3, 1000);

  return {
    async searchDeals(request) {
      return rateLimiter.execute(async () => {
        const resp = await client.crm.deals.searchApi.doSearch({
          filterGroups: request.filterGroups.map((fg) => ({
            filters: fg.filters.map((f) => ({
              propertyName: f.propertyName,
              operator: f.operator,
              value: f.value,
            })),
          })) as any,  // eslint-disable-line @typescript-eslint/no-explicit-any -- HubSpot SDK uses enum, we pass matching strings
          properties: request.properties,
          limit: request.limit,
          after: request.after ? request.after : undefined,
          sorts: request.sorts?.map((s) => `${s.propertyName}`) ?? [],
        });
        return {
          total: resp.total,
          results: resp.results.map((r) => ({
            id: r.id,
            properties: r.properties as Record<string, string | null>,
            updatedAt: r.updatedAt?.toISOString(),
          })),
          paging: resp.paging ? { next: resp.paging.next ? { after: resp.paging.next.after } : undefined } : undefined,
        };
      });
    },

    async getContactById(id, properties) {
      return rateLimiter.execute(async () => {
        const resp = await client.crm.contacts.basicApi.getById(id, properties);
        return { id: resp.id, properties: resp.properties as Record<string, string | null> };
      });
    },

    async getCompanyById(id, properties) {
      return rateLimiter.execute(async () => {
        const resp = await client.crm.companies.basicApi.getById(id, properties);
        return { id: resp.id, properties: resp.properties as Record<string, string | null> };
      });
    },

    async getAssociations(fromType, fromId, toType) {
      return rateLimiter.execute(async () => {
        const resp = await client.crm.associations.v4.basicApi.getPage(
          fromType,
          fromId,
          toType,
          undefined,
          500
        );
        return (resp.results ?? []).map((r) => ({
          toObjectId: String(r.toObjectId),
        }));
      });
    },

    async getEngagementById(type, id, properties) {
      return rateLimiter.execute(async () => {
        const apiMap = {
          email: client.crm.objects.emails,
          note: client.crm.objects.notes,
          call: client.crm.objects.calls,
          meeting: client.crm.objects.meetings,
        } as const;
        const api = apiMap[type];
        const resp = await api.basicApi.getById(id, properties);
        return { id: resp.id, properties: resp.properties as Record<string, string | null> };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Rate limiter (token-bucket with retry)
// ---------------------------------------------------------------------------

export class RateLimiter {
  private lastRequestAt = 0;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly maxRetries: number,
    private readonly initialDelayMs: number
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const minDelayMs = Math.ceil(60_000 / Math.max(1, this.requestsPerMinute));
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < minDelayMs) {
      await sleep(minDelayMs - elapsed);
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await operation();
        this.lastRequestAt = Date.now();
        return result;
      } catch (error: unknown) {
        this.lastRequestAt = Date.now();
        const is429 = extractHttpStatus(error) === 429;
        if (!is429 || attempt === this.maxRetries) throw error;
        await sleep(this.initialDelayMs * (attempt + 1));
      }
    }
    throw new Error("Rate-limited operation failed");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Sync result
// ---------------------------------------------------------------------------

export interface SyncCounters {
  deals: number;
  contacts: number;
  companies: number;
  activities: number;
  associations: number;
  [key: string]: number;  // index signature for Record<string, number> compat
}

export interface SyncResult {
  counters: SyncCounters;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export type PreflightCheckStatus = "pass" | "fail" | "warn" | "skip";

export interface PreflightCheck {
  name: string;
  status: PreflightCheckStatus;
  message: string;
  errorClass?: HubSpotErrorClass;
  durationMs: number;
}

export interface PreflightResult {
  ok: boolean;
  verified: boolean;
  checks: PreflightCheck[];
  summary: string;
}

export interface PreflightHubSpotClient {
  crm: {
    pipelines: {
      pipelinesApi: {
        getAll(objectType: string): Promise<{ results: Array<{ id: string; label: string }> }>;
        getById(objectType: string, pipelineId: string): Promise<{ id: string; label: string; stages: unknown[] }>;
      };
    };
  };
}

// ---------------------------------------------------------------------------
// Stage label resolution
// ---------------------------------------------------------------------------

export async function fetchPipelineStageMap(
  client: PreflightHubSpotClient,
  pipelineId: string
): Promise<Map<string, string>> {
  const resp = await client.crm.pipelines.pipelinesApi.getById("deals", pipelineId);
  const stages = Array.isArray(resp.stages) ? resp.stages : [];
  const map = new Map<string, string>();
  for (const stage of stages) {
    const s = stage as { id?: string; label?: string };
    if (s.id && s.label) {
      map.set(s.id, s.label);
    }
  }
  return map;
}

const ASSOC_PROBE_PATHS: Array<{ toType: string; label: string }> = [
  { toType: "contacts", label: "deal→contacts" },
  { toType: "companies", label: "deal→companies" },
  { toType: "emails", label: "deal→emails" },
  { toType: "notes", label: "deal→notes" },
  { toType: "calls", label: "deal→calls" },
  { toType: "meetings", label: "deal→meetings" },
];

function buildSummary(checks: PreflightCheck[]): { ok: boolean; verified: boolean; summary: string } {
  let passed = 0, failed = 0, skipped = 0, unverified = 0;
  for (const c of checks) {
    if (c.status === "pass") passed++;
    else if (c.status === "fail") failed++;
    else if (c.status === "skip") skipped++;
    else if (c.status === "warn") unverified++;
  }
  const parts: string[] = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (unverified > 0) parts.push(`${unverified} unverified`);
  return {
    ok: failed === 0,
    verified: passed === checks.length,
    summary: parts.join(", "),
  };
}

/** Extract a concise operator-facing message from a HubSpot SDK error.
 *  SDK errors dump full HTTP response (headers, cookies, body). This extracts
 *  just the HubSpot `message` field from the JSON body, or truncates. */
function conciseHubSpotMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const raw = err.message;
  // HubSpot SDK format: "HTTP-Code: NNN\nMessage: ...\nBody: {json}\nHeaders: ..."
  const bodyMatch = raw.match(/Body:\s*(\{[\s\S]*?\})\s*(?:Headers:|$)/);
  if (bodyMatch) {
    try {
      const body = JSON.parse(bodyMatch[1]);
      if (typeof body.message === "string" && body.message.length > 0) {
        return body.message;
      }
    } catch { /* fall through */ }
  }
  // Truncate overly long raw messages
  if (raw.length > 200) return raw.slice(0, 200) + "…";
  return raw;
}

async function timedCheck(
  name: string,
  fn: () => Promise<Omit<PreflightCheck, "name" | "durationMs">>
): Promise<PreflightCheck> {
  const start = Date.now();
  const result = await fn();
  return { name, ...result, durationMs: Date.now() - start };
}

export async function runPreflight(opts: {
  api: HubSpotApiPort;
  client: PreflightHubSpotClient;
  repos: Pick<SalesRepositoryBundle, "getLatestDoctrine">;
  companyId: string;
  logger: Logger;
}): Promise<PreflightResult> {
  const { api, client, repos, companyId, logger } = opts;
  const checks: PreflightCheck[] = [];
  let authOk = false;
  let portalOk = false;
  let doctrineOk = false;
  let pipelineOk = false;
  let pipelineId: string | undefined;
  let sampleDealId: string | undefined;

  // 1. auth — searchDeals with limit:1
  const authCheck = await timedCheck("auth", async () => {
    try {
      await api.searchDeals({
        filterGroups: [],
        properties: ["hs_object_id"],
        limit: 1,
      });
      return { status: "pass" as const, message: "HubSpot API reachable, token valid" };
    } catch (err) {
      const cls = classifyHubSpotError(err);
      return { status: "fail" as const, message: `Authentication failed: ${conciseHubSpotMessage(err)}`, errorClass: cls };
    }
  });
  checks.push(authCheck);
  authOk = authCheck.status === "pass";

  // 2. portal — pipelines API
  if (!authOk) {
    checks.push({ name: "portal", status: "skip", message: "skipped — auth check failed", durationMs: 0 });
  } else {
    const portalCheck = await timedCheck("portal", async () => {
      try {
        const resp = await client.crm.pipelines.pipelinesApi.getAll("deals");
        return { status: "pass" as const, message: `Portal accessible, ${resp.results.length} deal pipeline(s) found` };
      } catch (err) {
        const cls = classifyHubSpotError(err);
        return { status: "fail" as const, message: `Pipeline API unreachable: ${conciseHubSpotMessage(err)}`, errorClass: cls };
      }
    });
    checks.push(portalCheck);
    portalOk = portalCheck.status === "pass";
  }

  // 3. doctrine — local DB read, always runs
  const doctrineCheck = await timedCheck("doctrine", async () => {
    try {
      const doctrine = await repos.getLatestDoctrine(companyId);
      if (!doctrine) {
        return { status: "fail" as const, message: "No SalesDoctrine found for this company", errorClass: "doctrine_missing" as const };
      }
      const validated = validateDoctrineForSync(doctrine.doctrineJson);
      pipelineId = validated.hubspotPipelineId;
      return { status: "pass" as const, message: `SalesDoctrine loaded, hubspotPipelineId=${pipelineId}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("SalesDoctrine validation failed")) {
        return { status: "fail" as const, message: msg, errorClass: "doctrine_invalid" as const };
      }
      return { status: "fail" as const, message: `Failed to load doctrine: ${msg}` };
    }
  });
  checks.push(doctrineCheck);
  doctrineOk = doctrineCheck.status === "pass";

  // 4. pipeline — requires portal + doctrine
  if (!portalOk || !doctrineOk) {
    const reason = !portalOk ? "portal" : "doctrine";
    checks.push({ name: "pipeline", status: "skip", message: `skipped — ${reason} check failed`, durationMs: 0 });
  } else {
    const pipelineCheck = await timedCheck("pipeline", async () => {
      try {
        const resp = await client.crm.pipelines.pipelinesApi.getById("deals", pipelineId!);
        const stageCount = Array.isArray(resp.stages) ? resp.stages.length : 0;
        return { status: "pass" as const, message: `Pipeline "${pipelineId}" exists with ${stageCount} stage(s)` };
      } catch (err) {
        const cls = classifyHubSpotError(err);
        const effectiveClass = cls === "not_found" ? "pipeline_not_found"
          : cls === "auth_insufficient" ? "pipeline_inaccessible"
          : cls;
        return { status: "fail" as const, message: `Pipeline "${pipelineId}" not accessible: ${conciseHubSpotMessage(err)}`, errorClass: effectiveClass };
      }
    });
    checks.push(pipelineCheck);
    pipelineOk = pipelineCheck.status === "pass";
  }

  // Gate for probes: need auth + portal + doctrine + pipeline all passed
  const probesGated = !authOk || !portalOk || !doctrineOk || !pipelineOk;
  const gateReason = !authOk ? "auth" : !portalOk ? "portal" : !doctrineOk ? "doctrine" : "pipeline";

  // 5. object_reads — 4 sub-checks
  if (probesGated) {
    for (const sub of ["object_reads:deals", "object_reads:contacts", "object_reads:companies", "object_reads:engagements"]) {
      checks.push({ name: sub, status: "skip", message: `skipped — ${gateReason} check failed`, durationMs: 0 });
    }
  } else {
    // 5a. object_reads:deals
    const dealsCheck = await timedCheck("object_reads:deals", async () => {
      try {
        const resp = await api.searchDeals({
          filterGroups: [{ filters: [{ propertyName: "pipeline", operator: "EQ", value: pipelineId! }] }],
          properties: ["hs_object_id"],
          limit: 1,
        });
        if (resp.results.length > 0) {
          sampleDealId = resp.results[0].id;
        }
        return { status: "pass" as const, message: `Search succeeded, ${resp.total} deal(s) in pipeline` };
      } catch (err) {
        const cls = classifyHubSpotError(err);
        return { status: "fail" as const, message: `Deal search failed: ${conciseHubSpotMessage(err)}`, errorClass: cls };
      }
    });
    checks.push(dealsCheck);

    // 5b. object_reads:contacts
    if (!sampleDealId) {
      checks.push({ name: "object_reads:contacts", status: "warn", message: "unverified — no sample deal available to probe contacts", durationMs: 0 });
    } else {
      const contactCheck = await timedCheck("object_reads:contacts", async () => {
        try {
          const assocs = await api.getAssociations("deals", sampleDealId!, "contacts");
          if (assocs.length === 0) {
            return { status: "warn" as const, message: "unverified — deal has no contacts" };
          }
          await api.getContactById(assocs[0].toObjectId, ["email"]);
          return { status: "pass" as const, message: "Contact read succeeded" };
        } catch (err) {
          const cls = classifyHubSpotError(err);
          return { status: "fail" as const, message: `Contact read failed: ${conciseHubSpotMessage(err)}`, errorClass: cls };
        }
      });
      checks.push(contactCheck);
    }

    // 5c. object_reads:companies
    if (!sampleDealId) {
      checks.push({ name: "object_reads:companies", status: "warn", message: "unverified — no sample deal available to probe companies", durationMs: 0 });
    } else {
      const companyCheck = await timedCheck("object_reads:companies", async () => {
        try {
          const assocs = await api.getAssociations("deals", sampleDealId!, "companies");
          if (assocs.length === 0) {
            return { status: "warn" as const, message: "unverified — deal has no companies" };
          }
          await api.getCompanyById(assocs[0].toObjectId, ["name"]);
          return { status: "pass" as const, message: "Company read succeeded" };
        } catch (err) {
          const cls = classifyHubSpotError(err);
          return { status: "fail" as const, message: `Company read failed: ${conciseHubSpotMessage(err)}`, errorClass: cls };
        }
      });
      checks.push(companyCheck);
    }

    // 5d. object_reads:engagements
    if (!sampleDealId) {
      checks.push({ name: "object_reads:engagements", status: "warn", message: "unverified — no sample deal available to probe engagements", durationMs: 0 });
    } else {
      const engCheck = await timedCheck("object_reads:engagements", async () => {
        try {
          // Try each engagement type until we find one
          for (const engType of (["email", "note", "call", "meeting"] as const)) {
            const assocType = { email: "emails", note: "notes", call: "calls", meeting: "meetings" }[engType];
            const assocs = await api.getAssociations("deals", sampleDealId!, assocType);
            if (assocs.length > 0) {
              await api.getEngagementById(engType, assocs[0].toObjectId, ["hs_timestamp"]);
              return { status: "pass" as const, message: `Engagement read succeeded (${engType})` };
            }
          }
          return { status: "warn" as const, message: "unverified — deal has no engagements" };
        } catch (err) {
          const cls = classifyHubSpotError(err);
          return { status: "fail" as const, message: `Engagement read failed: ${conciseHubSpotMessage(err)}`, errorClass: cls };
        }
      });
      checks.push(engCheck);
    }
  }

  // 6. associations — 6 sub-checks
  if (probesGated) {
    for (const p of ASSOC_PROBE_PATHS) {
      checks.push({ name: `assoc:${p.label}`, status: "skip", message: `skipped — ${gateReason} check failed`, durationMs: 0 });
    }
  } else if (!sampleDealId) {
    for (const p of ASSOC_PROBE_PATHS) {
      checks.push({ name: `assoc:${p.label}`, status: "warn", message: "unverified — no deals available to probe this path", durationMs: 0 });
    }
  } else {
    for (const p of ASSOC_PROBE_PATHS) {
      const assocCheck = await timedCheck(`assoc:${p.label}`, async () => {
        try {
          await api.getAssociations("deals", sampleDealId!, p.toType);
          return { status: "pass" as const, message: `Association path ${p.label} accessible` };
        } catch (err) {
          const cls = classifyHubSpotError(err);
          return { status: "fail" as const, message: `Association path ${p.label} failed: ${conciseHubSpotMessage(err)}`, errorClass: cls };
        }
      });
      checks.push(assocCheck);
    }
  }

  const result = buildSummary(checks);
  logger.info({ ok: result.ok, verified: result.verified, summary: result.summary }, "Preflight complete");
  return { ...result, checks };
}

// ---------------------------------------------------------------------------
// HubSpotSyncService
// ---------------------------------------------------------------------------

const ENGAGEMENT_TYPES: EngagementType[] = ["email", "note", "call", "meeting"];
const ASSOCIATION_TYPE_MAP: Record<EngagementType, string> = {
  email: "emails",
  note: "notes",
  call: "calls",
  meeting: "meetings",
};
const RAW_TEXT_RETENTION_DAYS = 30;
const BATCH_SIZE = 10;

export class HubSpotSyncService {
  constructor(
    private readonly api: HubSpotApiPort,
    private readonly repos: SalesRepositoryBundle,
    private readonly logger: Logger
  ) {}

  async runSync(companyId: string): Promise<SyncResult> {
    // 1. Load and validate doctrine
    const doctrine = await this.repos.getLatestDoctrine(companyId);
    if (!doctrine) {
      throw new Error(`No SalesDoctrine found for company ${companyId}. Create one before syncing.`);
    }
    const validated = validateDoctrineForSync(doctrine.doctrineJson);
    const pipelineId = validated.hubspotPipelineId;

    // 2. Create SyncRun
    const run = await this.repos.createSyncRun({
      companyId,
      runType: "sales:sync",
      source: "hubspot",
    });

    const counters: SyncCounters = { deals: 0, contacts: 0, companies: 0, activities: 0, associations: 0 };
    const warnings: string[] = [];

    try {
      // 3. Load and potentially graduate cursor
      let cursor = parseSyncCursor(await this.repos.getCursor(companyId, "hubspot:deals"));
      const graduated = tryGraduate(cursor, new Date());
      if (graduated !== cursor) {
        cursor = graduated;
        await this.repos.setCursor(companyId, "hubspot:deals", serializeSyncCursor(cursor));
        this.logger.info({ cursor }, "Cursor graduated");
      }

      // Snapshot checkpoint before processing to detect forward progress
      const checkpointAtRunStart = cursor.checkpoint;

      // 4. Fetch all deals across all pages
      const allDeals = await this.fetchAllDeals(pipelineId, cursor.frontier);

      if (allDeals.length === 0) {
        // No results — begin settling
        if (cursor.settledAt == null) {
          cursor = { ...cursor, settledAt: new Date().toISOString() };
          await this.repos.setCursor(companyId, "hubspot:deals", serializeSyncCursor(cursor));
        }
        await this.repos.finalizeSyncRun(run.id, "completed", counters, warnings);
        return { counters, warnings };
      }

      // 5. Process deals in batches
      for (let i = 0; i < allDeals.length; i += BATCH_SIZE) {
        const batch = allDeals.slice(i, i + BATCH_SIZE);
        const batchResult = await this.processBatch(companyId, pipelineId, batch);

        // Accumulate counters
        counters.deals += batchResult.counters.deals;
        counters.contacts += batchResult.counters.contacts;
        counters.companies += batchResult.counters.companies;
        counters.activities += batchResult.counters.activities;
        counters.associations += batchResult.counters.associations;
        warnings.push(...batchResult.warnings);

        // Advance cursor per-batch
        const batchMax = this.maxUpdatedAt(batch);
        if (batchMax) {
          const advanced = advanceCursorForBatch(batchMax, cursor);
          if (advanced !== cursor) {
            cursor = advanced;
            await this.repos.setCursor(companyId, "hubspot:deals", serializeSyncCursor(cursor));
          }
        }
      }

      // 6. Only arm settling if checkpoint did NOT advance during this run
      if (cursor.checkpoint === checkpointAtRunStart) {
        if (cursor.settledAt == null) {
          cursor = { ...cursor, settledAt: new Date().toISOString() };
          await this.repos.setCursor(companyId, "hubspot:deals", serializeSyncCursor(cursor));
        }
      }

      await this.repos.finalizeSyncRun(run.id, "completed", counters, warnings);
      return { counters, warnings };
    } catch (error) {
      const errorClass = classifyHubSpotError(error);
      // Log full error (including stack) at error level so diagnostics are not degraded
      this.logger.error({ errorClass, err: error }, "Sync failed");
      await this.repos.finalizeSyncRun(run.id, "failed", counters, warnings, String(error));
      throw error;
    }
  }

  // ---- Deal fetching with pagination ----

  private async fetchAllDeals(pipelineId: string, frontier: string): Promise<RawHubSpotObject[]> {
    const allDeals: RawHubSpotObject[] = [];
    let after: string | undefined;

    do {
      const resp = await this.api.searchDeals({
        filterGroups: [
          {
            filters: [
              { propertyName: "pipeline", operator: "EQ", value: pipelineId },
              { propertyName: "hs_lastmodifieddate", operator: "GTE", value: frontier },
            ],
          },
        ],
        properties: [...DEAL_PROPERTIES],
        limit: 100,
        after,
        sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
      });

      allDeals.push(...resp.results);
      after = resp.paging?.next?.after;
    } while (after);

    return allDeals;
  }

  // ---- Batch processing ----

  private async processBatch(
    companyId: string,
    pipelineId: string,
    deals: RawHubSpotObject[]
  ): Promise<SyncResult> {
    const batchCounters: SyncCounters = { deals: 0, contacts: 0, companies: 0, activities: 0, associations: 0 };
    const batchWarnings: string[] = [];

    // Pre-fetch all associations and related records for the batch
    // Track which contact HubSpot IDs were successfully fetched (for safe FK resolution)
    const fetchedContactHsIds = new Set<string>();

    const dealData: Array<{
      deal: ReturnType<typeof mapHubSpotDeal>;
      contacts: Array<ReturnType<typeof mapHubSpotContact>>;
      companies: Array<ReturnType<typeof mapHubSpotCompany>>;
      activities: Array<ReturnType<typeof mapHubSpotActivity>>;
      engagementContacts: Array<ReturnType<typeof mapHubSpotContact>>; // contacts discovered via engagement-contact path only (no deal link)
      contactDbIds: string[];
      companyDbIds: string[];
    }> = [];

    for (const rawDeal of deals) {
      const mapped = mapHubSpotDeal(rawDeal, companyId, pipelineId);
      const dealDbId = salesDealDbId(companyId, rawDeal.id);

      // Fetch associated contacts
      const contacts: Array<ReturnType<typeof mapHubSpotContact>> = [];
      const contactDbIds: string[] = [];
      try {
        const contactAssocs = await this.api.getAssociations("deals", rawDeal.id, "contacts");
        const uniqueContactIds = [...new Set(contactAssocs.map((a) => a.toObjectId))];
        for (const cid of uniqueContactIds) {
          try {
            const raw = await this.api.getContactById(cid, [...CONTACT_PROPERTIES]);
            contacts.push(mapHubSpotContact(raw, companyId));
            contactDbIds.push(salesContactDbId(companyId, cid));
            fetchedContactHsIds.add(cid);
          } catch (err) {
            batchWarnings.push(`[${classifyHubSpotError(err)}] Failed to fetch contact ${cid} for deal ${rawDeal.id}: ${err}`);
          }
        }
      } catch (err) {
        batchWarnings.push(`[${classifyHubSpotError(err)}] Failed to discover contacts for deal ${rawDeal.id}: ${err}`);
      }

      // Fetch associated companies
      const companies: Array<ReturnType<typeof mapHubSpotCompany>> = [];
      const companyDbIds: string[] = [];
      try {
        const companyAssocs = await this.api.getAssociations("deals", rawDeal.id, "companies");
        const uniqueCompanyIds = [...new Set(companyAssocs.map((a) => a.toObjectId))];
        for (const coid of uniqueCompanyIds) {
          try {
            const raw = await this.api.getCompanyById(coid, [...COMPANY_PROPERTIES]);
            companies.push(mapHubSpotCompany(raw, companyId));
            companyDbIds.push(salesHubspotCompanyDbId(companyId, coid));
          } catch (err) {
            batchWarnings.push(`[${classifyHubSpotError(err)}] Failed to fetch company ${coid} for deal ${rawDeal.id}: ${err}`);
          }
        }
      } catch (err) {
        batchWarnings.push(`[${classifyHubSpotError(err)}] Failed to discover companies for deal ${rawDeal.id}: ${err}`);
      }

      // Fetch associated activities (all engagement types)
      const activities: Array<ReturnType<typeof mapHubSpotActivity>> = [];
      const engagementContacts: Array<ReturnType<typeof mapHubSpotContact>> = [];
      for (const engType of ENGAGEMENT_TYPES) {
        try {
          const assocType = ASSOCIATION_TYPE_MAP[engType];
          const engAssocs = await this.api.getAssociations("deals", rawDeal.id, assocType);
          const uniqueEngIds = [...new Set(engAssocs.map((a) => a.toObjectId))];
          for (const engId of uniqueEngIds) {
            try {
              const raw = await this.api.getEngagementById(engType, engId, [...ENGAGEMENT_PROPERTIES_BY_TYPE[engType]]);

              // Resolve contactId from authoritative engagement-contact association.
              // Only set contactId if the contact was successfully fetched in this
              // batch (i.e. it will be persisted in the same transaction). Otherwise
              // the FK would point to a non-existent row and roll back the transaction.
              let engContactId: string | null = null;
              try {
                const engContactAssocs = await this.api.getAssociations(assocType, engId, "contacts");
                if (engContactAssocs.length > 0) {
                  const firstContactHsId = engContactAssocs[0].toObjectId;
                  if (fetchedContactHsIds.has(firstContactHsId)) {
                    engContactId = salesContactDbId(companyId, firstContactHsId);
                  } else {
                    // Contact exists in HubSpot but wasn't fetched via deal-contact path.
                    // Fetch and persist it so the FK is safe. Goes into engagementContacts
                    // (upserted without a deal-contact link since the association is
                    // engagement→contact, not deal→contact).
                    try {
                      const contactRaw = await this.api.getContactById(firstContactHsId, [...CONTACT_PROPERTIES]);
                      engagementContacts.push(mapHubSpotContact(contactRaw, companyId));
                      fetchedContactHsIds.add(firstContactHsId);
                      engContactId = salesContactDbId(companyId, firstContactHsId);
                    } catch {
                      // Contact fetch failed — leave contactId null (warning-only)
                      batchWarnings.push(
                        `Failed to fetch engagement-contact ${firstContactHsId} for ${engType} ${engId}: contact not persisted, leaving contactId null`
                      );
                    }
                  }
                }
              } catch {
                // Warning-only: engagement-contact association discovery failed
                batchWarnings.push(
                  `Failed to discover contacts for ${engType} ${engId}: engagement-contact lookup failed`
                );
              }

              const rawTextExpiresAt = raw.properties
                ? (extractBodyPresent(engType, raw.properties) ? addDays(new Date(), RAW_TEXT_RETENTION_DAYS) : null)
                : null;

              activities.push(mapHubSpotActivity(raw, companyId, engType, dealDbId, engContactId, rawTextExpiresAt));
            } catch (err) {
              batchWarnings.push(`[${classifyHubSpotError(err)}] Failed to fetch ${engType} ${engId} for deal ${rawDeal.id}: ${err}`);
            }
          }
        } catch (err) {
          batchWarnings.push(`[${classifyHubSpotError(err)}] Failed to discover ${engType}s for deal ${rawDeal.id}: ${err}`);
        }
      }

      dealData.push({ deal: mapped, contacts, companies, activities, engagementContacts, contactDbIds, companyDbIds });
    }

    // Persist everything in a single transaction
    await this.repos.transaction(async (tx) => {
      for (const dd of dealData) {
        await this.repos.upsertDeal(dd.deal, tx);
        batchCounters.deals++;

        for (let i = 0; i < dd.contacts.length; i++) {
          await this.repos.upsertContact(dd.contacts[i], tx);
          batchCounters.contacts++;
          const dealDbId = salesDealDbId(dd.deal.companyId, dd.deal.hubspotDealId);
          await this.repos.linkDealContact(dealDbId, dd.contactDbIds[i], tx);
          batchCounters.associations++;
        }

        for (let i = 0; i < dd.companies.length; i++) {
          await this.repos.upsertHubspotCompany(dd.companies[i], tx);
          batchCounters.companies++;
          const dealDbId = salesDealDbId(dd.deal.companyId, dd.deal.hubspotDealId);
          await this.repos.linkDealCompany(dealDbId, dd.companyDbIds[i], tx);
          batchCounters.associations++;
        }

        // Upsert contacts discovered via engagement-contact path (no deal link)
        for (const ec of dd.engagementContacts) {
          await this.repos.upsertContact(ec, tx);
          batchCounters.contacts++;
        }

        for (const act of dd.activities) {
          await this.repos.upsertActivity(act, tx);
          batchCounters.activities++;
        }
      }
    });

    return { counters: batchCounters, warnings: batchWarnings };
  }

  // ---- Helpers ----

  private maxUpdatedAt(deals: RawHubSpotObject[]): string | null {
    let max: string | null = null;
    for (const d of deals) {
      const ts = d.properties.hs_lastmodifieddate ?? d.updatedAt;
      if (ts && (!max || ts > max)) max = ts;
    }
    return max;
  }
}

function extractBodyPresent(type: EngagementType, properties: Record<string, string | null>): boolean {
  const bodyKey: Record<EngagementType, string> = {
    email: "hs_email_text",
    note: "hs_note_body",
    call: "hs_call_body",
    meeting: "hs_meeting_body",
  };
  const val = properties[bodyKey[type]];
  return val != null && val !== "";
}
