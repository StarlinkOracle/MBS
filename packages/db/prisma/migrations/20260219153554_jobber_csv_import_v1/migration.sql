-- CreateEnum
CREATE TYPE "ImportProvider" AS ENUM ('JOBBER');

-- CreateEnum
CREATE TYPE "ImportMode" AS ENUM ('CSV');

-- CreateEnum
CREATE TYPE "ImportRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ImportRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" "ImportProvider" NOT NULL,
    "mode" "ImportMode" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "status" "ImportRunStatus" NOT NULL DEFAULT 'QUEUED',
    "cursorState" JSONB,
    "stats" JSONB,
    "lastError" TEXT,
    "options" JSONB,
    "startedByUserId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceMapping" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" "ImportProvider" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "mbsType" TEXT NOT NULL,
    "mbsId" TEXT NOT NULL,
    "rawHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceRaw" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" "ImportProvider" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "importRunId" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceRaw_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportRun_orgId_provider_status_createdAt_idx" ON "ImportRun"("orgId", "provider", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ImportRun_orgId_provider_sourceType_createdAt_idx" ON "ImportRun"("orgId", "provider", "sourceType", "createdAt");

-- CreateIndex
CREATE INDEX "SourceMapping_orgId_provider_mbsType_mbsId_idx" ON "SourceMapping"("orgId", "provider", "mbsType", "mbsId");

-- CreateIndex
CREATE INDEX "SourceMapping_orgId_provider_sourceType_lastSeenAt_idx" ON "SourceMapping"("orgId", "provider", "sourceType", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourceMapping_orgId_provider_sourceType_sourceId_key" ON "SourceMapping"("orgId", "provider", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "SourceRaw_orgId_provider_sourceType_fetchedAt_idx" ON "SourceRaw"("orgId", "provider", "sourceType", "fetchedAt");

-- CreateIndex
CREATE INDEX "SourceRaw_importRunId_idx" ON "SourceRaw"("importRunId");

-- CreateIndex
CREATE INDEX "SourceRaw_orgId_provider_sourceType_sourceId_fetchedAt_idx" ON "SourceRaw"("orgId", "provider", "sourceType", "sourceId", "fetchedAt");

-- AddForeignKey
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_startedByUserId_fkey" FOREIGN KEY ("startedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceMapping" ADD CONSTRAINT "SourceMapping_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceRaw" ADD CONSTRAINT "SourceRaw_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceRaw" ADD CONSTRAINT "SourceRaw_importRunId_fkey" FOREIGN KEY ("importRunId") REFERENCES "ImportRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
