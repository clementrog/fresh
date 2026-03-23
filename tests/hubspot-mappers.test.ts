import { describe, expect, it } from "vitest";
import {
  mapHubSpotDeal,
  mapHubSpotContact,
  mapHubSpotCompany,
  mapHubSpotActivity,
  computeStaleDays,
  extractEngagementBody,
  type RawHubSpotObject,
} from "../src/sales/connectors/hubspot-mappers.js";

// ---------------------------------------------------------------------------
// mapHubSpotDeal
// ---------------------------------------------------------------------------

describe("mapHubSpotDeal", () => {
  const base: RawHubSpotObject = {
    id: "hs-deal-1",
    properties: {
      dealname: "Acme Corp",
      dealstage: "negotiation",
      pipeline: "default",
      amount: "45000",
      hubspot_owner_id: "owner-1",
      closedate: "2026-06-01T00:00:00.000Z",
      notes_last_updated: "2026-03-10T10:00:00.000Z",
      hs_lastmodifieddate: "2026-03-15T12:00:00.000Z",
    },
  };

  it("maps all fields from raw deal properties", () => {
    const result = mapHubSpotDeal(base, "comp-1", "pipeline-1");
    expect(result.companyId).toBe("comp-1");
    expect(result.hubspotDealId).toBe("hs-deal-1");
    expect(result.dealName).toBe("Acme Corp");
    expect(result.pipeline).toBe("pipeline-1");
    expect(result.stage).toBe("negotiation");
    expect(result.amount).toBe(45000);
    expect(result.hubspotOwnerId).toBe("owner-1");
    expect(result.ownerEmail).toBeNull();
    expect(result.closeDateExpected).toEqual(new Date("2026-06-01T00:00:00.000Z"));
    expect(result.lastActivityDate).toEqual(new Date("2026-03-15T12:00:00.000Z"));
  });

  it("returns null amount when amount is empty", () => {
    const raw = { ...base, properties: { ...base.properties, amount: "" } };
    expect(mapHubSpotDeal(raw, "c", "p").amount).toBeNull();
  });

  it("returns null amount when amount is NaN", () => {
    const raw = { ...base, properties: { ...base.properties, amount: "not-a-number" } };
    expect(mapHubSpotDeal(raw, "c", "p").amount).toBeNull();
  });

  it("returns null amount when amount is missing", () => {
    const raw = { ...base, properties: { ...base.properties, amount: null } };
    expect(mapHubSpotDeal(raw, "c", "p").amount).toBeNull();
  });

  it("computes staleDays from lastActivityDate", () => {
    const result = mapHubSpotDeal(base, "c", "p");
    expect(result.staleDays).toBeGreaterThan(0);
    expect(typeof result.staleDays).toBe("number");
  });

  it("falls back to 'Untitled Deal' when dealname is missing", () => {
    const raw = { ...base, properties: { ...base.properties, dealname: null } };
    expect(mapHubSpotDeal(raw, "c", "p").dealName).toBe("Untitled Deal");
  });

  it("falls back to 'unknown' when dealstage is missing", () => {
    const raw = { ...base, properties: { ...base.properties, dealstage: null } };
    expect(mapHubSpotDeal(raw, "c", "p").stage).toBe("unknown");
  });

  it("picks most recent of notes_last_updated and hs_lastmodifieddate", () => {
    const raw = {
      ...base,
      properties: {
        ...base.properties,
        notes_last_updated: "2026-04-01T00:00:00.000Z",
        hs_lastmodifieddate: "2026-03-01T00:00:00.000Z",
      },
    };
    expect(mapHubSpotDeal(raw, "c", "p").lastActivityDate).toEqual(
      new Date("2026-04-01T00:00:00.000Z")
    );
  });

  it("stores raw properties in propertiesJson", () => {
    const result = mapHubSpotDeal(base, "c", "p");
    expect(result.propertiesJson).toHaveProperty("dealname", "Acme Corp");
  });
});

// ---------------------------------------------------------------------------
// mapHubSpotContact
// ---------------------------------------------------------------------------

