-- CreateTable
CREATE TABLE "GuestConfigVersion" (
    "id" TEXT NOT NULL,
    "guest" TEXT NOT NULL,
    "node" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tag" TEXT,
    "actor" TEXT NOT NULL,
    "previewId" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB,
    "changes" JSONB NOT NULL,
    "outcome" TEXT NOT NULL,
    "problems" JSONB,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuestConfigVersion_guest_createdAt_idx" ON "GuestConfigVersion"("guest", "createdAt");

-- CreateIndex
CREATE INDEX "GuestConfigVersion_previewId_idx" ON "GuestConfigVersion"("previewId");
