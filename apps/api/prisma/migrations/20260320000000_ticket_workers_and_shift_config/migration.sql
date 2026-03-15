-- CreateTable
CREATE TABLE "ShiftConfig" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "shift" "Shift" NOT NULL,
    "startHour" INTEGER NOT NULL,
    "startMin" INTEGER NOT NULL DEFAULT 0,
    "endHour" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable (implicit many-to-many for Ticket <-> Worker via TicketResolvedWorkers)
CREATE TABLE "_TicketResolvedWorkers" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_TicketResolvedWorkers_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShiftConfig_orgId_shift_key" ON "ShiftConfig"("orgId", "shift");

-- CreateIndex
CREATE INDEX "ShiftConfig_orgId_idx" ON "ShiftConfig"("orgId");

-- CreateIndex
CREATE INDEX "_TicketResolvedWorkers_B_index" ON "_TicketResolvedWorkers"("B");

-- AddForeignKey
ALTER TABLE "ShiftConfig" ADD CONSTRAINT "ShiftConfig_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TicketResolvedWorkers" ADD CONSTRAINT "_TicketResolvedWorkers_A_fkey" FOREIGN KEY ("A") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TicketResolvedWorkers" ADD CONSTRAINT "_TicketResolvedWorkers_B_fkey" FOREIGN KEY ("B") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
