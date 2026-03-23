import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it, afterAll } from "vitest";

import { AdminQueries } from "../src/admin/queries.js";

// ── Skip gate ────────────────────────────────────────────────────────────────
// Probe the real database with SELECT 1.  Skips when DATABASE_URL is absent,
// empty, or points at an unreachable server.
//
// When INTEGRATION=1 is set (e.g. via `npm run test:integration`), the test
// MUST run — a hard-failing sentinel replaces the silent skip so an operator
// is never left wondering whether the Postgres path was actually exercised.

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
  describe("admin expansion integration", () => {
    it("requires a reachable Postgres database", () => {
      expect.fail(
        "INTEGRATION=1 is set but Postgres is not reachable. " +
          "Ensure DATABASE_URL points to a running database."
      );
    });
  });
}

describe.skipIf(!dbReachable)("admin expansion integration", () => {
  const prisma = new PrismaClient();
  const queries = new AdminQueries(prisma);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── Helper: create a company for a single test case ─────────────────────
  async function seedCompany(suffix: string) {
    const companyId = `company_${suffix}`;
    await prisma.company.create({
      data: {
        id: companyId,
        slug: `test-${suffix}`,
        name: `Test Company ${suffix}`,
        defaultTimezone: "UTC"
      }
    });
    return companyId;
  }

  async function cleanupCompany(companyId: string) {
    try {
      // Delete in FK order — drafts → opportunities → evidence → source items → configs → users → company
      await prisma.draft.deleteMany({ where: { companyId } });
      await prisma.opportunity.deleteMany({ where: { companyId } });
      await prisma.editorialConfig.deleteMany({ where: { companyId } });
      await prisma.user.deleteMany({ where: { companyId } });
      await prisma.sourceConfig.deleteMany({ where: { companyId } });
      await prisma.marketQuery.deleteMany({ where: { companyId } });
      await prisma.company.delete({ where: { id: companyId } });
    } catch {
      // Best-effort cleanup
    }
  }

  // ── listEditorialConfigs ──────────────────────────────────────────────────

  it("listEditorialConfigs returns only configs for seeded company ordered by version DESC", async () => {
    const suffix = randomUUID();
    const companyId = await seedCompany(suffix);

    try {
      // Seed two editorial configs
      await prisma.editorialConfig.create({
        data: {
          id: `ec_v1_${suffix}`,
          companyId,
          version: 1,
          layer1CompanyLens: { doctrineMarkdown: "v1 doctrine" },
          layer2ContentPhilosophy: { defaults: ["Specific"] },
          layer3LinkedInCraft: { defaults: ["Max 250 words"] }
        }
      });
      await prisma.editorialConfig.create({
        data: {
          id: `ec_v2_${suffix}`,
          companyId,
          version: 2,
          layer1CompanyLens: { doctrineMarkdown: "v2 doctrine" },
          layer2ContentPhilosophy: { defaults: ["Evidence-backed"] },
          layer3LinkedInCraft: { defaults: ["First person"] }
        }
      });

      const result = await queries.listEditorialConfigs(companyId);

      expect(result).toHaveLength(2);
      // Ordered by version DESC: v2 first
      expect(result[0].version).toBe(2);
      expect(result[1].version).toBe(1);
      // Only select fields returned
      expect(result[0]).toHaveProperty("id");
      expect(result[0]).toHaveProperty("version");
      expect(result[0]).toHaveProperty("createdAt");
      expect(result[0]).not.toHaveProperty("layer1CompanyLens");
    } finally {
      await cleanupCompany(companyId);
    }
  });

  // ── getEditorialConfig ────────────────────────────────────────────────────

  it("getEditorialConfig returns full layer JSON and returns null for wrong-company ID", async () => {
    const suffix = randomUUID();
    const companyId = await seedCompany(suffix);

    try {
      const configId = `ec_full_${suffix}`;
      await prisma.editorialConfig.create({
        data: {
          id: configId,
          companyId,
          version: 1,
          layer1CompanyLens: { doctrineMarkdown: "Test doctrine", sensitivityMarkdown: "Test sensitivity" },
          layer2ContentPhilosophy: { defaults: ["Specific", "Evidence-backed"] },
          layer3LinkedInCraft: { defaults: ["Max 250 words", "First person mandatory"] }
        }
      });

      // Returns full config
      const result = await queries.getEditorialConfig(configId);
      expect(result).not.toBeNull();
      expect(result!.companyId).toBe(companyId);
      const l1 = result!.layer1CompanyLens as Record<string, unknown>;
      expect(l1.doctrineMarkdown).toBe("Test doctrine");
      expect(l1.sensitivityMarkdown).toBe("Test sensitivity");
      const l2 = result!.layer2ContentPhilosophy as Record<string, unknown>;
      expect(l2.defaults).toEqual(["Specific", "Evidence-backed"]);

      // Returns null for nonexistent ID
      const missing = await queries.getEditorialConfig("nonexistent_id_" + suffix);
      expect(missing).toBeNull();
    } finally {
      await cleanupCompany(companyId);
    }
  });

  // ── getUser ───────────────────────────────────────────────────────────────

  it("getUser returns full baseProfile JSON and _count.ownedOpportunities", async () => {
    const suffix = randomUUID();
    const companyId = await seedCompany(suffix);

    try {
      const userId = `user_${suffix}`;
      await prisma.user.create({
        data: {
          id: userId,
          companyId,
          displayName: `Test User ${suffix}`,
          type: "human",
          language: "en",
          baseProfile: {
            toneSummary: "Warm and precise",
            preferredStructure: "Hook → Evidence → Insight",
            typicalPhrases: ["In practice", "What this means"],
            avoidRules: ["No jargon"],
            contentTerritories: ["Engineering leadership"],
            weakFitTerritories: ["Sales tactics"],
            sampleExcerpts: ["Example excerpt 1"]
          }
        }
      });

      const result = await queries.getUser(userId);
      expect(result).not.toBeNull();
      expect(result!.displayName).toBe(`Test User ${suffix}`);
      expect(result!.companyId).toBe(companyId);

      // baseProfile is full JSON
      const profile = result!.baseProfile as Record<string, unknown>;
      expect(profile.toneSummary).toBe("Warm and precise");
      expect(profile.typicalPhrases).toEqual(["In practice", "What this means"]);

      // _count included
      expect(result!._count.ownedOpportunities).toBe(0);

      // Returns null for nonexistent ID
      const missing = await queries.getUser("nonexistent_user_" + suffix);
      expect(missing).toBeNull();
    } finally {
      await cleanupCompany(companyId);
    }
  });

  // ── listSourceConfigs ──────────────────────────────────────────────────

  it("listSourceConfigs returns both enabled and disabled configs for seeded company", async () => {
    const suffix = randomUUID();
    const companyId = await seedCompany(suffix);

    try {
      await prisma.sourceConfig.create({
        data: {
          id: `sc_enabled_${suffix}`,
          companyId,
          source: `claap_${suffix}`,
          enabled: true,
          configJson: { workspace: "test" }
        }
      });
      await prisma.sourceConfig.create({
        data: {
          id: `sc_disabled_${suffix}`,
          companyId,
          source: `linear_${suffix}`,
          enabled: false,
          configJson: { team: "eng" }
        }
      });

      const result = await queries.listSourceConfigs(companyId);

      expect(result).toHaveLength(2);
      const enabledFlags = result.map((c: any) => c.enabled).sort();
      expect(enabledFlags).toEqual([false, true]);
    } finally {
      try {
        await prisma.sourceConfig.deleteMany({ where: { companyId } });
      } catch { /* best-effort */ }
      await cleanupCompany(companyId);
    }
  });

  // ── listMarketQueries ──────────────────────────────────────────────────

  it("listMarketQueries with enabled yes returns only enabled", async () => {
    const suffix = randomUUID();
    const companyId = await seedCompany(suffix);

    try {
      await prisma.marketQuery.create({
        data: {
          id: `mq_on_${suffix}`,
          companyId,
          query: `AI hiring trends ${suffix}`,
          enabled: true,
          priority: 1
        }
      });
      await prisma.marketQuery.create({
        data: {
          id: `mq_off_${suffix}`,
          companyId,
          query: `Competitor launches ${suffix}`,
          enabled: false,
          priority: 2
        }
      });

      // Filter by enabled: "yes" returns only the enabled query
      const enabledOnly = await queries.listMarketQueries(companyId, { enabled: "yes" });
      expect(enabledOnly).toHaveLength(1);
      expect((enabledOnly[0] as any).enabled).toBe(true);
      expect((enabledOnly[0] as any).query).toContain("AI hiring trends");

      // No filter returns all
      const all = await queries.listMarketQueries(companyId, {});
      expect(all).toHaveLength(2);
    } finally {
      try {
        await prisma.marketQuery.deleteMany({ where: { companyId } });
      } catch { /* best-effort */ }
      await cleanupCompany(companyId);
    }
  });

  // ── countMarketQueries ─────────────────────────────────────────────────

  it("countMarketQueries matches list count", async () => {
    const suffix = randomUUID();
    const companyId = await seedCompany(suffix);

    try {
      await prisma.marketQuery.create({
        data: {
          id: `mq_c1_${suffix}`,
          companyId,
          query: `Query one ${suffix}`,
          enabled: true,
          priority: 1
        }
      });
      await prisma.marketQuery.create({
        data: {
          id: `mq_c2_${suffix}`,
          companyId,
          query: `Query two ${suffix}`,
          enabled: true,
          priority: 2
        }
      });
      await prisma.marketQuery.create({
        data: {
          id: `mq_c3_${suffix}`,
          companyId,
          query: `Query three ${suffix}`,
          enabled: false,
          priority: 3
        }
      });

      const allList = await queries.listMarketQueries(companyId, {});
      const allCount = await queries.countMarketQueries(companyId, {});
      expect(allCount).toBe(allList.length);
      expect(allCount).toBe(3);

      const enabledList = await queries.listMarketQueries(companyId, { enabled: "yes" });
      const enabledCount = await queries.countMarketQueries(companyId, { enabled: "yes" });
      expect(enabledCount).toBe(enabledList.length);
      expect(enabledCount).toBe(2);
    } finally {
      try {
        await prisma.marketQuery.deleteMany({ where: { companyId } });
      } catch { /* best-effort */ }
      await cleanupCompany(companyId);
    }
  });

  // ── listDraftProfileIds ───────────────────────────────────────────────────

  it("listDraftProfileIds returns distinct profileIds for seeded company", async () => {
    const suffix = randomUUID();
    const companyId = await seedCompany(suffix);

    try {
      // Seed two opportunities (Draft requires an Opportunity)
      const oppId1 = `opp_dp1_${suffix}`;
      const oppId2 = `opp_dp2_${suffix}`;
      for (const oppId of [oppId1, oppId2]) {
        await prisma.opportunity.create({
          data: {
            id: oppId,
            companyId,
            sourceFingerprint: `fp_${oppId}`,
            title: `Opp ${oppId}`,
            angle: "Test angle",
            whyNow: "Test why now",
            whatItIsAbout: "Test about",
            whatItIsNotAbout: "Test not about",
            status: "To review",
            suggestedFormat: "post",
            supportingEvidenceCount: 1,
            evidenceFreshness: 0.8,
            notionPageFingerprint: `npf_${oppId}`
          }
        });
      }

      // Seed 3 drafts: 2 with profileId "baptiste", 1 with "linc-corporate"
      await prisma.draft.create({
        data: {
          id: `draft_dp1_${suffix}`,
          companyId,
          opportunityId: oppId1,
          profileId: "baptiste",
          proposedTitle: `Draft A ${suffix}`,
          hook: "Hook A",
          summary: "Summary A",
          whatItIsAbout: "About A",
          whatItIsNotAbout: "Not A",
          visualIdea: "Visual A",
          firstDraftText: "Text A",
          confidenceScore: 0.9,
          language: "fr"
        }
      });
      await prisma.draft.create({
        data: {
          id: `draft_dp2_${suffix}`,
          companyId,
          opportunityId: oppId1,
          profileId: "baptiste",
          proposedTitle: `Draft B ${suffix}`,
          hook: "Hook B",
          summary: "Summary B",
          whatItIsAbout: "About B",
          whatItIsNotAbout: "Not B",
          visualIdea: "Visual B",
          firstDraftText: "Text B",
          confidenceScore: 0.7,
          language: "fr"
        }
      });
      await prisma.draft.create({
        data: {
          id: `draft_dp3_${suffix}`,
          companyId,
          opportunityId: oppId2,
          profileId: "linc-corporate",
          proposedTitle: `Draft C ${suffix}`,
          hook: "Hook C",
          summary: "Summary C",
          whatItIsAbout: "About C",
          whatItIsNotAbout: "Not C",
          visualIdea: "Visual C",
          firstDraftText: "Text C",
          confidenceScore: 0.6,
          language: "en"
        }
      });

      const profileIds = await queries.listDraftProfileIds(companyId);

      expect(profileIds).toHaveLength(2);
      // Alphabetical order
      expect(profileIds).toEqual(["baptiste", "linc-corporate"]);
    } finally {
      try {
        await prisma.draft.deleteMany({ where: { companyId } });
        await prisma.opportunity.deleteMany({ where: { companyId } });
      } catch { /* best-effort */ }
      await cleanupCompany(companyId);
    }
  });

  // ── listDrafts ────────────────────────────────────────────────────────────

  it("listDrafts returns drafts with opportunity relation and respects filters", async () => {
    const suffix = randomUUID();
    const companyId = await seedCompany(suffix);

    try {
      const oppId = `opp_ld_${suffix}`;
      await prisma.opportunity.create({
        data: {
          id: oppId,
          companyId,
          sourceFingerprint: `fp_${oppId}`,
          title: `List Drafts Opp ${suffix}`,
          angle: "Angle",
          whyNow: "Why now",
          whatItIsAbout: "About",
          whatItIsNotAbout: "Not about",
          status: "To review",
          suggestedFormat: "post",
          supportingEvidenceCount: 1,
          evidenceFreshness: 0.5,
          notionPageFingerprint: `npf_${oppId}`
        }
      });

      await prisma.draft.create({
        data: {
          id: `draft_ld1_${suffix}`,
          companyId,
          opportunityId: oppId,
          profileId: "baptiste",
          proposedTitle: `Leadership Draft ${suffix}`,
          hook: "Hook",
          summary: "Summary",
          whatItIsAbout: "About",
          whatItIsNotAbout: "Not about",
          visualIdea: "Visual",
          firstDraftText: "Text",
          confidenceScore: 0.8,
          language: "fr"
        }
      });
      await prisma.draft.create({
        data: {
          id: `draft_ld2_${suffix}`,
          companyId,
          opportunityId: oppId,
          profileId: "linc-corporate",
          proposedTitle: `Engineering Draft ${suffix}`,
          hook: "Hook 2",
          summary: "Summary 2",
          whatItIsAbout: "About 2",
          whatItIsNotAbout: "Not about 2",
          visualIdea: "Visual 2",
          firstDraftText: "Text 2",
          confidenceScore: 0.6,
          language: "en"
        }
      });

      // List all drafts — should include opportunity title
      const all = await queries.listDrafts(companyId);
      expect(all).toHaveLength(2);
      for (const draft of all) {
        expect((draft as any).opportunity).not.toBeNull();
        expect((draft as any).opportunity.title).toContain(suffix);
      }

      // Filter by profileId
      const byProfile = await queries.listDrafts(companyId, { profileId: "baptiste" });
      expect(byProfile).toHaveLength(1);
      expect((byProfile[0] as any).profileId).toBe("baptiste");

      // Filter by q on proposedTitle
      const bySearch = await queries.listDrafts(companyId, { q: "Leadership" });
      expect(bySearch).toHaveLength(1);
      expect((bySearch[0] as any).proposedTitle).toContain("Leadership");

      // Count matches list
      const total = await queries.countDrafts(companyId);
      expect(total).toBe(2);
      const filtered = await queries.countDrafts(companyId, { profileId: "baptiste" });
      expect(filtered).toBe(1);
    } finally {
      try {
        await prisma.draft.deleteMany({ where: { companyId } });
        await prisma.opportunity.deleteMany({ where: { companyId } });
      } catch { /* best-effort */ }
      await cleanupCompany(companyId);
    }
  });

  // ── getRun with costEntries ───────────────────────────────────────────────

  it("getRun returns run with costEntries ordered by createdAt", async () => {
    const suffix = randomUUID();
    const companyId = await seedCompany(suffix);
    const runId = `run_gr_${suffix}`;

    try {
      await prisma.syncRun.create({
        data: {
          id: runId,
          companyId,
          runType: "ingest:run",
          source: "claap",
          status: "completed",
          startedAt: new Date("2026-01-01T10:00:00Z"),
          finishedAt: new Date("2026-01-01T10:05:00Z"),
          countersJson: { fetched: 5 },
          warningsJson: [],
          notionPageFingerprint: `npf_${runId}`
        }
      });

      // Create cost entries in reverse order to verify ordering
      await prisma.costLedgerEntry.create({
        data: {
          id: `ce_2_${suffix}`,
          runId,
          step: "enrichment",
          model: "gpt-4",
          mode: "provider",
          promptTokens: 200,
          completionTokens: 100,
          estimatedCostUsd: 0.009,
          createdAt: new Date("2026-01-01T10:03:00Z")
        }
      });
      await prisma.costLedgerEntry.create({
        data: {
          id: `ce_1_${suffix}`,
          runId,
          step: "screening",
          model: "gpt-4",
          mode: "provider",
          promptTokens: 100,
          completionTokens: 50,
          estimatedCostUsd: 0.0045,
          createdAt: new Date("2026-01-01T10:01:00Z")
        }
      });

      const result = await queries.getRun(runId);

      expect(result).not.toBeNull();
      expect(result!.companyId).toBe(companyId);
      expect(result!.costEntries).toHaveLength(2);
      // Ordered by createdAt ASC: screening first, enrichment second
      expect(result!.costEntries[0].step).toBe("screening");
      expect(result!.costEntries[1].step).toBe("enrichment");
    } finally {
      try {
        await prisma.costLedgerEntry.deleteMany({ where: { runId } });
        await prisma.syncRun.delete({ where: { id: runId } });
      } catch { /* best-effort */ }
      await cleanupCompany(companyId);
    }
  });

  // ── getDraft ──────────────────────────────────────────────────────────────

  it("getDraft returns draft with included opportunity and evidence relations", async () => {
    const suffix = randomUUID();
    const companyId = await seedCompany(suffix);
    const oppId = `opp_draft_${suffix}`;
    const siId = `si_draft_${suffix}`;
    const draftId = `draft_${suffix}`;
    const evId = `ev_draft_${suffix}`;

    try {
      // Seed opportunity (required FK parent for draft)
      await prisma.opportunity.create({
        data: {
          id: oppId,
          companyId,
          sourceFingerprint: `fp_draft_${suffix}`,
          title: `Draft Test Opportunity ${suffix}`,
          angle: "Test angle",
          whyNow: "Test why now",
          whatItIsAbout: "Test about",
          whatItIsNotAbout: "Test not about",
          status: "To review",
          suggestedFormat: "post",
          supportingEvidenceCount: 1,
          evidenceFreshness: 0.9,
          notionPageFingerprint: `nfp_draft_${suffix}`
        }
      });

      // Seed source item (required FK parent for evidence reference)
      await prisma.sourceItem.create({
        data: {
          id: siId,
          companyId,
          source: "claap",
          sourceItemId: `si_ext_${suffix}`,
          externalId: `ext_${suffix}`,
          fingerprint: `fp_si_${suffix}`,
          sourceUrl: "https://example.com",
          title: "Test Source Item",
          summary: "A summary",
          text: "Full text",
          occurredAt: new Date("2026-01-01"),
          ingestedAt: new Date("2026-01-01"),
          metadataJson: {},
          rawPayloadJson: {}
        }
      });

      // Seed draft
      await prisma.draft.create({
        data: {
          id: draftId,
          companyId,
          opportunityId: oppId,
          profileId: "baptiste",
          proposedTitle: `Test Draft ${suffix}`,
          hook: "Test hook",
          summary: "Test summary",
          whatItIsAbout: "About this",
          whatItIsNotAbout: "Not about that",
          visualIdea: "A chart",
          firstDraftText: "Full draft text for integration test",
          confidenceScore: 0.85,
          language: "fr"
        }
      });

      // Seed evidence reference linked to draft
      await prisma.evidenceReference.create({
        data: {
          id: evId,
          draftId,
          companyId,
          sourceItemId: siId,
          source: "claap",
          sourceUrl: "https://example.com/clip",
          timestamp: new Date("2026-01-01"),
          excerpt: "Key evidence excerpt",
          excerptHash: `hash_${suffix}`,
          speakerOrAuthor: "Speaker A",
          freshnessScore: 0.9
        }
      });

      const result = await queries.getDraft(draftId);

      expect(result).not.toBeNull();
      expect(result!.companyId).toBe(companyId);
      expect(result!.firstDraftText).toBe("Full draft text for integration test");

      // Opportunity relation included
      expect(result!.opportunity).not.toBeNull();
      expect(result!.opportunity!.id).toBe(oppId);
      expect(result!.opportunity!.title).toContain("Draft Test Opportunity");
      expect(result!.opportunity!.status).toBe("To review");

      // Evidence relation included
      expect(result!.evidence).toHaveLength(1);
      expect(result!.evidence[0].excerpt).toBe("Key evidence excerpt");
      expect(result!.evidence[0].speakerOrAuthor).toBe("Speaker A");
      expect(result!.evidence[0].source).toBe("claap");

      // Returns null for nonexistent ID
      const missing = await queries.getDraft("nonexistent_draft_" + suffix);
      expect(missing).toBeNull();
    } finally {
      try {
        await prisma.evidenceReference.deleteMany({ where: { draftId } });
        await prisma.draft.deleteMany({ where: { companyId } });
        await prisma.sourceItem.deleteMany({ where: { companyId } });
        await prisma.opportunity.deleteMany({ where: { companyId } });
      } catch { /* best-effort */ }
      await cleanupCompany(companyId);
    }
  });
});
