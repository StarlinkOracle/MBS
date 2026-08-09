-- CreateEnum
CREATE TYPE "SafetyMode" AS ENUM ('NORMAL', 'AUTONOMY_OFF', 'FULL_STOP');

-- AlterTable
ALTER TABLE "EventOutbox" ADD COLUMN     "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "ToolExecution" ADD COLUMN     "autonomyLevelAtExec" "AutonomyLevel",
ADD COLUMN     "contextSnapshotId" TEXT,
ADD COLUMN     "riskLevelAtExec" "RiskLevel";

-- CreateTable
CREATE TABLE "OrgSafetyState" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "mode" "SafetyMode" NOT NULL DEFAULT 'NORMAL',
    "reason" TEXT,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgSafetyState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialExposureDaily" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "bucket" TEXT NOT NULL,
    "usedCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialExposureDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrgSafetyState_orgId_key" ON "OrgSafetyState"("orgId");

-- CreateIndex
CREATE INDEX "OrgSafetyState_mode_updatedAt_idx" ON "OrgSafetyState"("mode", "updatedAt");

-- CreateIndex
CREATE INDEX "FinancialExposureDaily_orgId_date_idx" ON "FinancialExposureDaily"("orgId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialExposureDaily_orgId_date_bucket_key" ON "FinancialExposureDaily"("orgId", "date", "bucket");

-- CreateIndex
CREATE INDEX "EventOutbox_status_availableAt_idx" ON "EventOutbox"("status", "availableAt");

-- CreateIndex
CREATE INDEX "ToolExecution_contextSnapshotId_idx" ON "ToolExecution"("contextSnapshotId");

-- AddForeignKey
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_contextSnapshotId_fkey" FOREIGN KEY ("contextSnapshotId") REFERENCES "ContextSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgSafetyState" ADD CONSTRAINT "OrgSafetyState_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgSafetyState" ADD CONSTRAINT "OrgSafetyState_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialExposureDaily" ADD CONSTRAINT "FinancialExposureDaily_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
