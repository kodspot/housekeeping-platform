-- AlterTable: Add slug column to Organization
ALTER TABLE "Organization" ADD COLUMN "slug" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- Remove default after migration
ALTER TABLE "Organization" ALTER COLUMN "slug" DROP DEFAULT;
