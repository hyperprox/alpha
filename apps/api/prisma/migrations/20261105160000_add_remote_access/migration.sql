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
    "connected" BOOLEAN,
    "checkedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemoteAccessDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RemoteAccessDevice_machineId_provider_key" ON "RemoteAccessDevice"("machineId", "provider");
