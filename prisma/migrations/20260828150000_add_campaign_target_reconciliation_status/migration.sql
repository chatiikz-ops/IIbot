-- A transport submission with an ambiguous or rejected provider outcome must
-- not be represented as WAITING_REPLY and must not be retried automatically.
ALTER TYPE "CampaignTargetStatus" ADD VALUE IF NOT EXISTS 'RECONCILIATION_REQUIRED';

ALTER TABLE "WhatsAppMessage" ADD COLUMN "correlationId" TEXT;
CREATE UNIQUE INDEX "WhatsAppMessage_correlationId_key"
  ON "WhatsAppMessage"("correlationId");
