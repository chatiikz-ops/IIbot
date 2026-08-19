-- Additive snapshot metadata and indexes for 2k-50k contact workloads.
ALTER TABLE "CampaignTarget" ADD COLUMN "strategyAssignedAt" TIMESTAMP(3);

CREATE INDEX "CampaignTarget_strategyCode_idx" ON "CampaignTarget"("strategyCode");
CREATE INDEX "Contact_classifiedAt_idx" ON "Contact"("classifiedAt");
CREATE INDEX "Contact_strategyCode_idx" ON "Contact"("strategyCode");
CREATE INDEX "AutomationJob_type_status_runAt_idx" ON "AutomationJob"("type", "status", "runAt");
CREATE INDEX "AutomationJob_conversationId_status_idx" ON "AutomationJob"("conversationId", "status");
