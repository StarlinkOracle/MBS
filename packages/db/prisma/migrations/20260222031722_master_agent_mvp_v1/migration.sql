-- CreateEnum
CREATE TYPE "CommsChannel" AS ENUM ('IMESSAGE', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "CommsDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "CommsStatus" AS ENUM ('RECEIVED', 'DRAFT', 'QUEUED_APPROVAL', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "CommsEntityType" AS ENUM ('CUSTOMER', 'LEAD', 'JOB', 'QUOTE');

-- DropIndex
DROP INDEX "EquipmentCatalogEntry_rawSku_trgm_idx";

-- DropIndex
DROP INDEX "EquipmentCatalogEntry_rawText_trgm_idx";

-- CreateTable
CREATE TABLE "CommsAccount" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "lastSyncAt" TIMESTAMP(3),
    "syncCursor" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommsAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommsThread" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channel" "CommsChannel" NOT NULL,
    "externalThreadId" TEXT,
    "participantsJson" JSONB NOT NULL,
    "subject" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommsThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommsMessage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "channel" "CommsChannel" NOT NULL,
    "direction" "CommsDirection" NOT NULL,
    "status" "CommsStatus" NOT NULL,
    "externalMessageId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "fromJson" JSONB NOT NULL,
    "toJson" JSONB NOT NULL,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "snippet" TEXT,
    "attachmentsJson" JSONB,
    "rawRef" JSONB,
    "triagedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommsEntityLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "entityType" "CommsEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommsEntityLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundDraft" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "channel" "CommsChannel" NOT NULL,
    "toJson" JSONB NOT NULL,
    "subject" TEXT,
    "bodyText" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "status" "CommsStatus" NOT NULL DEFAULT 'DRAFT',
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommsAccount_orgId_kind_idx" ON "CommsAccount"("orgId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "CommsAccount_orgId_kind_externalAccountId_key" ON "CommsAccount"("orgId", "kind", "externalAccountId");

-- CreateIndex
CREATE INDEX "CommsThread_orgId_channel_lastMessageAt_idx" ON "CommsThread"("orgId", "channel", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommsThread_orgId_channel_externalThreadId_key" ON "CommsThread"("orgId", "channel", "externalThreadId");

-- CreateIndex
CREATE INDEX "CommsMessage_orgId_threadId_sentAt_idx" ON "CommsMessage"("orgId", "threadId", "sentAt");

-- CreateIndex
CREATE INDEX "CommsMessage_orgId_status_triagedAt_sentAt_idx" ON "CommsMessage"("orgId", "status", "triagedAt", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommsMessage_orgId_channel_externalMessageId_key" ON "CommsMessage"("orgId", "channel", "externalMessageId");

-- CreateIndex
CREATE INDEX "CommsEntityLink_orgId_entityType_entityId_idx" ON "CommsEntityLink"("orgId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "CommsEntityLink_orgId_threadId_entityType_entityId_key" ON "CommsEntityLink"("orgId", "threadId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "OutboundDraft_orgId_status_createdAt_idx" ON "OutboundDraft"("orgId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "CommsAccount" ADD CONSTRAINT "CommsAccount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommsThread" ADD CONSTRAINT "CommsThread_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommsMessage" ADD CONSTRAINT "CommsMessage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommsMessage" ADD CONSTRAINT "CommsMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "CommsThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommsMessage" ADD CONSTRAINT "CommsMessage_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommsEntityLink" ADD CONSTRAINT "CommsEntityLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommsEntityLink" ADD CONSTRAINT "CommsEntityLink_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "CommsThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundDraft" ADD CONSTRAINT "OutboundDraft_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundDraft" ADD CONSTRAINT "OutboundDraft_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "CommsThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundDraft" ADD CONSTRAINT "OutboundDraft_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundDraft" ADD CONSTRAINT "OutboundDraft_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
