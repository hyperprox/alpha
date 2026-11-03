-- CreateTable
CREATE TABLE "RemoteAccessDevice" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "deviceId" TEXT,
    "nodeKey" TEXT,
    "hostname" TEXT,
    "address" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'kernel',
    "version" TEXT,
    "routes" TEXT[],
    "exitNode" BOOLEAN NOT NULL DEFAULT false,
    "routeIds" TEXT[],
    "adopted" BOOLEAN NOT NULL DEFAULT false,
    "forwardingBefore" TEXT,
    "connected" BOOLEAN,
    "checkedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemoteAccessDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RemoteAccessDevice_machineId_provider_key" ON "RemoteAccessDevice"("machineId", "provider");

-- CreateTable
CREATE TABLE "RemoteAccessPendingRevoke" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "revokeAfter" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemoteAccessPendingRevoke_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RemoteAccessPendingRevoke_revokeAfter_idx" ON "RemoteAccessPendingRevoke"("revokeAfter");

-- CreateTable
CREATE TABLE "RemoteAccessInflight" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "undo" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemoteAccessInflight_pkey" PRIMARY KEY ("id")
);
