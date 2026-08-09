-- CreateEnum
CREATE TYPE "QuoteBookingTriggerStatus" AS ENUM ('SENT', 'ACCEPTED');

-- CreateEnum
CREATE TYPE "AppointmentType" AS ENUM ('SERVICE_ESTIMATE', 'INSTALL');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('TENTATIVE', 'BOOKED', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "TimeBlockCode" AS ENUM ('BLOCK_0800_1000', 'BLOCK_1000_1200', 'BLOCK_1200_1400', 'BLOCK_1400_1600');

-- DropIndex

-- DropIndex

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "jobLatitude" DOUBLE PRECISION,
ADD COLUMN     "jobLongitude" DOUBLE PRECISION,
ADD COLUMN     "quoteId" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "attributionSnapshot" JSONB,
ADD COLUMN     "stage" TEXT NOT NULL DEFAULT 'NEW';

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "acceptanceNotes" TEXT,
ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "acceptedByName" TEXT,
ADD COLUMN     "acceptedIpHash" TEXT,
ADD COLUMN     "publicToken" TEXT,
ADD COLUMN     "publicTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leadId" TEXT,
    "customerId" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'NEW',
    "valueCents" INTEGER NOT NULL DEFAULT 0,
    "assignedToUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgSchedulingSettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Denver',
    "defaultServiceCapacityPerBlock" INTEGER NOT NULL DEFAULT 2,
    "defaultInstallCapacityPerBlock" INTEGER NOT NULL DEFAULT 2,
    "throttleServiceCapacityPerBlock" INTEGER NOT NULL DEFAULT 1,
    "throttleInstallCapacityPerBlock" INTEGER NOT NULL DEFAULT 1,
    "throttleServiceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "throttleInstallEnabled" BOOLEAN NOT NULL DEFAULT false,
    "serviceBookingAllowedAt" "QuoteBookingTriggerStatus" NOT NULL DEFAULT 'SENT',
    "installBookingAllowedAt" "QuoteBookingTriggerStatus" NOT NULL DEFAULT 'ACCEPTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgSchedulingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessHours" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "openTime" TEXT NOT NULL,
    "closeTime" TEXT NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlackoutDate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlackoutDate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeBlockTemplate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" "TimeBlockCode" NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeBlockTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "quoteId" TEXT,
    "jobId" TEXT,
    "customerId" TEXT,
    "type" "AppointmentType" NOT NULL,
    "date" DATE NOT NULL,
    "timeBlockCode" "TimeBlockCode" NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
    "assignedTechId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentReservation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "timeBlockCode" "TimeBlockCode" NOT NULL,
    "type" "AppointmentType" NOT NULL,
    "reservedCount" INTEGER NOT NULL DEFAULT 0,
    "capacity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Opportunity_orgId_stage_updatedAt_idx" ON "Opportunity"("orgId", "stage", "updatedAt");

-- CreateIndex
CREATE INDEX "Opportunity_orgId_assignedToUserId_idx" ON "Opportunity"("orgId", "assignedToUserId");

-- CreateIndex
CREATE INDEX "Opportunity_leadId_idx" ON "Opportunity"("leadId");

-- CreateIndex
CREATE INDEX "Opportunity_customerId_idx" ON "Opportunity"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgSchedulingSettings_orgId_key" ON "OrgSchedulingSettings"("orgId");

-- CreateIndex
CREATE INDEX "BusinessHours_orgId_dayOfWeek_idx" ON "BusinessHours"("orgId", "dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessHours_orgId_dayOfWeek_key" ON "BusinessHours"("orgId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "BlackoutDate_orgId_startAt_endAt_idx" ON "BlackoutDate"("orgId", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "TimeBlockTemplate_orgId_active_idx" ON "TimeBlockTemplate"("orgId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "TimeBlockTemplate_orgId_code_key" ON "TimeBlockTemplate"("orgId", "code");

-- CreateIndex
CREATE INDEX "Appointment_orgId_date_timeBlockCode_type_idx" ON "Appointment"("orgId", "date", "timeBlockCode", "type");

-- CreateIndex
CREATE INDEX "Appointment_orgId_status_date_idx" ON "Appointment"("orgId", "status", "date");

-- CreateIndex
CREATE INDEX "Appointment_quoteId_idx" ON "Appointment"("quoteId");

-- CreateIndex
CREATE INDEX "Appointment_jobId_idx" ON "Appointment"("jobId");

-- CreateIndex
CREATE INDEX "Appointment_customerId_idx" ON "Appointment"("customerId");

-- CreateIndex
CREATE INDEX "AppointmentReservation_orgId_date_timeBlockCode_idx" ON "AppointmentReservation"("orgId", "date", "timeBlockCode");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentReservation_orgId_date_timeBlockCode_type_key" ON "AppointmentReservation"("orgId", "date", "timeBlockCode", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Job_quoteId_key" ON "Job"("quoteId");

-- CreateIndex
CREATE INDEX "Lead_orgId_stage_idx" ON "Lead"("orgId", "stage");

-- CreateIndex
CREATE INDEX "Quote_orgId_publicToken_idx" ON "Quote"("orgId", "publicToken");

-- CreateIndex
CREATE INDEX "Quote_orgId_sentAt_idx" ON "Quote"("orgId", "sentAt");

-- CreateIndex
CREATE INDEX "Quote_orgId_acceptedAt_idx" ON "Quote"("orgId", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_orgId_publicToken_key" ON "Quote"("orgId", "publicToken");

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgSchedulingSettings" ADD CONSTRAINT "OrgSchedulingSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessHours" ADD CONSTRAINT "BusinessHours_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackoutDate" ADD CONSTRAINT "BlackoutDate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeBlockTemplate" ADD CONSTRAINT "TimeBlockTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_assignedTechId_fkey" FOREIGN KEY ("assignedTechId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentReservation" ADD CONSTRAINT "AppointmentReservation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

