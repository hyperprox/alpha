-- Remote access: adopted clients, a guest's previous forwarding, and the two tables that make a restart safe
-- (keys pending revocation, node changes in flight).

-- AlterTable
ALTER TABLE "RemoteAccessDevice" ADD COLUMN "adopted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "forwardingBefore" TEXT;

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