describe("mapHubSpotContact", () => {
  const base: RawHubSpotObject = {
    id: "hs-contact-1",
    properties: {
      email: "alice@acme.com",
      firstname: "Alice",
      lastname: "Smith",
      jobtitle: "CTO",
      company: "Acme Corp",
    },
  };

  it("maps all contact fields", () => {
    const result = mapHubSpotContact(base, "comp-1");
    expect(result.companyId).toBe("comp-1");
    expect(result.hubspotContactId).toBe("hs-contact-1");
    expect(result.email).toBe("alice@acme.com");
    expect(result.firstName).toBe("Alice");
    expect(result.lastName).toBe("Smith");
    expect(result.title).toBe("CTO");
    expect(result.company).toBe("Acme Corp");
  });

  it("handles null email gracefully", () => {
    const raw = { ...base, properties: { ...base.properties, email: null } };
    expect(mapHubSpotContact(raw, "c").email).toBeNull();
  });

  it("stores full properties in propertiesJson", () => {
    const result = mapHubSpotContact(base, "c");
    expect(result.propertiesJson).toHaveProperty("email", "alice@acme.com");
  });
});

// ---------------------------------------------------------------------------
// mapHubSpotCompany
// ---------------------------------------------------------------------------

describe("mapHubSpotCompany", () => {
  const base: RawHubSpotObject = {
    id: "hs-co-1",
    properties: {
      name: "Acme Corp",
      domain: "acme.com",
      industry: "SaaS",
      numberofemployees: "50",
    },
  };

  it("maps all company fields", () => {
    const result = mapHubSpotCompany(base, "comp-1");
    expect(result.companyId).toBe("comp-1");
    expect(result.hubspotCompanyId).toBe("hs-co-1");
    expect(result.name).toBe("Acme Corp");
    expect(result.domain).toBe("acme.com");
    expect(result.industry).toBe("SaaS");
    expect(result.size).toBe("50");
  });

  it("falls back to 'Unknown Company' when name is missing", () => {
    const raw = { ...base, properties: { ...base.properties, name: null } };
    expect(mapHubSpotCompany(raw, "c").name).toBe("Unknown Company");
  });

  it("maps numberofemployees to size", () => {
    expect(mapHubSpotCompany(base, "c").size).toBe("50");
  });
});

// ---------------------------------------------------------------------------
// mapHubSpotActivity
// ---------------------------------------------------------------------------

