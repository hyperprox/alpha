-- WireGuard: servers and peers HyperProx manages. Public keys only.

-- CreateTable
CREATE TABLE "WgServer" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "iface" TEXT NOT NULL,
    "listenPort" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "keyBackedUp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WgServer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WgServer_machineId_iface_key" ON "WgServer"("machineId", "iface");

-- CreateTable
CREATE TABLE "WgPeer" (
    "id" TEXT NOT NULL,
    "serverId" TEXT,
    "routerIface" TEXT,
    "routerPeerId" TEXT,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "machineId" TEXT,
    "iface" TEXT,
    "publicKey" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "allowedIps" TEXT[],
    "clientAllowedIps" TEXT[],
    "keepalive" INTEGER,
    "previousPublicKey" TEXT,
    "previousUntil" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WgPeer_pkey" PRIMARY KEY ("id")
);
