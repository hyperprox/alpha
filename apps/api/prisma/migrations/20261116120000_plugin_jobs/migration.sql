-- Long plug-in jobs (a Nextcloud update, a database repair), kept across API restarts. Additive only.
CREATE TABLE "PluginJob" (
    "id" TEXT NOT NULL,
    "plugin" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PluginJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PluginJob_plugin_instanceId_idx" ON "PluginJob"("plugin", "instanceId");
CREATE INDEX "PluginJob_state_idx" ON "PluginJob"("state");
