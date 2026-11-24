-- AI operator, phase 2 (the handbook): playbooks and the house rules. Additive only.
-- Playbooks are the owner's own writing (or a cloud model's draft awaiting approval); no secret belongs in either.
CREATE TABLE "AiPlaybook" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "symptoms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "area" TEXT NOT NULL DEFAULT '',
    "checks" TEXT NOT NULL DEFAULT '',
    "cause" TEXT NOT NULL DEFAULT '',
    "fix" TEXT NOT NULL DEFAULT '',
    "safety" TEXT NOT NULL DEFAULT '',
    "testScenario" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'user',
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiPlaybook_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiPlaybook_key_key" ON "AiPlaybook"("key");
CREATE INDEX "AiPlaybook_approved_idx" ON "AiPlaybook"("approved");

CREATE TABLE "AiHouseRules" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "rules" JSONB NOT NULL DEFAULT '[]',
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiHouseRules_pkey" PRIMARY KEY ("id")
);
