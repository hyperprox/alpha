-- Load balancing: balancing plans and their progress (scheduled ones included). Additive only.
CREATE TABLE "PlacementPlan" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL,
    "by" TEXT,
    "goal" TEXT NOT NULL DEFAULT 'both',
    "scoreBefore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "scoreTarget" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "scheduledFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "error" TEXT,
    "stopRequested" BOOLEAN NOT NULL DEFAULT false,
    "owner" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlacementPlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlacementPlan_status_idx" ON "PlacementPlan"("status");

-- One plan running cluster-wide, whichever process writes it.
CREATE UNIQUE INDEX "PlacementPlan_one_running" ON "PlacementPlan" ((1)) WHERE "status" = 'running';
