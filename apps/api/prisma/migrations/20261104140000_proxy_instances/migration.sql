-- Proxy instances (lib/proxy). The ProxyProvider/ProxyHost tables from the first commit never had a
-- reader or a writer, and ProxyProvider had plaintext apiKey/password columns: dropped, not migrated.
DROP TABLE IF EXISTS "ProxyHost";
DROP TABLE IF EXISTS "ProxyProvider";

-- CreateTable
CREATE TABLE "ProxyInstance" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'byo',
    "managed" JSONB,
    "settings" JSONB NOT NULL,
    "owned" JSONB NOT NULL DEFAULT '[]',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProxyInstance_pkey" PRIMARY KEY ("id")
);
