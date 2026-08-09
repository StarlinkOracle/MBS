-- CreateEnum
CREATE TYPE "AttachmentOwnerType" AS ENUM ('QUOTE', 'JOB');

-- CreateEnum
CREATE TYPE "AttachmentTag" AS ENUM ('BEFORE', 'AFTER', 'EQUIPMENT_PLATE', 'RECEIPT', 'PROBLEM', 'INSTALL', 'OTHER');

-- AlterEnum
ALTER TYPE "AttachmentKind" ADD VALUE 'QUOTE_PHOTO';

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "caption" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "displayObjectKey" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "ownerType" "AttachmentOwnerType",
ADD COLUMN     "publicToken" TEXT,
ADD COLUMN     "tag" "AttachmentTag" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "thumbObjectKey" TEXT,
ADD COLUMN     "width" INTEGER;

-- CreateIndex
CREATE INDEX "Attachment_expiresAt_idx" ON "Attachment"("expiresAt");

-- CreateIndex
CREATE INDEX "Attachment_orgId_ownerType_ownerId_idx" ON "Attachment"("orgId", "ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "Attachment_orgId_ownerType_ownerId_isPublic_idx" ON "Attachment"("orgId", "ownerType", "ownerId", "isPublic");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_publicToken_key" ON "Attachment"("publicToken");

