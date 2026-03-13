-- Convergence foundation migration.
-- This is the first cutover-safe step: add multi-tenant and runtime-config foundations
-- without removing the old signal-centric schema yet.

CREATE TABLE "Company" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "defaultTimezone" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Company_slug_key" ON "Company"("slug");

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "baseProfile" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "User_companyId_idx" ON "User"("companyId");

CREATE TABLE "EditorialConfig" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "layer1CompanyLens" JSONB NOT NULL,
  "layer2ContentPhilosophy" JSONB NOT NULL,
  "layer3LinkedInCraft" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorialConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EditorialConfig_companyId_version_key" ON "EditorialConfig"("companyId", "version");

CREATE TABLE "SourceConfig" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "configJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SourceConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SourceConfig_companyId_source_key" ON "SourceConfig"("companyId", "source");

CREATE TABLE "MarketQuery" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "priority" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketQuery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MarketQuery_companyId_enabled_priority_idx" ON "MarketQuery"("companyId", "enabled", "priority");

ALTER TABLE "SourceCursor" ADD COLUMN "companyId" TEXT;
ALTER TABLE "SourceItem" ADD COLUMN "companyId" TEXT;
ALTER TABLE "SourceItem" ADD COLUMN "processedAt" TIMESTAMP(3);
ALTER TABLE "ProfileBase" ADD COLUMN "companyId" TEXT;
ALTER TABLE "Opportunity" ADD COLUMN "companyId" TEXT;
ALTER TABLE "NotionDatabaseBinding" ADD COLUMN "companyId" TEXT;
ALTER TABLE "Draft" ADD COLUMN "companyId" TEXT;
ALTER TABLE "SyncRun" ADD COLUMN "companyId" TEXT;

CREATE UNIQUE INDEX "SourceCursor_companyId_source_key" ON "SourceCursor"("companyId", "source");
CREATE INDEX "SourceCursor_companyId_source_idx" ON "SourceCursor"("companyId", "source");
CREATE INDEX "SourceItem_companyId_processedAt_idx" ON "SourceItem"("companyId", "processedAt");
CREATE INDEX "NotionDatabaseBinding_companyId_name_idx" ON "NotionDatabaseBinding"("companyId", "name");

ALTER TABLE "SourceCursor" ADD CONSTRAINT "SourceCursor_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SourceItem" ADD CONSTRAINT "SourceItem_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProfileBase" ADD CONSTRAINT "ProfileBase_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotionDatabaseBinding" ADD CONSTRAINT "NotionDatabaseBinding_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EditorialConfig" ADD CONSTRAINT "EditorialConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SourceConfig" ADD CONSTRAINT "SourceConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketQuery" ADD CONSTRAINT "MarketQuery_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
