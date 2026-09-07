-- CreateTable
CREATE TABLE "TerminalLayout" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "view" TEXT NOT NULL DEFAULT 'tabs',
    "panes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminalLayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TerminalLayout_name_key" ON "TerminalLayout"("name");
