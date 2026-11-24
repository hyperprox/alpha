-- AI operator, phase 1 (tier router): its settings, per-call usage and the problem-fingerprint log. Additive only.
-- Nothing here is secret: the local tier's key lives in the vault, and a fingerprint is a hash, never the question.
CREATE TABLE "AiOperatorSetting" (
    "id" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiOperatorSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiOperatorUsage" (
    "id" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiOperatorUsage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiOperatorUsage_at_idx" ON "AiOperatorUsage"("at");

CREATE TABLE "AiOperatorFingerprint" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "problemClass" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiOperatorFingerprint_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiOperatorFingerprint_fingerprint_at_idx" ON "AiOperatorFingerprint"("fingerprint", "at");
