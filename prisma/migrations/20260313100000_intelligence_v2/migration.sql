-- Phase 5: Intelligence pipeline v2 migration
-- Standalone evidence, company-scoped IDs, enrichment log, owner user identity

-- 1a. Add enrichmentLogJson to Opportunity
ALTER TABLE "Opportunity" ADD COLUMN "enrichmentLogJson" JSONB NOT NULL DEFAULT '[]';

-- 1b. Add ownerUserId to Opportunity
ALTER TABLE "Opportunity" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 1c. Add screeningResultJson to SourceItem
ALTER TABLE "SourceItem" ADD COLUMN "screeningResultJson" JSONB;

-- 1d. Add companyId to EvidenceReference
ALTER TABLE "EvidenceReference" ADD COLUMN "companyId" TEXT;
ALTER TABLE "EvidenceReference" ADD CONSTRAINT "EvidenceReference_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "EvidenceReference_companyId_sourceItemId_idx"
  ON "EvidenceReference"("companyId", "sourceItemId");

-- 1e. Add OpportunityEvidence junction table
CREATE TABLE "OpportunityEvidence" (
  "opportunityId" TEXT NOT NULL,
  "evidenceId"    TEXT NOT NULL,
  "relevanceNote" TEXT NOT NULL DEFAULT '',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OpportunityEvidence_pkey" PRIMARY KEY ("opportunityId", "evidenceId")
);
ALTER TABLE "OpportunityEvidence"
  ADD CONSTRAINT "OpportunityEvidence_opportunityId_fkey"
  FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityEvidence"
  ADD CONSTRAINT "OpportunityEvidence_evidenceId_fkey"
  FOREIGN KEY ("evidenceId") REFERENCES "EvidenceReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 1f. Replace primary-evidence ownership constraint
ALTER TABLE "Opportunity"
  DROP CONSTRAINT IF EXISTS "Opportunity_primaryEvidenceId_opportunityId_fkey";

ALTER TABLE "Opportunity"
  ADD CONSTRAINT "Opportunity_primaryEvidenceId_fkey"
  FOREIGN KEY ("primaryEvidenceId") REFERENCES "EvidenceReference"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 1g-tenancy. Company-scoped IDs, uniqueness constraints, and cursor state
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Backfill NULL companyIds from the single seeded company
UPDATE "SourceItem" SET "companyId" = (SELECT id FROM "Company" LIMIT 1)
  WHERE "companyId" IS NULL;
UPDATE "Opportunity" SET "companyId" = (SELECT id FROM "Company" LIMIT 1)
  WHERE "companyId" IS NULL;

-- 2. Make companyId NOT NULL
ALTER TABLE "SourceItem" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "Opportunity" ALTER COLUMN "companyId" SET NOT NULL;

-- 3. Build temporary mapping table BEFORE remapping Opportunity.id
CREATE TEMP TABLE _opp_id_map AS
  SELECT
    "id" AS old_id,
    'opportunity_' || left(encode(digest(trim("companyId") || '|' || trim("sourceFingerprint"), 'sha256'), 'hex'), 24) AS new_id
  FROM "Opportunity";

-- 4. Remap SourceItem.id to company-scoped IDs
UPDATE "SourceItem" SET "id" =
  'si_' || left(encode(digest(trim("companyId") || '|' || trim("externalId"), 'sha256'), 'hex'), 24);

-- 5. Remap Opportunity.id to company-scoped IDs
UPDATE "Opportunity" SET "id" =
  'opportunity_' || left(encode(digest(trim("companyId") || '|' || trim("sourceFingerprint"), 'sha256'), 'hex'), 24);

-- 6. Remap DigestDispatch.opportunityIdsJson using the mapping table
UPDATE "DigestDispatch" dd SET "opportunityIdsJson" = COALESCE(
  (SELECT jsonb_agg(COALESCE(m.new_id, elem.val))
   FROM jsonb_array_elements_text(dd."opportunityIdsJson") AS elem(val)
   LEFT JOIN _opp_id_map m ON m.old_id = elem.val),
  '[]'::jsonb
);

DROP TABLE _opp_id_map;

-- 7. Remove global unique on SourceCursor
DROP INDEX IF EXISTS "SourceCursor_source_key";

-- 8. Replace global uniques with company-scoped uniques on SourceItem
DROP INDEX IF EXISTS "SourceItem_source_sourceItemId_key";
DROP INDEX IF EXISTS "SourceItem_fingerprint_key";
CREATE UNIQUE INDEX "SourceItem_companyId_source_sourceItemId_key"
  ON "SourceItem"("companyId", "source", "sourceItemId");
CREATE UNIQUE INDEX "SourceItem_companyId_fingerprint_key"
  ON "SourceItem"("companyId", "fingerprint");

-- 9. Replace global unique with company-scoped unique on Opportunity
DROP INDEX IF EXISTS "Opportunity_sourceFingerprint_key";
CREATE UNIQUE INDEX "Opportunity_companyId_sourceFingerprint_key"
  ON "Opportunity"("companyId", "sourceFingerprint");
