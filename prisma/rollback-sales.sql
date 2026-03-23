-- Emergency rollback: drops all Sales tables, preserves Content
-- Use only if Fresh Sales needs to be completely removed from the database.

DROP TABLE IF EXISTS "RecommendationAction" CASCADE;
DROP TABLE IF EXISTS "RecommendationEvidence" CASCADE;
DROP TABLE IF EXISTS "SalesDraft" CASCADE;
DROP TABLE IF EXISTS "SalesRecommendation" CASCADE;
DROP TABLE IF EXISTS "SalesExtractedFact" CASCADE;
DROP TABLE IF EXISTS "SalesSignal" CASCADE;
DROP TABLE IF EXISTS "DealContact" CASCADE;
DROP TABLE IF EXISTS "DealCompany" CASCADE;
DROP TABLE IF EXISTS "SalesActivity" CASCADE;
DROP TABLE IF EXISTS "SalesContact" CASCADE;
DROP TABLE IF EXISTS "SalesHubspotCompany" CASCADE;
DROP TABLE IF EXISTS "SalesDeal" CASCADE;
DROP TABLE IF EXISTS "SalesDoctrine" CASCADE;
