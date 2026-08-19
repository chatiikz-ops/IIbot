-- Additive, backward-compatible campaign delivery counter.
ALTER TABLE "Campaign"
ADD COLUMN "failedCount" INTEGER NOT NULL DEFAULT 0;
