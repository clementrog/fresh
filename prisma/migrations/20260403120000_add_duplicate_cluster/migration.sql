-- CreateTable
CREATE TABLE "DuplicateCluster" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "memberIds" TEXT[],
    "decisionsJson" JSONB NOT NULL DEFAULT '{}',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "suppressionHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuplicateCluster_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateCluster_companyId_suppressionHash_key" ON "DuplicateCluster"("companyId", "suppressionHash");

-- CreateIndex
CREATE INDEX "DuplicateCluster_companyId_status_idx" ON "DuplicateCluster"("companyId", "status");

-- AddForeignKey
ALTER TABLE "DuplicateCluster" ADD CONSTRAINT "DuplicateCluster_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
