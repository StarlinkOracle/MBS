-- CreateEnum
CREATE TYPE "LeadType" AS ENUM ('RESIDENTIAL_SINGLE', 'RESIDENTIAL_MULTI_PROPERTY', 'COMMERCIAL');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'APPOINTMENT_SET', 'ESTIMATE_SENT', 'WON', 'LOST', 'NURTURE');

-- CreateEnum
CREATE TYPE "LostOutcome" AS ENUM ('NO_CONTACT', 'NO_SHOW', 'PRICE', 'TIMING', 'COMPETITOR', 'NOT_A_FIT', 'DUPLICATE', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadSitePropertyType" AS ENUM ('RESIDENTIAL', 'COMMERCIAL');

-- CreateEnum
CREATE TYPE "RooftopAccessType" AS ENUM ('NONE', 'HATCH', 'LADDER', 'STAIRS', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "lastTouchAt" TIMESTAMP(3),
ADD COLUMN     "leadType" "LeadType" NOT NULL DEFAULT 'RESIDENTIAL_SINGLE',
ADD COLUMN     "lostNotes" TEXT,
ADD COLUMN     "lostOutcome" "LostOutcome",
ADD COLUMN     "nextTouchDueAt" TIMESTAMP(3),
ADD COLUMN     "nurtureConfig" JSONB,
ADD COLUMN     "ownerUserId" TEXT,
ADD COLUMN     "profile" JSONB,
ADD COLUMN     "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "description" TEXT,
ADD COLUMN     "isNextAction" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "TimelineEvent" ADD COLUMN     "requestId" TEXT;

-- CreateTable
CREATE TABLE "LeadSite" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "label" TEXT,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "propertyType" "LeadSitePropertyType",
    "units" INTEGER,
    "sqft" INTEGER,
    "yearBuilt" INTEGER,
    "rtuCount" INTEGER,
    "rooftopAccessType" "RooftopAccessType",
    "rooftopAccessNotes" TEXT,
    "siteNotes" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSlaPolicy" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "hoursByStage" JSONB NOT NULL,
    "dueSoonMinutes" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadSlaPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadSite_orgId_leadId_createdAt_idx" ON "LeadSite"("orgId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadSite_orgId_leadId_updatedAt_idx" ON "LeadSite"("orgId", "leadId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSite_orgId_leadId_requestId_key" ON "LeadSite"("orgId", "leadId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSlaPolicy_orgId_key" ON "LeadSlaPolicy"("orgId");

-- CreateIndex
CREATE INDEX "Lead_orgId_leadType_stage_idx" ON "Lead"("orgId", "leadType", "stage");

-- CreateIndex
CREATE INDEX "Lead_orgId_nextTouchDueAt_idx" ON "Lead"("orgId", "nextTouchDueAt");

-- CreateIndex
CREATE INDEX "Lead_ownerUserId_stage_idx" ON "Lead"("ownerUserId", "stage");

-- CreateIndex
CREATE INDEX "Task_orgId_leadId_isNextAction_status_dueAt_idx" ON "Task"("orgId", "leadId", "isNextAction", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Task_orgId_leadId_requestId_key" ON "Task"("orgId", "leadId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "TimelineEvent_orgId_leadId_type_requestId_key" ON "TimelineEvent"("orgId", "leadId", "type", "requestId");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSite" ADD CONSTRAINT "LeadSite_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSite" ADD CONSTRAINT "LeadSite_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSlaPolicy" ADD CONSTRAINT "LeadSlaPolicy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

