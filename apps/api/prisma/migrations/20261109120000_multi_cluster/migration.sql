-- Command center: remote clusters managed beside the home one, and file copies between them.
-- Additive only: two new tables, nothing existing is changed. An install with no remote cluster has no rows
-- and behaves exactly as before. No secrets are stored here (tokens and logins are in the vault).

-- CreateTable
CREATE TABLE "ManagedCluster" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'remote',
    "address" TEXT NOT NULL DEFAULT '',
    "port" INTEGER NOT NULL DEFAULT 8006,
    "note" TEXT NOT NULL DEFAULT '',
    "certFingerprint" TEXT,
    "certConfirmedAt" TIMESTAMP(3),
    "certConfirmedBy" TEXT,
    "nodeAddresses" JSONB NOT NULL DEFAULT '{}',
    "allowedRoots" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "monitoring" JSONB NOT NULL DEFAULT '{}',
    "plexUrl" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileCopyJob" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'copy',
    "srcCluster" TEXT NOT NULL,
    "srcNode" TEXT NOT NULL,
    "srcPath" TEXT NOT NULL,
    "dstCluster" TEXT NOT NULL,
    "dstNode" TEXT NOT NULL,
    "dstPath" TEXT NOT NULL,
    "speedKBps" INTEGER NOT NULL DEFAULT 0,
    "plexScan" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "preview" JSONB NOT NULL,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "FileCopyJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileCopyJob_state_idx" ON "FileCopyJob"("state");
