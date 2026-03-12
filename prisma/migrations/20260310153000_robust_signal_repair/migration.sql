-- Baseline schema for fresh databases. Earlier development relied on schema pushes,
-- so this migration must create the full pre-hardening schema before later migrations
-- can apply delta changes safely.

CREATE SCHEMA IF NOT EXISTS "public";

CREATE TABLE "SourceCursor" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "cursor" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceCursor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SourceItem" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceItemId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "authorName" TEXT,
    "speakerName" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL,
    "metadataJson" JSONB NOT NULL,
    "rawPayloadJson" JSONB NOT NULL,
    "rawText" TEXT,
    "chunksJson" JSONB,
    "rawTextStored" BOOLEAN NOT NULL DEFAULT true,
    "rawTextExpiresAt" TIMESTAMP(3),
    "cleanupEligible" BOOLEAN NOT NULL DEFAULT false,
    "notionPageId" TEXT,
    "notionPageFingerprint" TEXT,

    CONSTRAINT "SourceItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EvidenceReference" (
    "id" TEXT NOT NULL,
    "signalId" TEXT,
    "opportunityId" TEXT,
    "draftId" TEXT,
    "sourceItemId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "excerpt" TEXT NOT NULL,
    "excerptHash" TEXT NOT NULL,
    "speakerOrAuthor" TEXT,
    "freshnessScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceReference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "freshness" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "probableOwnerProfile" TEXT,
    "suggestedAngle" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sensitivityJson" JSONB NOT NULL,
    "duplicateOfSignalId" TEXT,
    "themeClusterKey" TEXT,
    "notionPageId" TEXT,
    "notionPageFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SignalSourceItem" (
    "signalId" TEXT NOT NULL,
    "sourceItemId" TEXT NOT NULL,

    CONSTRAINT "SignalSourceItem_pkey" PRIMARY KEY ("signalId","sourceItemId")
);

CREATE TABLE "ThemeCluster" (
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "profileHint" TEXT,
    "evidenceCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThemeCluster_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "ProfileBase" (
    "profileId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "languagePreference" TEXT NOT NULL,
    "toneSummary" TEXT NOT NULL,
    "preferredStructure" TEXT NOT NULL,
    "typicalPhrasesJson" JSONB NOT NULL,
    "avoidRulesJson" JSONB NOT NULL,
    "contentTerritoriesJson" JSONB NOT NULL,
    "weakFitTerritoriesJson" JSONB NOT NULL,
    "sampleExcerptsJson" JSONB NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "notionPageId" TEXT,
    "notionPageFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileBase_pkey" PRIMARY KEY ("profileId")
);

CREATE TABLE "ProfileLearnedLayer" (
    "profileId" TEXT NOT NULL,
    "recurringPhrasesJson" JSONB NOT NULL,
    "structuralPatternsJson" JSONB NOT NULL,
    "evidenceExcerptIdsJson" JSONB NOT NULL,
    "lastIncrementalUpdateAt" TIMESTAMP(3) NOT NULL,
    "lastWeeklyRecomputeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileLearnedLayer_pkey" PRIMARY KEY ("profileId")
);

CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ownerProfile" TEXT,
    "narrativePillar" TEXT NOT NULL,
    "angle" TEXT NOT NULL,
    "whyNow" TEXT NOT NULL,
    "whatItIsAbout" TEXT NOT NULL,
    "whatItIsNotAbout" TEXT NOT NULL,
    "routingStatus" TEXT NOT NULL,
    "readiness" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "suggestedFormat" TEXT NOT NULL,
    "supportingEvidenceCount" INTEGER NOT NULL,
    "evidenceFreshness" DOUBLE PRECISION NOT NULL,
    "primaryEvidenceId" TEXT,
    "editorialOwner" TEXT,
    "selectedAt" TIMESTAMP(3),
    "lastDigestAt" TIMESTAMP(3),
    "v1HistoryJson" JSONB NOT NULL,
    "notionPageId" TEXT,
    "notionPageFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OpportunitySignal" (
    "opportunityId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,

    CONSTRAINT "OpportunitySignal_pkey" PRIMARY KEY ("opportunityId","signalId")
);

CREATE TABLE "NotionDatabaseBinding" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentPageId" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotionDatabaseBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "proposedTitle" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "whatItIsAbout" TEXT NOT NULL,
    "whatItIsNotAbout" TEXT NOT NULL,
    "visualIdea" TEXT NOT NULL,
    "firstDraftText" TEXT NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "language" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "runType" TEXT NOT NULL,
    "source" TEXT,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "countersJson" JSONB NOT NULL,
    "warningsJson" JSONB NOT NULL,
    "notes" TEXT,
    "llmStatsJson" JSONB,
    "tokenTotalsJson" JSONB,
    "notionPageId" TEXT,
    "notionPageFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CostLedgerEntry" (
    "id" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL,
    "completionTokens" INTEGER NOT NULL,
    "estimatedCostUsd" DOUBLE PRECISION NOT NULL,
    "runId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SourceCursor_source_key" ON "SourceCursor"("source");
CREATE INDEX "SourceItem_source_occurredAt_idx" ON "SourceItem"("source", "occurredAt");
CREATE INDEX "SourceItem_cleanupEligible_rawTextExpiresAt_idx" ON "SourceItem"("cleanupEligible", "rawTextExpiresAt");
CREATE UNIQUE INDEX "SourceItem_source_sourceItemId_key" ON "SourceItem"("source", "sourceItemId");
CREATE UNIQUE INDEX "SourceItem_fingerprint_key" ON "SourceItem"("fingerprint");
CREATE INDEX "EvidenceReference_excerptHash_idx" ON "EvidenceReference"("excerptHash");
CREATE UNIQUE INDEX "Signal_sourceFingerprint_key" ON "Signal"("sourceFingerprint");
CREATE UNIQUE INDEX "Opportunity_sourceFingerprint_key" ON "Opportunity"("sourceFingerprint");
CREATE UNIQUE INDEX "NotionDatabaseBinding_parentPageId_name_key" ON "NotionDatabaseBinding"("parentPageId", "name");

ALTER TABLE "EvidenceReference" ADD CONSTRAINT "EvidenceReference_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvidenceReference" ADD CONSTRAINT "EvidenceReference_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvidenceReference" ADD CONSTRAINT "EvidenceReference_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "Draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvidenceReference" ADD CONSTRAINT "EvidenceReference_sourceItemId_fkey" FOREIGN KEY ("sourceItemId") REFERENCES "SourceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_duplicateOfSignalId_fkey" FOREIGN KEY ("duplicateOfSignalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_themeClusterKey_fkey" FOREIGN KEY ("themeClusterKey") REFERENCES "ThemeCluster"("key") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SignalSourceItem" ADD CONSTRAINT "SignalSourceItem_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SignalSourceItem" ADD CONSTRAINT "SignalSourceItem_sourceItemId_fkey" FOREIGN KEY ("sourceItemId") REFERENCES "SourceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_primaryEvidenceId_fkey" FOREIGN KEY ("primaryEvidenceId") REFERENCES "EvidenceReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OpportunitySignal" ADD CONSTRAINT "OpportunitySignal_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunitySignal" ADD CONSTRAINT "OpportunitySignal_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CostLedgerEntry" ADD CONSTRAINT "CostLedgerEntry_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
