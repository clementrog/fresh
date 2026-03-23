import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it, afterAll } from "vitest";

import { SalesRepositoryBundle, salesDealDbId, salesSignalDbId, salesRecommendationDbId } from "../src/sales/db/sales-repositories.js";
import { SalesApp } from "../src/sales/app.js";

// ── Skip gate ────────────────────────────────────────────────────────────────
let dbReachable = false;
if (process.env.DATABASE_URL) {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    // DB unreachable
  } finally {
    await probe.$disconnect().catch(() => {});
  }
}

const integrationRequired = process.env.INTEGRATION === "1";

if (!dbReachable && integrationRequired) {
  describe("sales repositories integration", () => {
    it("requires a reachable Postgres database", () => {
      expect.fail(
        "INTEGRATION=1 is set but Postgres is not reachable. " +
          "Ensure DATABASE_URL points to a running database."
      );
    });
  });
}

describe.skipIf(!dbReachable)("sales repositories integration", () => {
  const prisma = new PrismaClient();
  const repos = new SalesRepositoryBundle(prisma);
  const suffix = randomUUID();

  const companyId = `company_sales_${suffix}`;
  const companySlug = `test-sales-${suffix}`;

  // Second company for isolation tests
  const companyId2 = `company_sales2_${suffix}`;
  const companySlug2 = `test-sales2-${suffix}`;

  afterAll(async () => {
    try {
      for (const cid of [companyId, companyId2]) {
        await prisma.recommendationAction.deleteMany({ where: { recommendation: { companyId: cid } } });
        await prisma.recommendationEvidence.deleteMany({ where: { recommendation: { companyId: cid } } });
        await prisma.salesDraft.deleteMany({ where: { companyId: cid } });
        await prisma.salesRecommendation.deleteMany({ where: { companyId: cid } });
        await prisma.salesExtractedFact.deleteMany({ where: { companyId: cid } });
        await prisma.salesSignal.deleteMany({ where: { companyId: cid } });
        await prisma.salesActivity.deleteMany({ where: { companyId: cid } });
        await prisma.dealContact.deleteMany({ where: { deal: { companyId: cid } } });
        await prisma.dealCompany.deleteMany({ where: { deal: { companyId: cid } } });
        await prisma.salesDeal.deleteMany({ where: { companyId: cid } });
        await prisma.salesContact.deleteMany({ where: { companyId: cid } });
        await prisma.salesHubspotCompany.deleteMany({ where: { companyId: cid } });
        await prisma.salesDoctrine.deleteMany({ where: { companyId: cid } });
        await prisma.syncRun.deleteMany({ where: { companyId: cid } });
        await prisma.sourceCursor.deleteMany({ where: { companyId: cid } });
        await prisma.company.deleteMany({ where: { id: cid } });
      }
    } catch {
      // best effort
    } finally {
      await prisma.$disconnect();
    }
  });

  it("creates companies for the tests", async () => {
    await prisma.company.create({
      data: { id: companyId, slug: companySlug, name: "Sales Test Co", defaultTimezone: "UTC" }
    });
    await prisma.company.create({
      data: { id: companyId2, slug: companySlug2, name: "Sales Test Co 2", defaultTimezone: "Europe/Paris" }
    });
  });

  // ── Core CRUD ─────────────────────────────────────────────────────────────

  it("upserts a deal and retrieves it by company-scoped lookup", async () => {
    const deal = await repos.upsertDeal({
      companyId,
      hubspotDealId: "hs-deal-100",
      dealName: "Acme Corp Enterprise",
      pipeline: "default",
      stage: "Negotiation",
      amount: 45000,
      ownerEmail: "rep@example.com",
      hubspotOwnerId: "owner-1",
      lastActivityDate: new Date("2026-03-01"),
      closeDateExpected: new Date("2026-06-01"),
      propertiesJson: { custom_field: "value" },
      staleDays: 22
    });

    expect(deal.id).toBe(salesDealDbId(companyId, "hs-deal-100"));
    expect(deal.dealName).toBe("Acme Corp Enterprise");

    const found = await repos.getDealByHubspotId(companyId, "hs-deal-100");
    expect(found).not.toBeNull();
    expect(found!.dealName).toBe("Acme Corp Enterprise");
  });

  it("upsert is idempotent — same deal twice produces one row", async () => {
    const params = {
      companyId,
      hubspotDealId: "hs-deal-idem",
      dealName: "Idempotency Test",
      pipeline: "default",
      stage: "Discovery",
      amount: 10000,
      ownerEmail: null,
      hubspotOwnerId: null,
      lastActivityDate: null,
      closeDateExpected: null,
      propertiesJson: {},
      staleDays: 0
    };

    await repos.upsertDeal(params);
    await repos.upsertDeal({ ...params, dealName: "Idempotency Test Updated" });

    const found = await repos.getDealByHubspotId(companyId, "hs-deal-idem");
    expect(found!.dealName).toBe("Idempotency Test Updated");

    const all = await repos.listDeals(companyId);
    const matching = all.filter(d => d.hubspotDealId === "hs-deal-idem");
    expect(matching).toHaveLength(1);
  });

  it("creates a signal", async () => {
    const signalId = salesSignalDbId(companyId, ["feature_shipped", "sso", suffix]);
    const deal = await repos.getDealByHubspotId(companyId, "hs-deal-100");

    await repos.createSignal({
      id: signalId,
      companyId,
      signalType: "feature_shipped",
      title: "SSO support shipped",
      description: "v2.3 shipped with SSO support",
      sourceItemId: null,
      dealId: deal!.id,
      confidence: "high",
      metadataJson: { version: "2.3" },
      detectedAt: new Date("2026-03-12")
    });

    const signals = await repos.listRecentSignals(companyId, 10);
    expect(signals.some(s => s.id === signalId)).toBe(true);
  });

  it("creates a recommendation with deal and signal FKs", async () => {
    const deal = await repos.getDealByHubspotId(companyId, "hs-deal-100");
    const signals = await repos.listRecentSignals(companyId, 10);
    const signal = signals[0];

    const recId = salesRecommendationDbId(companyId, deal!.id, signal.id);

    await repos.createRecommendation({
      id: recId,
      companyId,
      dealId: deal!.id,
      signalId: signal.id,
      userId: null,
      whyNow: "SSO blocker was resolved, deal has been stale for 22 days",
      recommendedAngle: "Re-engage around resolved SSO blocker with compliance proof",
      nextStepType: "email_follow_up",
      matchedContextJson: { extracted_fact: "SSO blocker" },
      confidence: "high",
      priorityRank: 0.92
    });

    const rec = await repos.getRecommendation(recId);
    expect(rec).not.toBeNull();
    expect(rec!.whyNow).toContain("SSO blocker");
    expect(rec!.deal.dealName).toBe("Acme Corp Enterprise");
    expect(rec!.signal.signalType).toBe("feature_shipped");
    expect(rec!.status).toBe("new");
  });

  it("tracks recommendation actions as discrete events", async () => {
    const deal = await repos.getDealByHubspotId(companyId, "hs-deal-100");
    const signals = await repos.listRecentSignals(companyId, 10);
    const recId = salesRecommendationDbId(companyId, deal!.id, signals[0].id);

    await repos.createAction({ recommendationId: recId, userId: null, actionType: "surfaced", reason: null });
    await repos.createAction({ recommendationId: recId, userId: null, actionType: "opened", reason: null });
    await repos.createAction({ recommendationId: recId, userId: null, actionType: "detail_viewed", reason: null });
    await repos.createAction({ recommendationId: recId, userId: null, actionType: "dismissed", reason: "not_relevant" });

    const rec = await repos.getRecommendation(recId);
    expect(rec!.actions).toHaveLength(4);
    const types = rec!.actions.map(a => a.actionType);
    expect(types).toContain("surfaced");
    expect(types).toContain("opened");
    expect(types).toContain("detail_viewed");
    expect(types).toContain("dismissed");
  });

  it("updates recommendation status", async () => {
    const deal = await repos.getDealByHubspotId(companyId, "hs-deal-100");
    const signals = await repos.listRecentSignals(companyId, 10);
    const recId = salesRecommendationDbId(companyId, deal!.id, signals[0].id);

    await repos.updateRecommendationStatus(recId, "dismissed", { dismissReason: "not_relevant" });
    const rec = await repos.getRecommendation(recId);
    expect(rec!.status).toBe("dismissed");
    expect(rec!.dismissReason).toBe("not_relevant");
  });

  it("upserts and retrieves doctrine", async () => {
    await repos.upsertDoctrine(companyId, 1, {
      hubspotPipelineId: "default",
      recommendationGenerationEnabled: true,
      stalenessThresholdDays: 21,
      minConfidenceToSurface: "medium",
      maxRecsPerDealPerWeek: 1,
      maxRecsPerUserPerDay: 10,
      dismissCooldownDays: 14,
      meetingSuppressionDays: 3,
      positioningRules: ["Lead with time-to-value"],
      followUpRules: ["Never send generic checking-in"],
      proofHierarchy: ["Customer quotes outrank blog posts"],
      personaGuidance: ["For CFOs, lead with ROI"],
      exclusionRules: {
        excludedDealIds: [],
        excludedStages: ["Closed Lost"],
        minDealValue: 5000,
        lostDealCooldownDays: 60
      },
      framingRules: ["Do not mention competitors by name"]
    });

    const doctrine = await repos.getLatestDoctrine(companyId);
    expect(doctrine).not.toBeNull();
    expect(doctrine!.version).toBe(1);
    const json = doctrine!.doctrineJson as Record<string, unknown>;
    expect(json.stalenessThresholdDays).toBe(21);
  });

  it("creates and retrieves a sync run", async () => {
    const run = await repos.createSyncRun({ companyId, runType: "sales:sync", source: "hubspot" });
    expect(run.status).toBe("running");

    await repos.finalizeSyncRun(run.id, "completed", { deals_synced: 5, contacts_synced: 12 });
    const updated = await prisma.syncRun.findUnique({ where: { id: run.id } });
    expect(updated!.status).toBe("completed");
    const counters = updated!.countersJson as Record<string, number>;
    expect(counters.deals_synced).toBe(5);
  });

  it("manages cursors for incremental sync", async () => {
    const cursor = await repos.getCursor(companyId, "hubspot-deals");
    expect(cursor).toBeNull();

    await repos.setCursor(companyId, "hubspot-deals", "2026-03-20T12:00:00Z");
    const updated = await repos.getCursor(companyId, "hubspot-deals");
    expect(updated).toBe("2026-03-20T12:00:00Z");

    await repos.setCursor(companyId, "hubspot-deals", "2026-03-21T12:00:00Z");
    const advanced = await repos.getCursor(companyId, "hubspot-deals");
    expect(advanced).toBe("2026-03-21T12:00:00Z");
  });

  it("creates an activity and cleans up raw text", async () => {
    const deal = await repos.getDealByHubspotId(companyId, "hs-deal-100");
    const past = new Date("2026-01-01");

    await repos.upsertActivity({
      companyId,
      hubspotEngagementId: "hs-eng-100",
      type: "note",
      body: "Customer mentioned SSO is a blocker for their security team",
      timestamp: new Date("2026-02-15"),
      dealId: deal!.id,
      contactId: null,
      rawTextExpiresAt: past
    });

    const unextracted = await repos.listUnextractedActivities(companyId);
    expect(unextracted.some(a => a.hubspotEngagementId === "hs-eng-100")).toBe(true);

    const activity = unextracted.find(a => a.hubspotEngagementId === "hs-eng-100")!;
    await repos.markActivityExtracted(activity.id);

    const candidates = await repos.listCleanupCandidateActivities(new Date());
    expect(candidates.find(c => c.id === activity.id)).toBeTruthy();

    await repos.cleanupActivityRawText(activity.id);
    const cleaned = await prisma.salesActivity.findUnique({ where: { id: activity.id } });
    expect(cleaned!.body).toBeNull();
    expect(cleaned!.rawTextCleaned).toBe(true);
  });

  it("creates extracted facts for a deal", async () => {
    const deal = await repos.getDealByHubspotId(companyId, "hs-deal-100");

    await repos.createExtractedFact({
      id: `sef-test-${suffix}`,
      companyId,
      activityId: null,
      dealId: deal!.id,
      category: "objection_mentioned",
      label: "SSO blocker",
      extractedValue: "Security team requires SSO before signing",
      confidence: 0.85,
      sourceText: "Customer mentioned SSO is a blocker..."
    });

    const facts = await repos.listExtractionsForDeal(deal!.id);
    expect(facts).toHaveLength(1);
    expect(facts[0].category).toBe("objection_mentioned");
  });

  // ── Multi-tenant isolation ────────────────────────────────────────────────

  it("two companies with the same HubSpot external IDs stay isolated", async () => {
    // Company 1 already has hs-deal-100 from earlier tests.
    // Now create the same external ID in company 2.
    await repos.upsertDeal({
      companyId: companyId2,
      hubspotDealId: "hs-deal-100",
      dealName: "Beta Inc (different company)",
      pipeline: "default",
      stage: "Discovery",
      amount: 9000,
      ownerEmail: null,
      hubspotOwnerId: null,
      lastActivityDate: null,
      closeDateExpected: null,
      propertiesJson: {},
      staleDays: 5
    });

    // Company 1 deal unchanged
    const c1Deal = await repos.getDealByHubspotId(companyId, "hs-deal-100");
    expect(c1Deal!.dealName).toBe("Acme Corp Enterprise");
    expect(c1Deal!.amount).toBe(45000);

    // Company 2 deal has its own data
    const c2Deal = await repos.getDealByHubspotId(companyId2, "hs-deal-100");
    expect(c2Deal!.dealName).toBe("Beta Inc (different company)");
    expect(c2Deal!.amount).toBe(9000);

    // Different internal IDs
    expect(c1Deal!.id).not.toBe(c2Deal!.id);

    // Same for contacts
    await repos.upsertContact({
      companyId,
      hubspotContactId: "hs-contact-shared",
      email: "alice@acme.com",
      firstName: "Alice",
      lastName: "Acme",
      title: "CTO",
      company: "Acme",
      propertiesJson: {}
    });
    await repos.upsertContact({
      companyId: companyId2,
      hubspotContactId: "hs-contact-shared",
      email: "alice@beta.com",
      firstName: "Alice",
      lastName: "Beta",
      title: "CEO",
      company: "Beta",
      propertiesJson: {}
    });

    const c1Contacts = await prisma.salesContact.findMany({ where: { companyId, hubspotContactId: "hs-contact-shared" } });
    const c2Contacts = await prisma.salesContact.findMany({ where: { companyId: companyId2, hubspotContactId: "hs-contact-shared" } });
    expect(c1Contacts).toHaveLength(1);
    expect(c2Contacts).toHaveLength(1);
    expect(c1Contacts[0].email).toBe("alice@acme.com");
    expect(c2Contacts[0].email).toBe("alice@beta.com");
    expect(c1Contacts[0].id).not.toBe(c2Contacts[0].id);

    // Same for HubSpot companies
    await repos.upsertHubspotCompany({
      companyId,
      hubspotCompanyId: "hs-co-shared",
      name: "Acme HubSpot Co",
      domain: "acme.com",
      industry: "SaaS",
      size: "50",
      propertiesJson: {}
    });
    await repos.upsertHubspotCompany({
      companyId: companyId2,
      hubspotCompanyId: "hs-co-shared",
      name: "Beta HubSpot Co",
      domain: "beta.com",
      industry: "Fintech",
      size: "200",
      propertiesJson: {}
    });

    const c1Cos = await prisma.salesHubspotCompany.findMany({ where: { companyId, hubspotCompanyId: "hs-co-shared" } });
    const c2Cos = await prisma.salesHubspotCompany.findMany({ where: { companyId: companyId2, hubspotCompanyId: "hs-co-shared" } });
    expect(c1Cos).toHaveLength(1);
    expect(c2Cos).toHaveLength(1);
    expect(c1Cos[0].name).toBe("Acme HubSpot Co");
    expect(c2Cos[0].name).toBe("Beta HubSpot Co");

    // Same for activities
    await repos.upsertActivity({
      companyId,
      hubspotEngagementId: "hs-eng-shared",
      type: "note",
      body: "Acme note",
      timestamp: new Date("2026-03-01"),
      dealId: c1Deal!.id,
      contactId: null,
      rawTextExpiresAt: null
    });
    await repos.upsertActivity({
      companyId: companyId2,
      hubspotEngagementId: "hs-eng-shared",
      type: "email",
      body: "Beta email",
      timestamp: new Date("2026-03-02"),
      dealId: c2Deal!.id,
      contactId: null,
      rawTextExpiresAt: null
    });

    const c1Acts = await prisma.salesActivity.findMany({ where: { companyId, hubspotEngagementId: "hs-eng-shared" } });
    const c2Acts = await prisma.salesActivity.findMany({ where: { companyId: companyId2, hubspotEngagementId: "hs-eng-shared" } });
    expect(c1Acts).toHaveLength(1);
    expect(c2Acts).toHaveLength(1);
    expect(c1Acts[0].body).toBe("Acme note");
    expect(c2Acts[0].body).toBe("Beta email");
  });

  // ── Deal-company linking ──────────────────────────────────────────────────

  it("links a deal to a HubSpot company using the internal row ID", async () => {
    const deal = await repos.getDealByHubspotId(companyId, "hs-deal-100");
    const hsCo = await prisma.salesHubspotCompany.findFirst({
      where: { companyId, hubspotCompanyId: "hs-co-shared" }
    });

    // linkDealCompany takes the internal SalesHubspotCompany.id, not the external hubspotCompanyId
    await repos.linkDealCompany(deal!.id, hsCo!.id);

    // Verify the link exists and references the right company
    const links = await prisma.dealCompany.findMany({ where: { dealId: deal!.id } });
    expect(links).toHaveLength(1);
    expect(links[0].salesCompanyId).toBe(hsCo!.id);

    // Verify the relation works
    const dealWithCos = await prisma.salesDeal.findUnique({
      where: { id: deal!.id },
      include: { companies: { include: { company: true } } }
    });
    expect(dealWithCos!.companies).toHaveLength(1);
    expect(dealWithCos!.companies[0].company.name).toBe("Acme HubSpot Co");
  });

  it("linkDealCompany is idempotent", async () => {
    const deal = await repos.getDealByHubspotId(companyId, "hs-deal-100");
    const hsCo = await prisma.salesHubspotCompany.findFirst({
      where: { companyId, hubspotCompanyId: "hs-co-shared" }
    });

    // Link again — should not throw or duplicate
    await repos.linkDealCompany(deal!.id, hsCo!.id);

    const links = await prisma.dealCompany.findMany({ where: { dealId: deal!.id } });
    expect(links).toHaveLength(1);
  });

  // ── checkConfig (env/config sanity — not external service reachability) ──

  it("checkConfig passes when DB, schema, HubSpot token, and LLM key are present", async () => {
    const app = new SalesApp(prisma, {
      DATABASE_URL: process.env.DATABASE_URL!,
      HUBSPOT_ACCESS_TOKEN: "pat-test-token",
      ANTHROPIC_API_KEY: "sk-ant-test",
      SALES_LLM_PROVIDER: "anthropic"
    } as any);

    const result = await app.checkConfig();
    expect(result.ok).toBe(true);
    expect(result.details.database).toBe("ok");
    expect(result.details.schema).toBe("ok");
    expect(result.details.hubspot).toContain("token present");
    expect(result.details.llm).toContain("key present");
  });

  it("checkConfig verifies Sales tables exist", async () => {
    // Uses the real prisma client which has the migrated schema
    const app = new SalesApp(prisma, {
      DATABASE_URL: process.env.DATABASE_URL!,
      HUBSPOT_ACCESS_TOKEN: "pat-test-token",
      ANTHROPIC_API_KEY: "sk-ant-test",
      SALES_LLM_PROVIDER: "anthropic"
    } as any);

    const result = await app.checkConfig();
    expect(result.details.schema).toBe("ok");
  });

  it("checkConfig fails when HUBSPOT_ACCESS_TOKEN is missing", async () => {
    const app = new SalesApp(prisma, {
      DATABASE_URL: process.env.DATABASE_URL!,
      HUBSPOT_ACCESS_TOKEN: "",
      ANTHROPIC_API_KEY: "sk-ant-test",
      SALES_LLM_PROVIDER: "anthropic"
    } as any);

    const result = await app.checkConfig();
    expect(result.ok).toBe(false);
    expect(result.details.hubspot).toContain("not set");
    // Schema was checked before HubSpot token — database and schema are ok
    expect(result.details.database).toBe("ok");
    expect(result.details.schema).toBe("ok");
  });

  it("checkConfig fails when LLM key is missing for configured provider", async () => {
    const app = new SalesApp(prisma, {
      DATABASE_URL: process.env.DATABASE_URL!,
      HUBSPOT_ACCESS_TOKEN: "pat-test-token",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      SALES_LLM_PROVIDER: "anthropic"
    } as any);

    const result = await app.checkConfig();
    expect(result.ok).toBe(false);
    expect(result.details.llm).toContain("API key not set");
  });

  it("checkConfig validates openai key when SALES_LLM_PROVIDER is openai", async () => {
    const appMissing = new SalesApp(prisma, {
      DATABASE_URL: process.env.DATABASE_URL!,
      HUBSPOT_ACCESS_TOKEN: "pat-test-token",
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "",
      SALES_LLM_PROVIDER: "openai"
    } as any);

    const missing = await appMissing.checkConfig();
    expect(missing.ok).toBe(false);
    expect(missing.details.llm).toContain("openai");

    const appPresent = new SalesApp(prisma, {
      DATABASE_URL: process.env.DATABASE_URL!,
      HUBSPOT_ACCESS_TOKEN: "pat-test-token",
      OPENAI_API_KEY: "sk-test",
      SALES_LLM_PROVIDER: "openai"
    } as any);

    const present = await appPresent.checkConfig();
    expect(present.ok).toBe(true);
    expect(present.details.llm).toContain("openai");
  });

  it("checkConfig does not call any external API (token is not validated)", async () => {
    // A bogus token passes checkConfig — it only checks presence, not validity.
    // External validation is deferred to sales:preflight (Slice 2).
    const app = new SalesApp(prisma, {
      DATABASE_URL: process.env.DATABASE_URL!,
      HUBSPOT_ACCESS_TOKEN: "this-is-not-a-real-token",
      ANTHROPIC_API_KEY: "also-not-real",
      SALES_LLM_PROVIDER: "anthropic"
    } as any);

    const result = await app.checkConfig();
    expect(result.ok).toBe(true);
    expect(result.details.hubspot).toContain("not validated");
  });
});
