-- CreateEnum
CREATE TYPE "PromptStrategyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "PromptStrategy" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "PromptStrategyStatus" NOT NULL DEFAULT 'DRAFT',
    "activeVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptStrategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "systemInstruction" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "firstMessage" TEXT NOT NULL,
    "communicationRules" TEXT NOT NULL,
    "qualificationQuestions" JSONB NOT NULL,
    "sellingPoints" JSONB NOT NULL,
    "competitorContext" TEXT,
    "handoffRules" TEXT NOT NULL,
    "stopRules" TEXT NOT NULL,
    "forbiddenActions" JSONB NOT NULL,
    "closingRules" TEXT NOT NULL,
    "maxAssistantMessages" INTEGER NOT NULL DEFAULT 5,
    "metadata" JSONB,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromptStrategy_code_key" ON "PromptStrategy"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PromptStrategy_activeVersionId_key" ON "PromptStrategy"("activeVersionId");

-- CreateIndex
CREATE INDEX "PromptVersion_strategyId_createdAt_idx" ON "PromptVersion"("strategyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_strategyId_version_key" ON "PromptVersion"("strategyId", "version");

-- AddForeignKey
ALTER TABLE "PromptStrategy" ADD CONSTRAINT "PromptStrategy_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "PromptStrategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
