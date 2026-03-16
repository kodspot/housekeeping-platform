-- CreateTable
CREATE TABLE "DutyRoster" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "shift" "Shift" NOT NULL,
    "locationId" TEXT NOT NULL,
    "supervisorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DutyRoster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DutyRosterWorker" (
    "id" TEXT NOT NULL,
    "rosterId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,

    CONSTRAINT "DutyRosterWorker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DutyRoster_orgId_date_shift_supervisorId_key" ON "DutyRoster"("orgId", "date", "shift", "supervisorId");
CREATE INDEX "DutyRoster_orgId_date_idx" ON "DutyRoster"("orgId", "date");
CREATE INDEX "DutyRoster_orgId_date_shift_locationId_idx" ON "DutyRoster"("orgId", "date", "shift", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "DutyRosterWorker_rosterId_workerId_key" ON "DutyRosterWorker"("rosterId", "workerId");
CREATE INDEX "DutyRosterWorker_workerId_idx" ON "DutyRosterWorker"("workerId");

-- AddForeignKey
ALTER TABLE "DutyRoster" ADD CONSTRAINT "DutyRoster_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DutyRoster" ADD CONSTRAINT "DutyRoster_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DutyRoster" ADD CONSTRAINT "DutyRoster_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DutyRosterWorker" ADD CONSTRAINT "DutyRosterWorker_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "DutyRoster"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DutyRosterWorker" ADD CONSTRAINT "DutyRosterWorker_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
