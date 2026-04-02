/**
 * Scope migration: isolate out-of-scope GitHub records and downstream artifacts.
 *
 * Usage:
 *   pnpm scope-migration:run              # Run full migration
 *   pnpm scope-migration:run --rollback   # Rollback all changes
 *   pnpm scope-migration:run --dry-run    # Preview without mutations
 *
 * Requires: DATABASE_URL, NOTION_TOKEN, NOTION_PARENT_PAGE_ID in environment.
 */

import { PrismaClient } from "@prisma/client";
import { Client as NotionClient } from "@notionhq/client";
import { assessDraftReadiness, computeReadinessTier } from "../src/services/evidence-pack.js";
import { mapReadinessTierToSelect, formatOperatorGuidance, formatEvidenceExcerpts } from "../src/services/notion.js";
import type { AppEnv } from "../src/config/env.js";
import { loadEnv } from "../src/config/env.js";

// The 7 Notion properties that this migration can mutate.
// All 7 are snapshotted, verified after sync, and restored on rollback.
const READINESS_PROPERTY = "How close is this to a draft?";

// --- Notion property snapshot type ---

interface NotionSnapshot {
  readinessSelect: string | null;
  whatsMissing: string | null;
  evidenceCount: number | null;
  supportingCount: number | null;
  freshness: number | null;
  excerpts: string | null;
  primaryExcerpt: string | null;
}

// --- Notion property read helpers ---

function readSelectValue(props: Record<string, any>, name: string): string | null {
  const prop = props[name];
  if (!prop || prop.type !== "select") return null;
  return prop.select?.name ?? null;
}

function readRichTextValue(props: Record<string, any>, name: string): string | null {
  const prop = props[name];
  if (!prop || prop.type !== "rich_text") return null;
  const text = (prop.rich_text ?? []).map((block: any) => block.plain_text ?? "").join("");
  return text || null;
}

function readNumberValue(props: Record<string, any>, name: string): number | null {
  const prop = props[name];
  if (!prop || prop.type !== "number") return null;
  return prop.number; // preserves null when field is empty
}

function extractSnapshot(props: Record<string, any>): NotionSnapshot {
  return {
    readinessSelect: readSelectValue(props, READINESS_PROPERTY),
    whatsMissing: readRichTextValue(props, "What's missing"),
    evidenceCount: readNumberValue(props, "Evidence count"),
    supportingCount: readNumberValue(props, "Supporting evidence count"),
    freshness: readNumberValue(props, "Evidence freshness"),
    excerpts: readRichTextValue(props, "Evidence excerpts"),
    primaryExcerpt: readRichTextValue(props, "Primary evidence")
  };
}

// --- Notion property write helpers ---

function richTextChunks(value: string | null) {
  const text = value ?? "";
  const chunks: Array<{ text: { content: string } }> = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({ text: { content: text.slice(i, i + 2000) } });
  }
  if (chunks.length === 0) chunks.push({ text: { content: "" } });
  return { rich_text: chunks };
}

function buildProperties(snap: NotionSnapshot): Record<string, any> {
  return {
    [READINESS_PROPERTY]: snap.readinessSelect ? { select: { name: snap.readinessSelect } } : { select: null },
    "What's missing": richTextChunks(snap.whatsMissing),
    // Notion number properties: null means "clear the field" (empty), which is what we want
    "Evidence count": { number: snap.evidenceCount },
    "Supporting evidence count": { number: snap.supportingCount },
    "Evidence freshness": { number: snap.freshness },
    "Evidence excerpts": richTextChunks(snap.excerpts),
    "Primary evidence": richTextChunks(snap.primaryExcerpt)
  };
}

// --- Snapshot comparison ---

