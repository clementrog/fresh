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

class RateLimiter {
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
        const is429 =
          error instanceof Error && "statusCode" in error && (error as { statusCode: number }).statusCode === 429;
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
            batchWarnings.push(`Failed to fetch contact ${cid} for deal ${rawDeal.id}: ${err}`);
          }
        }
      } catch (err) {
        batchWarnings.push(`Failed to discover contacts for deal ${rawDeal.id}: ${err}`);
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
            batchWarnings.push(`Failed to fetch company ${coid} for deal ${rawDeal.id}: ${err}`);
          }
        }
      } catch (err) {
        batchWarnings.push(`Failed to discover companies for deal ${rawDeal.id}: ${err}`);
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
              batchWarnings.push(`Failed to fetch ${engType} ${engId} for deal ${rawDeal.id}: ${err}`);
            }
          }
        } catch (err) {
          batchWarnings.push(`Failed to discover ${engType}s for deal ${rawDeal.id}: ${err}`);
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
