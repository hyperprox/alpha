-- CreateTable
CREATE TABLE "CatalogueRecord" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogueRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogueRecord_kind_expiresAt_idx" ON "CatalogueRecord"("kind", "expiresAt");