describe("mapHubSpotActivity", () => {
  it("maps email engagement with hs_email_text body", () => {
    const raw: RawHubSpotObject = {
      id: "hs-eng-1",
      properties: {
        hs_email_text: "Hello, following up on our call.",
        hs_timestamp: "2026-03-10T10:00:00.000Z",
      },
    };
    const result = mapHubSpotActivity(raw, "c", "email", "deal-1", "contact-1", new Date("2026-04-10T00:00:00Z"));
    expect(result.body).toBe("Hello, following up on our call.");
    expect(result.type).toBe("email");
    expect(result.dealId).toBe("deal-1");
    expect(result.contactId).toBe("contact-1");
    expect(result.rawTextExpiresAt).toEqual(new Date("2026-04-10T00:00:00Z"));
  });

  it("maps note engagement with hs_note_body", () => {
    const raw: RawHubSpotObject = {
      id: "hs-eng-2",
      properties: { hs_note_body: "Discussed pricing.", hs_timestamp: "2026-03-10T10:00:00.000Z" },
    };
    expect(mapHubSpotActivity(raw, "c", "note", null, null, null).body).toBe("Discussed pricing.");
  });

  it("maps call engagement with hs_call_body", () => {
    const raw: RawHubSpotObject = {
      id: "hs-eng-3",
      properties: { hs_call_body: "Call notes here.", hs_timestamp: "2026-03-10T10:00:00.000Z" },
    };
    expect(mapHubSpotActivity(raw, "c", "call", null, null, null).body).toBe("Call notes here.");
  });

  it("maps meeting engagement with hs_meeting_body", () => {
    const raw: RawHubSpotObject = {
      id: "hs-eng-4",
      properties: { hs_meeting_body: "Meeting agenda.", hs_timestamp: "2026-03-10T10:00:00.000Z" },
    };
    expect(mapHubSpotActivity(raw, "c", "meeting", null, null, null).body).toBe("Meeting agenda.");
  });

  it("sets body to null when body property is missing", () => {
    const raw: RawHubSpotObject = {
      id: "hs-eng-5",
      properties: { hs_timestamp: "2026-03-10T10:00:00.000Z" },
    };
    expect(mapHubSpotActivity(raw, "c", "email", null, null, null).body).toBeNull();
  });

  it("passes through dealId and contactId as-is", () => {
    const raw: RawHubSpotObject = {
      id: "hs-eng-6",
      properties: { hs_timestamp: "2026-03-10T10:00:00.000Z" },
    };
    const result = mapHubSpotActivity(raw, "c", "email", "internal-deal-id", "internal-contact-id", null);
    expect(result.dealId).toBe("internal-deal-id");
    expect(result.contactId).toBe("internal-contact-id");
  });

  it("passes through rawTextExpiresAt", () => {
    const raw: RawHubSpotObject = {
      id: "hs-eng-7",
      properties: { hs_timestamp: "2026-03-10T10:00:00.000Z" },
    };
    const expires = new Date("2026-04-10T00:00:00Z");
    expect(mapHubSpotActivity(raw, "c", "email", null, null, expires).rawTextExpiresAt).toEqual(expires);
  });

  it("parses hs_timestamp to timestamp Date", () => {
    const raw: RawHubSpotObject = {
      id: "hs-eng-8",
      properties: { hs_timestamp: "2026-03-10T10:00:00.000Z" },
    };
    expect(mapHubSpotActivity(raw, "c", "email", null, null, null).timestamp).toEqual(
      new Date("2026-03-10T10:00:00.000Z")
    );
  });
});

// ---------------------------------------------------------------------------
// computeStaleDays
// ---------------------------------------------------------------------------

describe("computeStaleDays", () => {
  it("returns days since last activity", () => {
    const now = new Date("2026-03-23T00:00:00Z");
    const lastActivity = new Date("2026-03-13T00:00:00Z");
    expect(computeStaleDays(lastActivity, now)).toBe(10);
  });

  it("returns 0 when lastActivityDate is today", () => {
    const now = new Date("2026-03-23T12:00:00Z");
    const lastActivity = new Date("2026-03-23T06:00:00Z");
    expect(computeStaleDays(lastActivity, now)).toBe(0);
  });

  it("returns 9999 when lastActivityDate is null", () => {
    expect(computeStaleDays(null)).toBe(9999);
  });

  it("accepts custom 'now' parameter for deterministic testing", () => {
    const now = new Date("2026-04-02T00:00:00Z");
    const lastActivity = new Date("2026-03-23T00:00:00Z");
    expect(computeStaleDays(lastActivity, now)).toBe(10);
  });

  it("returns 0 for future lastActivityDate", () => {
    const now = new Date("2026-03-23T00:00:00Z");
    const lastActivity = new Date("2026-03-25T00:00:00Z");
    expect(computeStaleDays(lastActivity, now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extractEngagementBody
// ---------------------------------------------------------------------------

describe("extractEngagementBody", () => {
  it("returns hs_email_text for email type", () => {
    expect(extractEngagementBody("email", { hs_email_text: "body" })).toBe("body");
  });

  it("returns hs_note_body for note type", () => {
    expect(extractEngagementBody("note", { hs_note_body: "body" })).toBe("body");
  });

  it("returns hs_call_body for call type", () => {
    expect(extractEngagementBody("call", { hs_call_body: "body" })).toBe("body");
  });

  it("returns hs_meeting_body for meeting type", () => {
    expect(extractEngagementBody("meeting", { hs_meeting_body: "body" })).toBe("body");
  });

  it("returns null when property is null", () => {
    expect(extractEngagementBody("email", { hs_email_text: null })).toBeNull();
  });

  it("returns null when property is missing", () => {
    expect(extractEngagementBody("email", {})).toBeNull();
  });
});
