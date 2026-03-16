-- Phase 9: Signal-era cleanup migration
-- Drops 7 signal-era models, removes EvidenceReference.signalId,
-- makes Opportunity signal-era columns nullable with defaults.

-- ============================================================
-- 1. Drop junction / leaf tables first (FK dependents)
-- ============================================================

-- OpportunitySignal (junction: Opportunity ↔ Signal)
DROP TABLE IF EXISTS "OpportunitySignal" CASCADE;

-- SignalSourceItem (junction: Signal ↔ SourceItem)
DROP TABLE IF EXISTS "SignalSourceItem" CASCADE;

-- DigestDispatch (standalone, no inbound FKs)
DROP TABLE IF EXISTS "DigestDispatch" CASCADE;

-- ProfileLearnedLayer (standalone, no inbound FKs)
DROP TABLE IF EXISTS "ProfileLearnedLayer" CASCADE;

-- ProfileBase (referenced by Company.profileBases relation only)
DROP TABLE IF EXISTS "ProfileBase" CASCADE;

-- ============================================================
-- 2. Drop EvidenceReference.signalId column and FK
-- ============================================================

ALTER TABLE "EvidenceReference" DROP CONSTRAINT IF EXISTS "EvidenceReference_signalId_fkey";
ALTER TABLE "EvidenceReference" DROP COLUMN IF EXISTS "signalId";

-- ============================================================
-- 3. Drop Signal and ThemeCluster (Signal depends on ThemeCluster FK)
-- ============================================================

-- Signal first (has FK to ThemeCluster)
DROP TABLE IF EXISTS "Signal" CASCADE;

-- ThemeCluster (now safe to drop)
DROP TABLE IF EXISTS "ThemeCluster" CASCADE;

-- ============================================================
-- 4. Make Opportunity signal-era columns nullable with defaults
-- ============================================================

-- narrativePillar: was NOT NULL, make nullable with default ''
ALTER TABLE "Opportunity" ALTER COLUMN "narrativePillar" DROP NOT NULL;
ALTER TABLE "Opportunity" ALTER COLUMN "narrativePillar" SET DEFAULT '';

-- routingStatus: was NOT NULL, make nullable with default 'Routed'
ALTER TABLE "Opportunity" ALTER COLUMN "routingStatus" DROP NOT NULL;
ALTER TABLE "Opportunity" ALTER COLUMN "routingStatus" SET DEFAULT 'Routed';

-- readiness: was NOT NULL, make nullable with default 'Opportunity only'
ALTER TABLE "Opportunity" ALTER COLUMN "readiness" DROP NOT NULL;
ALTER TABLE "Opportunity" ALTER COLUMN "readiness" SET DEFAULT 'Opportunity only';

-- v1HistoryJson: was NOT NULL, make nullable with default '[]'
ALTER TABLE "Opportunity" ALTER COLUMN "v1HistoryJson" DROP NOT NULL;
ALTER TABLE "Opportunity" ALTER COLUMN "v1HistoryJson" SET DEFAULT '[]';
