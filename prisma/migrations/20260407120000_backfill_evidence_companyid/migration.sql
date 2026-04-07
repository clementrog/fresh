-- Repair migration for EvidenceReference.companyId (follows 20260404120000).
--
-- If the prior migration (20260404120000) succeeded, every statement here is a
-- no-op: zero rows to backfill, zero to delete, column already NOT NULL, FK
-- already CASCADE.
--
-- If the prior migration failed on SET NOT NULL because of historical NULLs
-- (possible in staging/dev), Prisma will replay it on the next deploy even after
-- marking it rolled-back. The operator must backfill NULLs BEFORE re-running
-- migrate deploy. See scripts/recover-evidence-companyid.sql for the exact steps.

-- 1. Backfill NULL companyId from the linked SourceItem (sourceItemId is required
--    and SourceItem.companyId is NOT NULL, so this resolves every resolvable row).
UPDATE "EvidenceReference" er
SET    "companyId" = si."companyId"
FROM   "SourceItem" si
WHERE  er."sourceItemId" = si."id"
  AND  er."companyId" IS NULL;

-- 2. Delete any remaining rows with NULL companyId that could not be backfilled
--    (e.g. orphaned rows whose SourceItem was already deleted).
DELETE FROM "EvidenceReference" WHERE "companyId" IS NULL;

-- 3. Make companyId NOT NULL (idempotent — no-op if already NOT NULL).
ALTER TABLE "EvidenceReference" ALTER COLUMN "companyId" SET NOT NULL;

-- 4. Ensure FK uses ON DELETE CASCADE (idempotent — recreate to be safe).
ALTER TABLE "EvidenceReference" DROP CONSTRAINT IF EXISTS "EvidenceReference_companyId_fkey";
ALTER TABLE "EvidenceReference" ADD CONSTRAINT "EvidenceReference_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
