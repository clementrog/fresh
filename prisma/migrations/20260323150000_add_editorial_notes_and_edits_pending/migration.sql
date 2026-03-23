-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN "editorialNotes" TEXT DEFAULT '',
ADD COLUMN "notionEditsPending" BOOLEAN NOT NULL DEFAULT false;
