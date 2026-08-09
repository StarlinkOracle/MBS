-- CreateEnum
CREATE TYPE "MediaUploadSessionStatus" AS ENUM ('INITIATED', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "MediaUploadSession" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "status" "MediaUploadSessionStatus" NOT NULL DEFAULT 'INITIATED',
    "ownerType" "AttachmentOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "tag" "AttachmentTag" NOT NULL DEFAULT 'OTHER',
    "caption" TEXT,
    "attachmentId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "checksumSha256" TEXT,
    "bucket" TEXT,
    "objectKey" TEXT,
    "displayObjectKey" TEXT,
    "thumbObjectKey" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaUploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaUploadSession_orgId_sessionKey_key" ON "MediaUploadSession"("orgId", "sessionKey");

-- CreateIndex
CREATE INDEX "MediaUploadSession_orgId_status_createdAt_idx" ON "MediaUploadSession"("orgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MediaUploadSession_orgId_ownerType_ownerId_createdAt_idx" ON "MediaUploadSession"("orgId", "ownerType", "ownerId", "createdAt");

-- AddForeignKey
ALTER TABLE "MediaUploadSession" ADD CONSTRAINT "MediaUploadSession_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaUploadSession" ADD CONSTRAINT "MediaUploadSession_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
