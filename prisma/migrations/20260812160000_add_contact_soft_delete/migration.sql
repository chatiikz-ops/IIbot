-- Replace global phone uniqueness with uniqueness among active contacts only.
DROP INDEX "Contact_phone_key";

ALTER TABLE "Contact"
ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "deletedBy" TEXT,
ADD COLUMN "deletionReason" TEXT;

CREATE INDEX "Contact_deletedAt_idx" ON "Contact"("deletedAt");
CREATE UNIQUE INDEX "Contact_phone_active_key"
ON "Contact"("phone")
WHERE "deletedAt" IS NULL;
