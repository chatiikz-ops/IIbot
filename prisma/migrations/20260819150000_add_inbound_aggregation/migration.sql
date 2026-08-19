-- Additive ownership marker for durable, idempotent inbound aggregation.
ALTER TABLE "Message" ADD COLUMN "aiRunId" TEXT;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_aiRunId_fkey"
  FOREIGN KEY ("aiRunId") REFERENCES "AiRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Message_conversationId_role_aiRunId_createdAt_idx"
  ON "Message"("conversationId", "role", "aiRunId", "createdAt");
CREATE INDEX "Message_aiRunId_idx" ON "Message"("aiRunId");
