-- Guests HyperProx must never look inside or touch for VPN work. Machine ids only.
CREATE TABLE "VpnExclusion" (
    "machineId" TEXT NOT NULL,
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VpnExclusion_pkey" PRIMARY KEY ("machineId")
);
