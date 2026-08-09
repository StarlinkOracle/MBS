-- CreateEnum
CREATE TYPE "WebsiteIntakeType" AS ENUM ('CONTACT', 'PRICE_MATCH');

-- CreateEnum
CREATE TYPE "WebsiteIntakeStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttachmentRefProvider" AS ENUM ('S3', 'URL');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "leadSource" TEXT;

-- AlterTable
ALTER TABLE "MarketingMetricDaily" ALTER COLUMN "id" DROP DEFAULT,
ADD CONSTRAINT "MarketingMetricDaily_pkey" PRIMARY KEY ("id");

-- CreateTable
CREATE TABLE "WebsiteIntakeEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leadId" TEXT,
    "type" "WebsiteIntakeType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebsiteIntakeStatus" NOT NULL DEFAULT 'RECEIVED',
    "errorMessage" TEXT,
    "sourceIpHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebsiteIntakeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leadId" TEXT,
    "kind" TEXT NOT NULL,
    "queue" TEXT NOT NULL DEFAULT 'SALES',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttachmentRef" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" "AttachmentRefProvider" NOT NULL,
    "bucket" TEXT,
    "objectKey" TEXT,
    "url" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "checksumSha256" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttachmentRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceMatchRequest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "competitorName" TEXT NOT NULL,
    "competitorPriceCents" INTEGER,
    "notes" TEXT,
    "serviceType" TEXT,
    "attachmentRefId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceMatchRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimelineEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebsiteIntakeEvent_orgId_type_createdAt_idx" ON "WebsiteIntakeEvent"("orgId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "WebsiteIntakeEvent_orgId_status_createdAt_idx" ON "WebsiteIntakeEvent"("orgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "WebsiteIntakeEvent_leadId_idx" ON "WebsiteIntakeEvent"("leadId");

-- CreateIndex
CREATE INDEX "Task_orgId_queue_status_dueAt_idx" ON "Task"("orgId", "queue", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_orgId_leadId_createdAt_idx" ON "Task"("orgId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_assignedToUserId_status_idx" ON "Task"("assignedToUserId", "status");

-- CreateIndex
CREATE INDEX "AttachmentRef_orgId_createdAt_idx" ON "AttachmentRef"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "PriceMatchRequest_orgId_leadId_createdAt_idx" ON "PriceMatchRequest"("orgId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "PriceMatchRequest_orgId_createdAt_idx" ON "PriceMatchRequest"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "TimelineEvent_orgId_leadId_createdAt_idx" ON "TimelineEvent"("orgId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "TimelineEvent_orgId_type_createdAt_idx" ON "TimelineEvent"("orgId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_orgId_email_idx" ON "Lead"("orgId", "email");

-- CreateIndex
CREATE INDEX "Lead_orgId_phone_idx" ON "Lead"("orgId", "phone");

-- CreateIndex
CREATE INDEX "MarketingMetricDaily_orgId_date_idx" ON "MarketingMetricDaily"("orgId", "date");

-- CreateIndex
CREATE INDEX "MarketingMetricDaily_orgId_zip_idx" ON "MarketingMetricDaily"("orgId", "zip");

-- AddForeignKey
ALTER TABLE "WebsiteIntakeEvent" ADD CONSTRAINT "WebsiteIntakeEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteIntakeEvent" ADD CONSTRAINT "WebsiteIntakeEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachmentRef" ADD CONSTRAINT "AttachmentRef_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceMatchRequest" ADD CONSTRAINT "PriceMatchRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceMatchRequest" ADD CONSTRAINT "PriceMatchRequest_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceMatchRequest" ADD CONSTRAINT "PriceMatchRequest_attachmentRefId_fkey" FOREIGN KEY ("attachmentRefId") REFERENCES "AttachmentRef"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingMetricDaily" ADD CONSTRAINT "MarketingMetricDaily_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
