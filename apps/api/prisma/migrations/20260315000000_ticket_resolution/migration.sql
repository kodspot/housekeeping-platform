-- Add resolution fields to Ticket
ALTER TABLE "Ticket" ADD COLUMN "resolvedImageUrl" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "resolvedNote" TEXT;
