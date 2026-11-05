-- VPN: private notification channels (the only ones that receive sign-in links) and the devices the
-- new-device poller has already announced.

-- AlterTable
ALTER TABLE "NotifyChannel" ADD COLUMN "private" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RemoteAccessDevice" ADD COLUMN "prefs" JSONB;

-- CreateTable
CREATE TABLE "RemoteAccessKnownDevice" (
    "provider" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemoteAccessKnownDevice_pkey" PRIMARY KEY ("provider","deviceId")
);
