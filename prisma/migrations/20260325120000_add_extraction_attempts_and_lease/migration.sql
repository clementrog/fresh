-- Add retry budget tracking for extraction
ALTER TABLE "SalesActivity" ADD COLUMN "extractionAttempts" INTEGER NOT NULL DEFAULT 0;

-- Add lease expiry for run-level concurrency control
ALTER TABLE "SyncRun" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
