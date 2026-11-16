-- Arr Stack "give up after X tries": per-item try counts and the settings. Additive only.
CREATE TABLE "ArrGiveUpItem" (
    "key" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ArrGiveUpItem_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "ArrGiveUpItem_app_state_idx" ON "ArrGiveUpItem"("app", "state");

CREATE TABLE "ArrGiveUpSetting" (
    "id" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ArrGiveUpSetting_pkey" PRIMARY KEY ("id")
);
