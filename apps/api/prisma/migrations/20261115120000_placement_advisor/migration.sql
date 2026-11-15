-- Placement advisor: settings and the move history (scheduled moves included). Additive only.
CREATE TABLE "PlacementSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlacementSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlacementMove" (
    "id" TEXT NOT NULL,
    "sid" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "fromNode" TEXT NOT NULL,
    "toNode" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'hyperprox',
    "method" TEXT,
    "status" TEXT NOT NULL,
    "upid" TEXT,
    "by" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "error" TEXT,
    "bwlimitKiB" INTEGER,
    "corosync" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlacementMove_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlacementMove_upid_key" ON "PlacementMove"("upid");
CREATE INDEX "PlacementMove_sid_idx" ON "PlacementMove"("sid");
CREATE INDEX "PlacementMove_status_idx" ON "PlacementMove"("status");
