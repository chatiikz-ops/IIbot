-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignTargetStatus" AS ENUM ('WAITING', 'READY', 'QUEUED', 'PROCESSING', 'MESSAGE_SENT', 'WAITING_REPLY', 'REPLIED', 'LEAD', 'HANDOFF', 'REJECTED', 'ERROR', 'SKIPPED');

-- CreateEnum
CREATE TYPE "CampaignSourceType" AS ENUM ('ALL_CONTACTS', 'IMPORT_JOB');

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceType" "CampaignSourceType" NOT NULL,
    "sourceImportJobId" TEXT,
    "filters" JSONB NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "selectedCount" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "repliedCount" INTEGER NOT NULL DEFAULT 0,
    "leadCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "handoffCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignSettings" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "workingHoursStart" TEXT NOT NULL,
    "workingHoursEnd" TEXT NOT NULL,
    "dailyMessageLimit" INTEGER NOT NULL,
    "minDelaySeconds" INTEGER NOT NULL,
    "maxDelaySeconds" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignTarget" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" "CampaignTargetStatus" NOT NULL DEFAULT 'WAITING',
    "strategyCode" TEXT,
    "queuedAt" TIMESTAMP(3),
    "processingStartedAt" TIMESTAMP(3),
    "messageSentAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignLog" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "targetId" TEXT,
    "event" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "previousStatus" TEXT,
    "newStatus" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_status_createdAt_idx" ON "Campaign"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_sourceImportJobId_idx" ON "Campaign"("sourceImportJobId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignSettings_campaignId_key" ON "CampaignSettings"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignTarget_campaignId_status_createdAt_idx" ON "CampaignTarget"("campaignId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignTarget_contactId_idx" ON "CampaignTarget"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignTarget_campaignId_contactId_key" ON "CampaignTarget"("campaignId", "contactId");

-- CreateIndex
CREATE INDEX "CampaignLog_campaignId_createdAt_idx" ON "CampaignLog"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignLog_targetId_idx" ON "CampaignLog"("targetId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_sourceImportJobId_fkey" FOREIGN KEY ("sourceImportJobId") REFERENCES "ImportJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSettings" ADD CONSTRAINT "CampaignSettings_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLog" ADD CONSTRAINT "CampaignLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
