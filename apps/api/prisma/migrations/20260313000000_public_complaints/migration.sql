-- AlterTable: Make createdById optional for public complaints
ALTER TABLE "Ticket" ALTER COLUMN "createdById" DROP NOT NULL;

-- Add public complaint fields
ALTER TABLE "Ticket" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE "Ticket" ADD COLUMN "guestName" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "guestPhone" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "issueType" TEXT;

-- Index for filtering by source
CREATE INDEX "Ticket_orgId_source_idx" ON "Ticket"("orgId", "source");
