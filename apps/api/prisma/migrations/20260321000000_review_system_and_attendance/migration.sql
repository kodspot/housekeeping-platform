-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LEAVE', 'HALF_DAY');

-- AlterTable: Add review fields to Ticket
ALTER TABLE "Ticket" ADD COLUMN "reviewToken" TEXT,
ADD COLUMN "reviewExpiresAt" TIMESTAMP(3),
ADD COLUMN "reviewStatus" TEXT,
ADD COLUMN "reviewNote" TEXT,
ADD COLUMN "reviewedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_reviewToken_key" ON "Ticket"("reviewToken");

-- CreateTable
CREATE TABLE "WorkerAssignment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "markedById" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "shift" "Shift" NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: WorkerAssignment
CREATE UNIQUE INDEX "WorkerAssignment_workerId_locationId_key" ON "WorkerAssignment"("workerId", "locationId");
CREATE INDEX "WorkerAssignment_orgId_idx" ON "WorkerAssignment"("orgId");
CREATE INDEX "WorkerAssignment_locationId_idx" ON "WorkerAssignment"("locationId");
CREATE INDEX "WorkerAssignment_workerId_idx" ON "WorkerAssignment"("workerId");

-- CreateIndex: Attendance
CREATE UNIQUE INDEX "Attendance_workerId_date_shift_key" ON "Attendance"("workerId", "date", "shift");
CREATE INDEX "Attendance_orgId_date_idx" ON "Attendance"("orgId", "date");
CREATE INDEX "Attendance_workerId_date_idx" ON "Attendance"("workerId", "date");
CREATE INDEX "Attendance_markedById_idx" ON "Attendance"("markedById");

-- AddForeignKey
ALTER TABLE "WorkerAssignment" ADD CONSTRAINT "WorkerAssignment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkerAssignment" ADD CONSTRAINT "WorkerAssignment_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkerAssignment" ADD CONSTRAINT "WorkerAssignment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_markedById_fkey" FOREIGN KEY ("markedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