function snapshotsMatch(actual: NotionSnapshot, expected: NotionSnapshot): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  if (actual.readinessSelect !== expected.readinessSelect) {
    mismatches.push(`readinessSelect: got=${actual.readinessSelect}, expected=${expected.readinessSelect}`);
  }
  // Rich text: compare trimmed since Notion may normalize whitespace
  if ((actual.whatsMissing ?? "").trim() !== (expected.whatsMissing ?? "").trim()) {
    mismatches.push(`whatsMissing: lengths ${(actual.whatsMissing ?? "").length} vs ${(expected.whatsMissing ?? "").length}`);
  }
  if (actual.evidenceCount !== expected.evidenceCount) {
    mismatches.push(`evidenceCount: got=${actual.evidenceCount}, expected=${expected.evidenceCount}`);
  }
  if (actual.supportingCount !== expected.supportingCount) {
    mismatches.push(`supportingCount: got=${actual.supportingCount}, expected=${expected.supportingCount}`);
  }
  if (actual.freshness !== expected.freshness) {
    mismatches.push(`freshness: got=${actual.freshness}, expected=${expected.freshness}`);
  }
  if ((actual.excerpts ?? "").trim() !== (expected.excerpts ?? "").trim()) {
    mismatches.push(`excerpts: lengths ${(actual.excerpts ?? "").length} vs ${(expected.excerpts ?? "").length}`);
  }
  if ((actual.primaryExcerpt ?? "").trim() !== (expected.primaryExcerpt ?? "").trim()) {
    mismatches.push(`primaryExcerpt: lengths ${(actual.primaryExcerpt ?? "").length} vs ${(expected.primaryExcerpt ?? "").length}`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const isRollback = args.includes("--rollback");
  const isDryRun = args.includes("--dry-run");
  const env = loadEnv();
  const prisma = new PrismaClient();

  try {
    if (isRollback) {
      await rollback(prisma, env);
    } else {
      await migrate(prisma, env, isDryRun);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// --- Migration ---

async function migrate(prisma: PrismaClient, env: AppEnv, isDryRun: boolean) {
  console.log(isDryRun ? "=== DRY RUN ===" : "=== SCOPE MIGRATION ===");

  // ──────────────────────────────────────────────────────────────────────
  // PREFLIGHT: hard gate — abort before any writes
  // ──────────────────────────────────────────────────────────────────────

  console.log("\n[PREFLIGHT] Checking environment...");
  if (!env.NOTION_TOKEN) throw new Error("Preflight failed: NOTION_TOKEN is required");
  if (!env.NOTION_PARENT_PAGE_ID) throw new Error("Preflight failed: NOTION_PARENT_PAGE_ID is required");

  const notionClient = new NotionClient({ auth: env.NOTION_TOKEN });

  const affectedOpps = await prisma.$queryRaw<Array<{ id: string; status: string; notionPageId: string | null }>>`
    SELECT o.id, o.status, o."notionPageId"
    FROM "Opportunity" o
    WHERE o.id IN (
      SELECT DISTINCT oe."opportunityId" FROM "OpportunityEvidence" oe
      JOIN "EvidenceReference" er ON oe."evidenceId" = er.id
      JOIN "SourceItem" si ON er."sourceItemId" = si.id
      WHERE si.source = 'github'
        AND si."metadataJson"->>'repoName' NOT IN ('tranche', 'rgdu', 'dsnreader')
    )
  `;

  const nonArchived = affectedOpps.filter(o => o.status !== "Archived" && o.status !== "Rejected");
  console.log(`[PREFLIGHT] ${affectedOpps.length} affected opportunities, ${nonArchived.length} non-archived`);

  // Hard gate: every non-archived opportunity must have a reachable Notion page
  for (const opp of nonArchived) {
    if (!opp.notionPageId) {
      throw new Error(`Preflight failed: opportunity ${opp.id} has no notionPageId`);
    }
    try {
      await notionClient.pages.retrieve({ page_id: opp.notionPageId });
    } catch (err) {
      throw new Error(`Preflight failed: Notion page ${opp.notionPageId} for opportunity ${opp.id} is unreachable: ${err}`);
    }
  }
  console.log(`[PREFLIGHT] All ${nonArchived.length} Notion pages verified reachable`);

  const actualOosCount = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count FROM "SourceItem"
    WHERE source = 'github'
      AND "metadataJson"->>'repoName' NOT IN ('tranche', 'rgdu', 'dsnreader')
      AND ("metadataJson"->>'scopeExcluded') IS DISTINCT FROM 'true'
  `;
  console.log(`[PREFLIGHT] ${actualOosCount[0].count} out-of-scope source items to flag`);

  const oosEvidenceCount = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count FROM "OpportunityEvidence" oe
    JOIN "EvidenceReference" er ON oe."evidenceId" = er.id
    JOIN "SourceItem" si ON er."sourceItemId" = si.id
    WHERE si.source = 'github'
      AND si."metadataJson"->>'repoName' NOT IN ('tranche', 'rgdu', 'dsnreader')
  `;
  console.log(`[PREFLIGHT] ${oosEvidenceCount[0].count} OpportunityEvidence rows to detach`);

  if (isDryRun) {
    console.log("\n[DRY RUN] Would proceed with migration. Exiting.");
    return;
  }

  // ──────────────────────────────────────────────────────────────────────
  // SNAPSHOT: fresh rollback tables + real Notion property values
  // ──────────────────────────────────────────────────────────────────────

  console.log("\n[SNAPSHOT] Creating rollback tables...");

  for (const t of ["_scope_mig_snap_oe", "_scope_mig_snap_er", "_scope_mig_snap_opp", "_scope_mig_snap_si", "_scope_mig_notion_snapshot"]) {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${t}`);
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE _scope_mig_snap_oe AS
    SELECT oe.* FROM "OpportunityEvidence" oe
    JOIN "EvidenceReference" er ON oe."evidenceId" = er.id
    JOIN "SourceItem" si ON er."sourceItemId" = si.id
    WHERE si.source = 'github'
      AND si."metadataJson"->>'repoName' NOT IN ('tranche', 'rgdu', 'dsnreader')
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE _scope_mig_snap_er AS
    SELECT er.id, er."opportunityId" FROM "EvidenceReference" er
    JOIN "SourceItem" si ON er."sourceItemId" = si.id
    WHERE si.source = 'github'
      AND si."metadataJson"->>'repoName' NOT IN ('tranche', 'rgdu', 'dsnreader')
      AND er."opportunityId" IS NOT NULL
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE _scope_mig_snap_opp AS
    SELECT id, status, "supportingEvidenceCount", "primaryEvidenceId",
           readiness, "evidenceFreshness"
    FROM "Opportunity"
    WHERE id IN (
      SELECT DISTINCT oe."opportunityId" FROM "OpportunityEvidence" oe
      JOIN "EvidenceReference" er ON oe."evidenceId" = er.id
      JOIN "SourceItem" si ON er."sourceItemId" = si.id
      WHERE si.source = 'github'
        AND si."metadataJson"->>'repoName' NOT IN ('tranche', 'rgdu', 'dsnreader')
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE _scope_mig_snap_si AS
    SELECT id FROM "SourceItem"
    WHERE source = 'github'
      AND "metadataJson"->>'repoName' NOT IN ('tranche', 'rgdu', 'dsnreader')
      AND ("metadataJson"->>'scopeExcluded') IS DISTINCT FROM 'true'
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE _scope_mig_notion_snapshot (
      "opportunityId" TEXT PRIMARY KEY,
      "notionPageId" TEXT NOT NULL,
      "priorState" JSONB NOT NULL,
      "newState" JSONB,
      "snapshotAt" TIMESTAMPTZ DEFAULT NOW(),
      "syncedAt" TIMESTAMPTZ,
      "verified" BOOLEAN DEFAULT FALSE
    )
  `);

  const snapCounts = await prisma.$queryRaw<Array<{ tbl: string; count: bigint }>>`
    SELECT 'oe' as tbl, COUNT(*) as count FROM _scope_mig_snap_oe
    UNION ALL SELECT 'er', COUNT(*) FROM _scope_mig_snap_er
    UNION ALL SELECT 'opp', COUNT(*) FROM _scope_mig_snap_opp
    UNION ALL SELECT 'si', COUNT(*) FROM _scope_mig_snap_si
  `;
  for (const row of snapCounts) {
    console.log(`[SNAPSHOT] ${row.tbl}: ${row.count} rows`);
  }

  // Read real Notion property values for each affected page
  console.log("[SNAPSHOT] Reading Notion property values...");
  for (const opp of nonArchived) {
    if (!opp.notionPageId) continue;
    const page = await notionClient.pages.retrieve({ page_id: opp.notionPageId }) as any;
    const priorState = extractSnapshot(page.properties ?? {});
    await prisma.$executeRawUnsafe(`
      INSERT INTO _scope_mig_notion_snapshot ("opportunityId", "notionPageId", "priorState")
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT ("opportunityId") DO UPDATE SET "priorState" = EXCLUDED."priorState", "snapshotAt" = NOW()
    `, opp.id, opp.notionPageId, JSON.stringify(priorState));
    console.log(`  ${opp.id}: readiness=${priorState.readinessSelect}, evidence=${priorState.evidenceCount}, freshness=${priorState.freshness}`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // DB MUTATIONS
  // ──────────────────────────────────────────────────────────────────────

  console.log("\n[DB MUTATIONS] Flagging out-of-scope source items...");
  const flagged = await prisma.$executeRawUnsafe(`
    UPDATE "SourceItem"
    SET "metadataJson" = "metadataJson" || '{"scopeExcluded": true}'::jsonb
    WHERE id IN (SELECT id FROM _scope_mig_snap_si)
  `);
  console.log(`  Flagged ${flagged} source items`);

  console.log("[DB MUTATIONS] Rebinding OOS primary references...");
  const rebound = await prisma.$executeRawUnsafe(`
    UPDATE "Opportunity" o
    SET "primaryEvidenceId" = (
      SELECT oe."evidenceId"
      FROM "OpportunityEvidence" oe
      JOIN "EvidenceReference" er ON oe."evidenceId" = er.id
      WHERE oe."opportunityId" = o.id
        AND er.id NOT IN (
          SELECT er2.id FROM "EvidenceReference" er2
          JOIN "SourceItem" si ON er2."sourceItemId" = si.id
          WHERE si.source = 'github'
            AND si."metadataJson"->>'repoName' NOT IN ('tranche', 'rgdu', 'dsnreader')
        )
      ORDER BY er."freshnessScore" DESC
      LIMIT 1
    )
    WHERE o."primaryEvidenceId" IN (
      SELECT er.id FROM "EvidenceReference" er
      JOIN "SourceItem" si ON er."sourceItemId" = si.id
      WHERE si.source = 'github'
        AND si."metadataJson"->>'repoName' NOT IN ('tranche', 'rgdu', 'dsnreader')
    )
  `);
  console.log(`  Rebound ${rebound} primary references`);

  console.log("[DB MUTATIONS] Detaching OOS evidence...");
  const detachedOe = await prisma.$executeRawUnsafe(`
    DELETE FROM "OpportunityEvidence"
    WHERE "evidenceId" IN (
      SELECT er.id FROM "EvidenceReference" er
      JOIN "SourceItem" si ON er."sourceItemId" = si.id
      WHERE si.source = 'github'
        AND si."metadataJson"->>'repoName' NOT IN ('tranche', 'rgdu', 'dsnreader')
    )
  `);
  console.log(`  Deleted ${detachedOe} OpportunityEvidence rows`);

  const unlinkedEr = await prisma.$executeRawUnsafe(`
    UPDATE "EvidenceReference"
    SET "opportunityId" = NULL
    WHERE "sourceItemId" IN (
      SELECT id FROM "SourceItem"
      WHERE source = 'github'
        AND "metadataJson"->>'repoName' NOT IN ('tranche', 'rgdu', 'dsnreader')
    )
    AND "opportunityId" IS NOT NULL
  `);
  console.log(`  Unlinked ${unlinkedEr} EvidenceReference rows`);

  console.log("[DB MUTATIONS] Recomputing derived fields...");
  await prisma.$executeRawUnsafe(`
    UPDATE "Opportunity" o
    SET "supportingEvidenceCount" = GREATEST(0, (
      SELECT COUNT(*) FROM "OpportunityEvidence" oe WHERE oe."opportunityId" = o.id
    ) - 1)
    WHERE o.id IN (SELECT id FROM _scope_mig_snap_opp)
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE "Opportunity" o
    SET "evidenceFreshness" = COALESCE((
      SELECT er."freshnessScore" FROM "EvidenceReference" er
      WHERE er.id = o."primaryEvidenceId"
    ), 0)
    WHERE o.id IN (SELECT id FROM _scope_mig_snap_opp)
  `);

  console.log("[DB MUTATIONS] Applying eligibility rule...");
  const archived = await prisma.$executeRawUnsafe(`
    UPDATE "Opportunity"
    SET status = 'Archived'
    WHERE id IN (SELECT id FROM _scope_mig_snap_opp)
      AND (
        NOT EXISTS (
          SELECT 1 FROM "OpportunityEvidence" oe WHERE oe."opportunityId" = "Opportunity".id
        )
        OR "primaryEvidenceId" IS NULL
      )
  `);
  console.log(`  Archived ${archived} opportunities (failed eligibility after rebasing)`);

  // ──────────────────────────────────────────────────────────────────────
  // NOTION RESYNC: update only the 7 mutation-surface properties
  // Uses notionClient.pages.update directly — never creates pages.
  // ──────────────────────────────────────────────────────────────────────

  console.log("\n[NOTION RESYNC] Updating Notion pages (update-only, no creation)...");

  const activeAffected = await prisma.$queryRaw<Array<{ id: string; notionPageId: string }>>`
    SELECT o.id, o."notionPageId"
    FROM "Opportunity" o
    WHERE o.id IN (SELECT id FROM _scope_mig_snap_opp)
      AND o.status NOT IN ('Archived', 'Rejected')
      AND o."notionPageId" IS NOT NULL
  `;

  let syncSuccess = 0;
  let syncFailed = 0;

  for (const opp of activeAffected) {
    try {
      const oppRow = await prisma.opportunity.findUnique({
        where: { id: opp.id },
        include: {
          evidence: true,
          primaryEvidence: true,
          linkedEvidence: { include: { evidence: true } }
        }
      });
      if (!oppRow) continue;

      const evidence = oppRow.linkedEvidence?.map(le => le.evidence) ?? [];
      const readiness = assessDraftReadiness(oppRow as any, evidence as any);
      const tier = computeReadinessTier({
        hasOriginatingSource: readiness.hasOriginatingSource,
        hasSupportingEvidence: readiness.hasSupportingEvidence,
        hasConcreteAngle: readiness.hasConcreteAngle,
        hasDraftableMaterial: readiness.hasDraftableMaterial,
        claimPosture: readiness.claimPosture,
        productBacking: readiness.productBacking
      });

      // Compute the exact values we will write
      const newState: NotionSnapshot = {
        readinessSelect: mapReadinessTierToSelect(tier),
        whatsMissing: formatOperatorGuidance(readiness.operatorGuidance ?? []) || null,
        evidenceCount: evidence.length,
        supportingCount: Math.max(0, evidence.length - 1),
        freshness: (oppRow as any).evidenceFreshness ?? 0,
        excerpts: formatEvidenceExcerpts(evidence as any) || null,
        primaryExcerpt: (oppRow as any).primaryEvidence?.excerpt ?? null
      };

      // Write only the 7 mutation-surface properties — no page creation possible
      await notionClient.pages.update({
        page_id: opp.notionPageId,
        properties: buildProperties(newState)
      });

      await prisma.$executeRawUnsafe(`
        UPDATE _scope_mig_notion_snapshot
        SET "newState" = $1::jsonb, "syncedAt" = NOW()
        WHERE "opportunityId" = $2
      `, JSON.stringify(newState), opp.id);

      console.log(`  Synced ${opp.id}: ${newState.readinessSelect}, evidence=${newState.evidenceCount}`);
      syncSuccess++;
    } catch (err) {
      console.error(`  FAILED ${opp.id}: ${err}`);
      syncFailed++;
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // VERIFY: read back all 7 properties from Notion and compare
  // ──────────────────────────────────────────────────────────────────────

  console.log(`\n[VERIFY] Synced: ${syncSuccess}, Failed: ${syncFailed}`);
  console.log("[VERIFY] Reading back all 7 mutation-surface properties...");

  let verifyMismatches = 0;
  for (const opp of activeAffected) {
    try {
      const page = await notionClient.pages.retrieve({ page_id: opp.notionPageId }) as any;
      const actual = extractSnapshot(page.properties ?? {});

      const snapRow = await prisma.$queryRaw<Array<{ newState: any }>>`
        SELECT "newState" FROM _scope_mig_notion_snapshot WHERE "opportunityId" = ${opp.id}
      `;
      const expected = snapRow[0]?.newState as NotionSnapshot | undefined;
      if (!expected) {
        console.error(`  ${opp.id}: no newState recorded — sync may have failed`);
        verifyMismatches++;
        continue;
      }

      const { ok, mismatches } = snapshotsMatch(actual, expected);
      if (!ok) {
        console.error(`  ${opp.id}: MISMATCH on ${mismatches.length} field(s): ${mismatches.join("; ")}`);
        verifyMismatches++;
        continue;
      }

      await prisma.$executeRawUnsafe(`
        UPDATE _scope_mig_notion_snapshot SET verified = TRUE WHERE "opportunityId" = $1
      `, opp.id);
      console.log(`  Verified ${opp.id}: all 7 properties match ✓`);
    } catch (err) {
      console.error(`  ${opp.id}: verify read failed: ${err}`);
      verifyMismatches++;
    }
  }

  if (syncFailed > 0 || verifyMismatches > 0) {
    console.error(`\n[VERIFY] FAILED: ${syncFailed} sync failures, ${verifyMismatches} verification mismatches`);
    console.error("DO NOT proceed with intelligence:run. Re-run this script to retry.");
    process.exitCode = 1;
    return;
  }

  console.log("\n[VERIFY] All 7 properties verified for all pages. Safe to proceed with ingest:run + intelligence:run.");
}

// --- Rollback ---

async function rollback(prisma: PrismaClient, env: AppEnv) {
  console.log("=== SCOPE MIGRATION ROLLBACK ===");

  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE tablename LIKE '_scope_mig_%'
  `;
  const tableNames = new Set(tables.map(t => t.tablename));
  console.log(`[ROLLBACK] Found snapshot tables: ${[...tableNames].join(", ")}`);

  if (!tableNames.has("_scope_mig_snap_oe") || !tableNames.has("_scope_mig_snap_opp")) {
    throw new Error("Rollback failed: snapshot tables not found. Was the migration run?");
  }

  // --- Restore Notion state first (before DB changes, so we can still read newState for logging) ---

  if (tableNames.has("_scope_mig_notion_snapshot") && env.NOTION_TOKEN) {
    console.log("[ROLLBACK] Restoring Notion page properties from priorState...");
    const notionClient = new NotionClient({ auth: env.NOTION_TOKEN });

    const snapshots = await prisma.$queryRaw<Array<{ opportunityId: string; notionPageId: string; priorState: any }>>`
      SELECT "opportunityId", "notionPageId", "priorState" FROM _scope_mig_notion_snapshot
    `;

    let restored = 0;
    let failed = 0;
    for (const snap of snapshots) {
      try {
        const prior = snap.priorState as NotionSnapshot;
        await notionClient.pages.update({
          page_id: snap.notionPageId,
          properties: buildProperties(prior)
        });

        // Verify rollback by reading back all 7 properties
        const page = await notionClient.pages.retrieve({ page_id: snap.notionPageId }) as any;
        const actual = extractSnapshot(page.properties ?? {});
        const { ok, mismatches } = snapshotsMatch(actual, prior);
        if (!ok) {
          console.error(`  ${snap.opportunityId}: rollback verify MISMATCH: ${mismatches.join("; ")}`);
          failed++;
          continue;
        }
        console.log(`  Restored ${snap.opportunityId}: all 7 properties match priorState ✓`);
        restored++;
      } catch (err) {
        console.error(`  FAILED restoring ${snap.opportunityId}: ${err}`);
        failed++;
      }
    }
    console.log(`[ROLLBACK] Notion: ${restored} restored, ${failed} failed`);
    if (failed > 0) {
      process.exitCode = 1;
    }
  } else {
    console.log("[ROLLBACK] Skipping Notion restore (no snapshot table or no NOTION_TOKEN)");
  }

  // --- Restore DB state ---

  console.log("[ROLLBACK] Restoring OpportunityEvidence...");
  await prisma.$executeRawUnsafe(`
    INSERT INTO "OpportunityEvidence"
    SELECT * FROM _scope_mig_snap_oe
    ON CONFLICT DO NOTHING
  `);

  console.log("[ROLLBACK] Restoring EvidenceReference.opportunityId...");
  await prisma.$executeRawUnsafe(`
    UPDATE "EvidenceReference" er
    SET "opportunityId" = b."opportunityId"
    FROM _scope_mig_snap_er b
    WHERE er.id = b.id
  `);

  console.log("[ROLLBACK] Restoring Opportunity fields...");
  await prisma.$executeRawUnsafe(`
    UPDATE "Opportunity" o
    SET status = b.status,
        "supportingEvidenceCount" = b."supportingEvidenceCount",
        "primaryEvidenceId" = b."primaryEvidenceId",
        readiness = b.readiness,
        "evidenceFreshness" = b."evidenceFreshness"
    FROM _scope_mig_snap_opp b
    WHERE o.id = b.id
  `);

  // Only remove scopeExcluded from rows this migration flagged
  if (tableNames.has("_scope_mig_snap_si")) {
    console.log("[ROLLBACK] Removing scopeExcluded flags (migration-scoped)...");
    await prisma.$executeRawUnsafe(`
      UPDATE "SourceItem"
      SET "metadataJson" = "metadataJson" - 'scopeExcluded'
      WHERE id IN (SELECT id FROM _scope_mig_snap_si)
    `);
  } else {
    console.warn("[ROLLBACK] WARNING: _scope_mig_snap_si not found — skipping scopeExcluded rollback");
  }

  console.log("[ROLLBACK] Complete.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
