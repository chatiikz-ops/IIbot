-- CreateEnum
CREATE TYPE "AiAction" AS ENUM ('CONTINUE', 'QUALIFY', 'HANDOFF', 'STOP', 'WAIT');

-- CreateEnum
CREATE TYPE "AiLeadDecision" AS ENUM ('NOT_READY', 'QUALIFIED', 'REJECTED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REFUSED');

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "triggerMessageId" TEXT,
    "promptStrategyId" TEXT,
    "promptVersionId" TEXT,
    "model" TEXT NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'PENDING',
    "action" "AiAction",
    "leadDecision" "AiLeadDecision",
    "reply" TEXT,
    "summary" TEXT,
    "extractedData" JSONB,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "estimatedCostUsd" DECIMAL(12,8),
    "latencyMs" INTEGER,
    "providerResponseId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiRun_conversationId_createdAt_idx" ON "AiRun"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_status_idx" ON "AiRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AiRun_conversationId_triggerMessageId_key" ON "AiRun"("conversationId", "triggerMessageId");

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_promptStrategyId_fkey" FOREIGN KEY ("promptStrategyId") REFERENCES "PromptStrategy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
