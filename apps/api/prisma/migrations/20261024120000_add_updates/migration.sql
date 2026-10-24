-- CreateTable
CREATE TABLE "UpdateJob" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "pauseReason" TEXT,
    "plan" JSONB NOT NULL,
    "report" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "UpdateJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdateStep" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "target" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "reason" TEXT,
    "output" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "UpdateStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdateLock" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpdateLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UpdateJob_startedAt_idx" ON "UpdateJob"("startedAt");

-- CreateIndex
CREATE INDEX "UpdateStep_jobId_seq_idx" ON "UpdateStep"("jobId", "seq");

-- AddForeignKey
ALTER TABLE "UpdateStep" ADD CONSTRAINT "UpdateStep_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "UpdateJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

