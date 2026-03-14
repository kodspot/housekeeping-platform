-- Add expanded worker fields
ALTER TABLE "Worker" ADD COLUMN "employeeId" TEXT;
ALTER TABLE "Worker" ADD COLUMN "email" TEXT;
ALTER TABLE "Worker" ADD COLUMN "address" TEXT;
ALTER TABLE "Worker" ADD COLUMN "department" TEXT;
ALTER TABLE "Worker" ADD COLUMN "designation" TEXT;
ALTER TABLE "Worker" ADD COLUMN "dateOfBirth" TIMESTAMP(3);
ALTER TABLE "Worker" ADD COLUMN "dateOfJoin" TIMESTAMP(3);
ALTER TABLE "Worker" ADD COLUMN "gender" TEXT;
ALTER TABLE "Worker" ADD COLUMN "bloodGroup" TEXT;
ALTER TABLE "Worker" ADD COLUMN "aadharNo" TEXT;
ALTER TABLE "Worker" ADD COLUMN "notes" TEXT;

-- Unique constraint: no duplicate names within same org
CREATE UNIQUE INDEX "Worker_orgId_name_key" ON "Worker"("orgId", "name");

-- Unique constraint: no duplicate employee IDs within same org
CREATE UNIQUE INDEX "Worker_orgId_employeeId_key" ON "Worker"("orgId", "employeeId");
