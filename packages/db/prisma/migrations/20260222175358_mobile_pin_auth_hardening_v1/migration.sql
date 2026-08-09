-- AlterTable
ALTER TABLE "User" ADD COLUMN     "employeeCode" TEXT,
ADD COLUMN     "mobilePinFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mobilePinHash" TEXT,
ADD COLUMN     "mobilePinLockedUntil" TIMESTAMP(3),
ADD COLUMN     "mobilePinResetRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mobilePinUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "phone" TEXT;

-- CreateIndex
CREATE INDEX "User_orgId_phone_idx" ON "User"("orgId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_orgId_employeeCode_key" ON "User"("orgId", "employeeCode");
