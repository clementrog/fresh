-- CreateTable
CREATE TABLE "SalesDeal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "hubspotDealId" TEXT NOT NULL,
    "dealName" TEXT NOT NULL,
    "pipeline" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "amount" DOUBLE PRECISION,
    "ownerEmail" TEXT,
    "hubspotOwnerId" TEXT,
    "lastActivityDate" TIMESTAMP(3),
    "closeDateExpected" TIMESTAMP(3),
    "propertiesJson" JSONB NOT NULL DEFAULT '{}',
    "staleDays" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesDeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesContact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "hubspotContactId" TEXT NOT NULL,
    "email" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "title" TEXT,
    "company" TEXT,
    "propertiesJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesHubspotCompany" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "hubspotCompanyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "industry" TEXT,
    "size" TEXT,
    "propertiesJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesHubspotCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealContact" (
    "dealId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,

    CONSTRAINT "DealContact_pkey" PRIMARY KEY ("dealId","contactId")
);

-- CreateTable
CREATE TABLE "DealCompany" (
    "dealId" TEXT NOT NULL,
    "salesCompanyId" TEXT NOT NULL,

    CONSTRAINT "DealCompany_pkey" PRIMARY KEY ("dealId","salesCompanyId")
);

-- CreateTable
CREATE TABLE "SalesActivity" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "hubspotEngagementId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "dealId" TEXT,
    "contactId" TEXT,
    "extractedAt" TIMESTAMP(3),
    "rawTextExpiresAt" TIMESTAMP(3),
    "rawTextCleaned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesSignal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sourceItemId" TEXT,
    "dealId" TEXT,
    "confidence" TEXT NOT NULL,
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "matchedAt" TIMESTAMP(3),
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesExtractedFact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "activityId" TEXT,
    "dealId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "extractedValue" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "sourceText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesExtractedFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesRecommendation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "userId" TEXT,
    "whyNow" TEXT NOT NULL,
    "recommendedAngle" TEXT NOT NULL,
    "nextStepType" TEXT NOT NULL,
    "matchedContextJson" JSONB NOT NULL DEFAULT '{}',
    "confidence" TEXT NOT NULL,
    "priorityRank" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'new',
    "dismissReason" TEXT,
    "snoozedUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationEvidence" (
    "recommendationId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "relevanceNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationEvidence_pkey" PRIMARY KEY ("recommendationId","evidenceId")
);

