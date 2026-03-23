import { differenceInDays } from "date-fns";
import type { EngagementType } from "../domain/types.js";

// ---------------------------------------------------------------------------
// HubSpot property lists — enumerate which properties to request per object
// ---------------------------------------------------------------------------

export const DEAL_PROPERTIES = [
  "dealname",
  "dealstage",
  "pipeline",
  "amount",
  "hubspot_owner_id",
  "closedate",
  "createdate",
  "notes_last_updated",
  "hs_lastmodifieddate",
  "hs_object_id",
] as const;

export const CONTACT_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "jobtitle",
  "company",
  "lifecyclestage",
  "lastmodifieddate",
] as const;

export const COMPANY_PROPERTIES = [
  "name",
  "domain",
  "industry",
  "numberofemployees",
] as const;

export const ENGAGEMENT_PROPERTIES_BY_TYPE: Record<EngagementType, readonly string[]> = {
  email: ["hs_email_text", "hs_email_html", "hs_email_subject", "hs_timestamp", "hs_lastmodifieddate"],
  note: ["hs_note_body", "hs_timestamp", "hs_lastmodifieddate"],
  call: ["hs_call_body", "hs_call_title", "hs_call_duration", "hs_timestamp", "hs_lastmodifieddate"],
  meeting: ["hs_meeting_body", "hs_meeting_title", "hs_timestamp", "hs_lastmodifieddate"],
};

// ---------------------------------------------------------------------------
// Raw HubSpot object shape (minimal contract for mappers)
// ---------------------------------------------------------------------------

export interface RawHubSpotObject {
  id: string;
  properties: Record<string, string | null>;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Pure mapping functions
// ---------------------------------------------------------------------------

export function mapHubSpotDeal(
  raw: RawHubSpotObject,
  companyId: string,
  pipelineId: string
) {
  const lastActivityDate = parseLastActivityDate(raw.properties);
  const now = new Date();
  return {
    companyId,
    hubspotDealId: raw.id,
    dealName: raw.properties.dealname ?? "Untitled Deal",
    pipeline: pipelineId,
    stage: raw.properties.dealstage ?? "unknown",
    amount: parseAmount(raw.properties.amount),
    ownerEmail: null as string | null,
    hubspotOwnerId: raw.properties.hubspot_owner_id ?? null,
    lastActivityDate,
    closeDateExpected: parseDate(raw.properties.closedate),
    propertiesJson: { ...raw.properties } as Record<string, unknown>,
    staleDays: computeStaleDays(lastActivityDate, now),
  };
}

export function mapHubSpotContact(
  raw: RawHubSpotObject,
  companyId: string
) {
  return {
    companyId,
    hubspotContactId: raw.id,
    email: raw.properties.email ?? null,
    firstName: raw.properties.firstname ?? null,
    lastName: raw.properties.lastname ?? null,
    title: raw.properties.jobtitle ?? null,
    company: raw.properties.company ?? null,
    propertiesJson: { ...raw.properties } as Record<string, unknown>,
  };
}

export function mapHubSpotCompany(
  raw: RawHubSpotObject,
  companyId: string
) {
  return {
    companyId,
    hubspotCompanyId: raw.id,
    name: raw.properties.name ?? "Unknown Company",
    domain: raw.properties.domain ?? null,
    industry: raw.properties.industry ?? null,
    size: raw.properties.numberofemployees ?? null,
    propertiesJson: { ...raw.properties } as Record<string, unknown>,
  };
}

export function mapHubSpotActivity(
  raw: RawHubSpotObject,
  companyId: string,
  type: EngagementType,
  dealId: string | null,
  contactId: string | null,
  rawTextExpiresAt: Date | null
) {
  return {
    companyId,
    hubspotEngagementId: raw.id,
    type,
    body: extractEngagementBody(type, raw.properties),
    timestamp: parseTimestamp(raw.properties),
    dealId,
    contactId,
    rawTextExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// Staleness computation
// ---------------------------------------------------------------------------

export function computeStaleDays(
  lastActivityDate: Date | null,
  now: Date = new Date()
): number {
  if (!lastActivityDate) return 9999;
  const days = differenceInDays(now, lastActivityDate);
  return Math.max(0, days);
}

// ---------------------------------------------------------------------------
// Engagement body extraction
// ---------------------------------------------------------------------------

export function extractEngagementBody(
  type: EngagementType,
  properties: Record<string, string | null>
): string | null {
  switch (type) {
    case "email":
      return properties.hs_email_text ?? null;
    case "note":
      return properties.hs_note_body ?? null;
    case "call":
      return properties.hs_call_body ?? null;
    case "meeting":
      return properties.hs_meeting_body ?? null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = parseFloat(raw);
  return Number.isNaN(n) ? null : n;
}

function parseDate(raw: string | null | undefined): Date | null {
  if (raw == null || raw === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseLastActivityDate(
  properties: Record<string, string | null>
): Date | null {
  const candidates = [
    parseDate(properties.notes_last_updated),
    parseDate(properties.hs_lastmodifieddate),
  ].filter((d): d is Date => d !== null);

  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.getTime() > b.getTime() ? a : b));
}

function parseTimestamp(
  properties: Record<string, string | null>
): Date {
  const d = parseDate(properties.hs_timestamp) ?? parseDate(properties.hs_lastmodifieddate);
  return d ?? new Date();
}
