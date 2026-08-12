-- CreateEnum
CREATE TYPE "CrmProvider" AS ENUM ('ZAPIS', 'ALTEGIO', 'YCLIENTS', 'DIKIDI', 'EASYWEEK', 'BOOKSY', 'FRESHA', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('BEAUTY_SALON', 'BARBERSHOP', 'COSMETOLOGY', 'CLINIC', 'DENTAL_CLINIC', 'NAIL_STUDIO', 'SPA', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OutreachSkipReason" AS ENUM ('EXISTING_ZAPIS_CLIENT', 'MISSING_PHONE', 'MANUALLY_EXCLUDED');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "businessType" "BusinessType" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "classifiedAt" TIMESTAMP(3),
ADD COLUMN     "crmProvider" "CrmProvider" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "detectedDomains" JSONB,
ADD COLUMN     "outreachEligible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "skipReason" "OutreachSkipReason",
ADD COLUMN     "strategyCode" TEXT;