-- CreateTable
CREATE TABLE "RecommendationAction" (
    "id" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "userId" TEXT,
    "actionType" TEXT NOT NULL,
    "reason" TEXT,
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDraft" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "channelType" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "repProfileId" TEXT,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDoctrine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "doctrineJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesDoctrine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesDeal_companyId_stage_idx" ON "SalesDeal"("companyId", "stage");

-- CreateIndex
CREATE INDEX "SalesDeal_companyId_staleDays_idx" ON "SalesDeal"("companyId", "staleDays");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDeal_companyId_hubspotDealId_key" ON "SalesDeal"("companyId", "hubspotDealId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesContact_companyId_hubspotContactId_key" ON "SalesContact"("companyId", "hubspotContactId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesHubspotCompany_companyId_hubspotCompanyId_key" ON "SalesHubspotCompany"("companyId", "hubspotCompanyId");

-- CreateIndex
CREATE INDEX "SalesActivity_companyId_dealId_idx" ON "SalesActivity"("companyId", "dealId");

-- CreateIndex
CREATE INDEX "SalesActivity_extractedAt_idx" ON "SalesActivity"("extractedAt");

-- CreateIndex
CREATE INDEX "SalesActivity_rawTextCleaned_rawTextExpiresAt_idx" ON "SalesActivity"("rawTextCleaned", "rawTextExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SalesActivity_companyId_hubspotEngagementId_key" ON "SalesActivity"("companyId", "hubspotEngagementId");

-- CreateIndex
CREATE INDEX "SalesSignal_companyId_signalType_idx" ON "SalesSignal"("companyId", "signalType");

-- CreateIndex
CREATE INDEX "SalesSignal_companyId_matchedAt_idx" ON "SalesSignal"("companyId", "matchedAt");

-- CreateIndex
CREATE INDEX "SalesSignal_companyId_detectedAt_idx" ON "SalesSignal"("companyId", "detectedAt");

-- CreateIndex
CREATE INDEX "SalesExtractedFact_companyId_dealId_idx" ON "SalesExtractedFact"("companyId", "dealId");

-- CreateIndex
CREATE INDEX "SalesExtractedFact_companyId_category_idx" ON "SalesExtractedFact"("companyId", "category");

-- CreateIndex
CREATE INDEX "SalesRecommendation_companyId_status_idx" ON "SalesRecommendation"("companyId", "status");

-- CreateIndex
CREATE INDEX "SalesRecommendation_companyId_dealId_idx" ON "SalesRecommendation"("companyId", "dealId");

-- CreateIndex
CREATE INDEX "SalesRecommendation_companyId_userId_status_idx" ON "SalesRecommendation"("companyId", "userId", "status");

-- CreateIndex
CREATE INDEX "SalesRecommendation_companyId_priorityRank_idx" ON "SalesRecommendation"("companyId", "priorityRank");

-- CreateIndex
CREATE INDEX "RecommendationAction_recommendationId_actionType_idx" ON "RecommendationAction"("recommendationId", "actionType");

-- CreateIndex
CREATE INDEX "RecommendationAction_recommendationId_createdAt_idx" ON "RecommendationAction"("recommendationId", "createdAt");

-- CreateIndex
CREATE INDEX "SalesDraft_companyId_recommendationId_idx" ON "SalesDraft"("companyId", "recommendationId");

-- CreateIndex
CREATE INDEX "SalesDoctrine_companyId_idx" ON "SalesDoctrine"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDoctrine_companyId_version_key" ON "SalesDoctrine"("companyId", "version");

-- AddForeignKey
ALTER TABLE "SalesDeal" ADD CONSTRAINT "SalesDeal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesContact" ADD CONSTRAINT "SalesContact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesHubspotCompany" ADD CONSTRAINT "SalesHubspotCompany_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealContact" ADD CONSTRAINT "DealContact_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "SalesDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealContact" ADD CONSTRAINT "DealContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "SalesContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealCompany" ADD CONSTRAINT "DealCompany_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "SalesDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealCompany" ADD CONSTRAINT "DealCompany_salesCompanyId_fkey" FOREIGN KEY ("salesCompanyId") REFERENCES "SalesHubspotCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesActivity" ADD CONSTRAINT "SalesActivity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesActivity" ADD CONSTRAINT "SalesActivity_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "SalesDeal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesActivity" ADD CONSTRAINT "SalesActivity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "SalesContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesSignal" ADD CONSTRAINT "SalesSignal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesSignal" ADD CONSTRAINT "SalesSignal_sourceItemId_fkey" FOREIGN KEY ("sourceItemId") REFERENCES "SourceItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesSignal" ADD CONSTRAINT "SalesSignal_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "SalesDeal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesExtractedFact" ADD CONSTRAINT "SalesExtractedFact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesExtractedFact" ADD CONSTRAINT "SalesExtractedFact_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "SalesActivity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesExtractedFact" ADD CONSTRAINT "SalesExtractedFact_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "SalesDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesRecommendation" ADD CONSTRAINT "SalesRecommendation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesRecommendation" ADD CONSTRAINT "SalesRecommendation_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "SalesDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesRecommendation" ADD CONSTRAINT "SalesRecommendation_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "SalesSignal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesRecommendation" ADD CONSTRAINT "SalesRecommendation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationEvidence" ADD CONSTRAINT "RecommendationEvidence_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "SalesRecommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationEvidence" ADD CONSTRAINT "RecommendationEvidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "EvidenceReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationAction" ADD CONSTRAINT "RecommendationAction_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "SalesRecommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationAction" ADD CONSTRAINT "RecommendationAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDraft" ADD CONSTRAINT "SalesDraft_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDraft" ADD CONSTRAINT "SalesDraft_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "SalesRecommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDoctrine" ADD CONSTRAINT "SalesDoctrine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

