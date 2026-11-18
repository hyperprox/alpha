-- Arr Stack "Sort requests into the right folder": the rules, bookmarks and Recently sorted list. Additive only.
CREATE TABLE "ArrRouterSetting" (
    "id" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ArrRouterSetting_pkey" PRIMARY KEY ("id")
);
