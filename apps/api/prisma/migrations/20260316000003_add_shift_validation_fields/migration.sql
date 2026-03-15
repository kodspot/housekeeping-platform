-- AlterTable: Add shift validation tracking columns
ALTER TABLE "CleaningRecord" ADD COLUMN "expectedShift" "Shift";
ALTER TABLE "CleaningRecord" ADD COLUMN "isLate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CleaningRecord" ADD COLUMN "lateReason" TEXT;
