-- CreateEnum
CREATE TYPE "TelegramRecipientStatus" AS ENUM ('PENDING', 'CONNECTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "TelegramNotificationType" AS ENUM ('HANDOFF_REQUIRED', 'CLIENT_REQUESTED_MANAGER', 'NEW_LEAD', 'QUALIFIED_LEAD', 'AI_UNCERTAIN', 'AI_FAILED', 'WHATSAPP_FAILED', 'MEDIA_FAILED', 'AUTOMATION_FAILED', 'SYSTEM_ERROR');

-- CreateEnum
CREATE TYPE "TelegramNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "preferredLanguage" TEXT;

-- CreateTable
CREATE TABLE "TelegramRecipient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TelegramRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "telegramUserId" BIGINT,
    "telegramChatId" BIGINT,
    "telegramUsername" TEXT,
    "telegramFirstName" TEXT,
    "telegramLastName" TEXT,
    "linkTokenHash" TEXT,
    "linkTokenExpiresAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "lastNotificationAt" TIMESTAMP(3),
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramNotification" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT,
    "type" "TelegramNotificationType" NOT NULL,
    "status" "TelegramNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "contactId" TEXT,
    "conversationId" TEXT,
    "leadId" TEXT,
    "automationEventId" TEXT,
    "deduplicationKey" TEXT,
    "providerMessageId" TEXT,
    "messagePreview" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "TelegramNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramNotificationSettings" (
    "id" TEXT NOT NULL,
    "singletonKey" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "notifyOnHandoff" BOOLEAN NOT NULL DEFAULT false,
    "notifyOnClientRequestedManager" BOOLEAN NOT NULL DEFAULT false,
    "notifyOnNewLead" BOOLEAN NOT NULL DEFAULT false,
    "notifyOnQualifiedLead" BOOLEAN NOT NULL DEFAULT false,
    "notifyOnAiUncertain" BOOLEAN NOT NULL DEFAULT false,
    "notifyOnAiFailure" BOOLEAN NOT NULL DEFAULT false,
    "notifyOnWhatsAppFailure" BOOLEAN NOT NULL DEFAULT false,
    "notifyOnMediaFailure" BOOLEAN NOT NULL DEFAULT false,
    "notifyOnAutomationFailure" BOOLEAN NOT NULL DEFAULT false,
    "notifyOnSystemError" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramNotificationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramRecipient_linkTokenHash_key" ON "TelegramRecipient"("linkTokenHash");

-- CreateIndex
CREATE INDEX "TelegramRecipient_status_isActive_idx" ON "TelegramRecipient"("status", "isActive");

-- CreateIndex
CREATE INDEX "TelegramRecipient_telegramChatId_idx" ON "TelegramRecipient"("telegramChatId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramNotification_deduplicationKey_key" ON "TelegramNotification"("deduplicationKey");

-- CreateIndex
CREATE INDEX "TelegramNotification_recipientId_createdAt_idx" ON "TelegramNotification"("recipientId", "createdAt");

-- CreateIndex
CREATE INDEX "TelegramNotification_type_status_createdAt_idx" ON "TelegramNotification"("type", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramNotificationSettings_singletonKey_key" ON "TelegramNotificationSettings"("singletonKey");

-- AddForeignKey
ALTER TABLE "TelegramNotification" ADD CONSTRAINT "TelegramNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "TelegramRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
