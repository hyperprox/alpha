-- CreateTable
CREATE TABLE "NotifyChannel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minSeverity" TEXT NOT NULL DEFAULT 'warning',
    "eventFilter" JSONB NOT NULL,
    "quietHours" JSONB,
    "lanOverride" BOOLEAN NOT NULL DEFAULT false,
    "usableWhileLocked" BOOLEAN NOT NULL DEFAULT false,
    "nonSecret" JSONB NOT NULL,
    "lastResult" JSONB,
    "lastSentAt" TIMESTAMP(3),
    "failingSince" TIMESTAMP(3),
    "seededFrom" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotifyChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotifyOutbox" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "fingerprint" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "NotifyOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotifyState" (
    "id" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotifyState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotifyOutbox_status_nextAttemptAt_idx" ON "NotifyOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotifyOutbox_channelId_createdAt_idx" ON "NotifyOutbox"("channelId", "createdAt");

