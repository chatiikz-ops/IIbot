-- CreateEnum
CREATE TYPE "AutomationEventType" AS ENUM ('INCOMING_RECEIVED', 'AUTO_REPLY_SCHEDULED', 'AUTO_REPLY_STARTED', 'AI_COMPLETED', 'AI_FAILED', 'WHATSAPP_SENT', 'WHATSAPP_FAILED', 'SKIPPED', 'DEFERRED', 'HANDOFF', 'QUALIFIED', 'REJECTED');

-- AlterTable
ALTER TABLE "CampaignTarget" ADD COLUMN "conversationId" TEXT;

-- CreateTable
CREATE TABLE "AutomationSettings" (
    "id" TEXT NOT NULL,
    "singletonKey" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "campaignSendingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxAutoRepliesPerConversation" INTEGER NOT NULL DEFAULT 5,
    "responseDelayMinSeconds" INTEGER NOT NULL DEFAULT 3,
    "responseDelayMaxSeconds" INTEGER NOT NULL DEFAULT 8,
    "workingHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
    "workingHoursStart" TEXT,
    "workingHoursEnd" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Almaty',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationEvent" (
    "id" TEXT NOT NULL,
    "type" "AutomationEventType" NOT NULL,
    "contactId" TEXT,
    "conversationId" TEXT,
    "messageId" TEXT,
    "aiRunId" TEXT,
    "whatsAppMessageId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutomationSettings_singletonKey_key" ON "AutomationSettings"("singletonKey");

-- CreateIndex
CREATE INDEX "AutomationEvent_conversationId_createdAt_idx" ON "AutomationEvent"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AutomationEvent_type_createdAt_idx" ON "AutomationEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "AutomationEvent_createdAt_idx" ON "AutomationEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignTarget_conversationId_key" ON "CampaignTarget"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_messageId_key" ON "WhatsAppMessage"("messageId");

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
