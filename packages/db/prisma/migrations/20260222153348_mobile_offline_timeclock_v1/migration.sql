-- CreateEnum
CREATE TYPE "ClientActionStatus" AS ENUM ('PENDING', 'APPLIED', 'FAILED');

-- CreateEnum
CREATE TYPE "MobileSyncCursorType" AS ENUM ('AUDITLOG', 'OUTBOX');

-- CreateEnum
CREATE TYPE "TimeEntryType" AS ENUM ('SHIFT', 'BREAK', 'JOB');

-- CreateEnum
CREATE TYPE "TimeEntryStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "TimeEditRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "ToolExecution" ADD COLUMN     "clientActionId" TEXT;

-- CreateTable
CREATE TABLE "MobileClient" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceName" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientAction" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "clientActionId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "status" "ClientActionStatus" NOT NULL DEFAULT 'PENDING',
    "resultJson" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "ClientAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileSyncCursor" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "cursorType" "MobileSyncCursorType" NOT NULL,
    "cursorValue" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileSyncCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "TimeEntryType" NOT NULL,
    "jobId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "startedAtLocal" TEXT,
    "endedAtLocal" TEXT,
    "timezoneOffsetMinutes" INTEGER,
    "notes" TEXT,
    "status" "TimeEntryStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEditRequest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timeEntryId" TEXT NOT NULL,
    "requestedChangesJson" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "TimeEditRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeEditRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MobileClient_orgId_userId_lastSeenAt_idx" ON "MobileClient"("orgId", "userId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "MobileClient_orgId_userId_deviceId_key" ON "MobileClient"("orgId", "userId", "deviceId");

-- CreateIndex
CREATE INDEX "ClientAction_orgId_userId_createdAt_idx" ON "ClientAction"("orgId", "userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientAction_orgId_userId_deviceId_clientActionId_key" ON "ClientAction"("orgId", "userId", "deviceId", "clientActionId");

-- CreateIndex
CREATE INDEX "MobileSyncCursor_orgId_userId_cursorType_idx" ON "MobileSyncCursor"("orgId", "userId", "cursorType");

-- CreateIndex
CREATE UNIQUE INDEX "MobileSyncCursor_orgId_userId_deviceId_cursorType_key" ON "MobileSyncCursor"("orgId", "userId", "deviceId", "cursorType");

-- CreateIndex
CREATE INDEX "TimeEntry_orgId_userId_status_idx" ON "TimeEntry"("orgId", "userId", "status");

-- CreateIndex
CREATE INDEX "TimeEntry_orgId_jobId_idx" ON "TimeEntry"("orgId", "jobId");

-- CreateIndex
CREATE INDEX "TimeEntry_orgId_userId_startedAt_idx" ON "TimeEntry"("orgId", "userId", "startedAt");

-- CreateIndex
CREATE INDEX "TimeEditRequest_orgId_status_createdAt_idx" ON "TimeEditRequest"("orgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TimeEditRequest_orgId_userId_createdAt_idx" ON "TimeEditRequest"("orgId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolExecution_orgId_clientActionId_idx" ON "ToolExecution"("orgId", "clientActionId");

-- AddForeignKey
ALTER TABLE "MobileClient" ADD CONSTRAINT "MobileClient_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileClient" ADD CONSTRAINT "MobileClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientAction" ADD CONSTRAINT "ClientAction_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientAction" ADD CONSTRAINT "ClientAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileSyncCursor" ADD CONSTRAINT "MobileSyncCursor_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileSyncCursor" ADD CONSTRAINT "MobileSyncCursor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEditRequest" ADD CONSTRAINT "TimeEditRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEditRequest" ADD CONSTRAINT "TimeEditRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEditRequest" ADD CONSTRAINT "TimeEditRequest_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEditRequest" ADD CONSTRAINT "TimeEditRequest_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
