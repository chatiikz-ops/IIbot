-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('AUDIO', 'VOICE', 'IMAGE');

-- CreateEnum
CREATE TYPE "MediaProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- AlterEnum
ALTER TYPE "AutomationEventType" ADD VALUE 'MEDIA_PROCESSING_FAILED';

-- CreateTable
CREATE TABLE "MediaAttachment" (
    "id" TEXT NOT NULL,
    "whatsAppMessageId" TEXT NOT NULL,
    "messageId" TEXT,
    "conversationId" TEXT,
    "contactId" TEXT,
    "type" "MediaType" NOT NULL,
    "processingStatus" "MediaProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "mimeType" TEXT NOT NULL,
    "originalFilename" TEXT,
    "fileSizeBytes" INTEGER,
    "caption" TEXT,
    "transcription" TEXT,
    "imageDescription" TEXT,
    "providerModel" TEXT,
    "providerResponseId" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "estimatedCostUsd" DECIMAL(12,8),
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "MediaAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaAttachment_conversationId_createdAt_idx" ON "MediaAttachment"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAttachment_contactId_createdAt_idx" ON "MediaAttachment"("contactId", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAttachment_type_processingStatus_createdAt_idx" ON "MediaAttachment"("type", "processingStatus", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAttachment_messageId_idx" ON "MediaAttachment"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAttachment_whatsAppMessageId_type_key" ON "MediaAttachment"("whatsAppMessageId", "type");

-- AddForeignKey
ALTER TABLE "MediaAttachment" ADD CONSTRAINT "MediaAttachment_whatsAppMessageId_fkey" FOREIGN KEY ("whatsAppMessageId") REFERENCES "WhatsAppMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAttachment" ADD CONSTRAINT "MediaAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAttachment" ADD CONSTRAINT "MediaAttachment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAttachment" ADD CONSTRAINT "MediaAttachment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
