ALTER TABLE "AdminSession"
  ADD COLUMN "previousTokenValidUntil" TIMESTAMP(3),
  ADD COLUMN "rotationVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TYPE "AutomationJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "AutomationJobType" AS ENUM ('CONVERSATION_REPLY', 'CAMPAIGN_TARGET');

CREATE TABLE "AutomationJob" (
  "id" TEXT NOT NULL,
  "type" "AutomationJobType" NOT NULL,
  "status" "AutomationJobStatus" NOT NULL DEFAULT 'PENDING',
  "runAt" TIMESTAMP(3) NOT NULL,
  "contactId" TEXT,
  "conversationId" TEXT,
  "campaignId" TEXT,
  "campaignTargetId" TEXT,
  "messageId" TEXT,
  "payload" JSONB,
  "deduplicationKey" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AutomationJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AutomationJob_deduplicationKey_key" ON "AutomationJob"("deduplicationKey");
CREATE INDEX "AutomationJob_status_runAt_idx" ON "AutomationJob"("status", "runAt");
CREATE INDEX "AutomationJob_status_lockedAt_idx" ON "AutomationJob"("status", "lockedAt");
CREATE INDEX "AutomationJob_campaignId_status_idx" ON "AutomationJob"("campaignId", "status");
CREATE INDEX "AutomationJob_campaignTargetId_idx" ON "AutomationJob"("campaignTargetId");
CREATE INDEX "Contact_deletedAt_status_idx" ON "Contact"("deletedAt", "status");
CREATE INDEX "Contact_deletedAt_crmProvider_idx" ON "Contact"("deletedAt", "crmProvider");
CREATE INDEX "Contact_deletedAt_businessType_idx" ON "Contact"("deletedAt", "businessType");
CREATE INDEX "Contact_deletedAt_outreachEligible_idx" ON "Contact"("deletedAt", "outreachEligible");
CREATE INDEX "Contact_deletedAt_strategyCode_idx" ON "Contact"("deletedAt", "strategyCode");
CREATE INDEX "Contact_deletedAt_city_idx" ON "Contact"("deletedAt", "city");
