-- recover-evidence-companyid.sql
--
-- One-time recovery for environments where migration
-- 20260404120000_evidence_company_not_null failed because
-- EvidenceReference.companyId contained NULL values.
--
-- WHEN TO USE:
--   prisma migrate deploy fails with:
--     "column "companyId" of relation "EvidenceReference" contains null values"
--   and _prisma_migrations shows 20260404120000 with finished_at = NULL.
--
-- HOW TO USE:
--   1. Run this SQL against the affected database:
--        psql $DATABASE_URL -f scripts/recover-evidence-companyid.sql
--   2. Mark the failed migration as rolled-back:
--        npx prisma migrate resolve --rolled-back 20260404120000_evidence_company_not_null
--   3. Run migrate deploy (replays 20260404 — now succeeds, then applies 20260407):
--        npx prisma migrate deploy
--
-- WHAT THIS DOES:
--   - Backfills NULL companyId from each row's linked SourceItem
--   - Deletes orphaned rows that cannot be backfilled
--   - Both statements are idempotent (safe to re-run)

BEGIN;

-- Backfill NULL companyId from the linked SourceItem.
UPDATE "EvidenceReference" er
SET    "companyId" = si."companyId"
FROM   "SourceItem" si
WHERE  er."sourceItemId" = si."id"
  AND  er."companyId" IS NULL;

-- Delete orphaned rows whose SourceItem no longer exists.
DELETE FROM "EvidenceReference"
WHERE  "companyId" IS NULL;

-- Report what remains (should be zero NULLs).
DO $$
DECLARE
  null_count INTEGER;
BEGIN
  SELECT count(*) INTO null_count
  FROM "EvidenceReference"
  WHERE "companyId" IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'Still % rows with NULL companyId — investigate manually', null_count;
  ELSE
    RAISE NOTICE 'All EvidenceReference rows have companyId set. Safe to run prisma migrate deploy.';
  END IF;
END $$;

COMMIT;
