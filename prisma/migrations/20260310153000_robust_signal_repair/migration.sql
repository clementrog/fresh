CREATE TABLE "NotionDatabaseBinding" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentPageId" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotionDatabaseBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotionDatabaseBinding_parentPageId_name_key" ON "NotionDatabaseBinding"("parentPageId", "name");

ALTER TABLE "SyncRun" ADD COLUMN "llmStatsJson" JSONB;
