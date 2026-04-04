-- AlignEvidenceReference.companyId with live DB contract (NOT NULL, ON DELETE CASCADE).
-- The live database already enforces these constraints; this migration makes the
-- Prisma schema and migration history consistent with the actual DB state.

-- 1. Make companyId NOT NULL (idempotent — column is already NOT NULL in the live DB)
ALTER TABLE "EvidenceReference" ALTER COLUMN "companyId" SET NOT NULL;

-- 2. Recreate FK with ON DELETE CASCADE to match live DB behavior.
--    The original migration (20260313100000) specified ON DELETE SET NULL, but
--    the live database currently uses ON DELETE CASCADE. This migration aligns
--    the recorded history with reality.
ALTER TABLE "EvidenceReference" DROP CONSTRAINT "EvidenceReference_companyId_fkey";
ALTER TABLE "EvidenceReference" ADD CONSTRAINT "EvidenceReference_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
