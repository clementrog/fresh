CREATE TABLE "DigestDispatch" (
    "id" TEXT NOT NULL,
    "digestKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "opportunityIdsJson" JSONB NOT NULL,
    "slackMessageTs" TEXT,
    "sentAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DigestDispatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DigestDispatch_digestKey_key" ON "DigestDispatch"("digestKey");
CREATE UNIQUE INDEX "EvidenceReference_opportunityId_id_key" ON "EvidenceReference"("opportunityId", "id");

UPDATE "Opportunity" o
SET "primaryEvidenceId" = NULL
WHERE "primaryEvidenceId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "EvidenceReference" e
    WHERE e."id" = o."primaryEvidenceId"
      AND e."opportunityId" = o."id"
  );

ALTER TABLE "Opportunity"
DROP CONSTRAINT IF EXISTS "Opportunity_primaryEvidenceId_fkey";

-- Prisma models the primary evidence relation on the id column, but the database
-- must also enforce ownership: the chosen primary evidence row must belong to the
-- same opportunity.
ALTER TABLE "Opportunity"
ADD CONSTRAINT "Opportunity_primaryEvidenceId_opportunityId_fkey"
FOREIGN KEY ("id", "primaryEvidenceId")
REFERENCES "EvidenceReference"("opportunityId", "id")
DEFERRABLE INITIALLY DEFERRED;
