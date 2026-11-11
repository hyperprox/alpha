-- Site metrics: hourly and daily counts per site, two-day visitor hashes and salts, and per-site state. Additive only.
CREATE TABLE "SiteMetricHour" (
    "siteId" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "human" INTEGER NOT NULL DEFAULT 0,
    "bots" INTEGER NOT NULL DEFAULT 0,
    "pageViews" INTEGER NOT NULL DEFAULT 0,
    "botPageViews" INTEGER NOT NULL DEFAULT 0,
    "visitors" INTEGER NOT NULL DEFAULT 0,
    "s2xx" INTEGER NOT NULL DEFAULT 0,
    "s3xx" INTEGER NOT NULL DEFAULT 0,
    "s4xx" INTEGER NOT NULL DEFAULT 0,
    "s5xx" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "timed" INTEGER NOT NULL DEFAULT 0,
    "rtHist" JSONB NOT NULL DEFAULT '[]',
    "pages" JSONB NOT NULL DEFAULT '{}',
    "referrers" JSONB NOT NULL DEFAULT '{}',
    "notFound" JSONB NOT NULL DEFAULT '{}',
    "browsers" JSONB NOT NULL DEFAULT '{}',
    "os" JSONB NOT NULL DEFAULT '{}',
    "devices" JSONB NOT NULL DEFAULT '{}',
    "checks" INTEGER NOT NULL DEFAULT 0,
    "checksOk" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "SiteMetricHour_pkey" PRIMARY KEY ("siteId","hour")
);
CREATE INDEX "SiteMetricHour_hour_idx" ON "SiteMetricHour"("hour");

CREATE TABLE "SiteMetricDay" (
    "siteId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "human" INTEGER NOT NULL DEFAULT 0,
    "bots" INTEGER NOT NULL DEFAULT 0,
    "pageViews" INTEGER NOT NULL DEFAULT 0,
    "botPageViews" INTEGER NOT NULL DEFAULT 0,
    "visitors" INTEGER NOT NULL DEFAULT 0,
    "s2xx" INTEGER NOT NULL DEFAULT 0,
    "s3xx" INTEGER NOT NULL DEFAULT 0,
    "s4xx" INTEGER NOT NULL DEFAULT 0,
    "s5xx" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "timed" INTEGER NOT NULL DEFAULT 0,
    "rtHist" JSONB NOT NULL DEFAULT '[]',
    "pages" JSONB NOT NULL DEFAULT '{}',
    "referrers" JSONB NOT NULL DEFAULT '{}',
    "notFound" JSONB NOT NULL DEFAULT '{}',
    "browsers" JSONB NOT NULL DEFAULT '{}',
    "os" JSONB NOT NULL DEFAULT '{}',
    "devices" JSONB NOT NULL DEFAULT '{}',
    "checks" INTEGER NOT NULL DEFAULT 0,
    "checksOk" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "SiteMetricDay_pkey" PRIMARY KEY ("siteId","day")
);
CREATE INDEX "SiteMetricDay_day_idx" ON "SiteMetricDay"("day");

CREATE TABLE "SiteVisitor" (
    "siteId" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "hash" TEXT NOT NULL,
    CONSTRAINT "SiteVisitor_pkey" PRIMARY KEY ("siteId","hour","hash")
);
CREATE INDEX "SiteVisitor_hour_idx" ON "SiteVisitor"("hour");

CREATE TABLE "SiteMetricSalt" (
    "day" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteMetricSalt_pkey" PRIMARY KEY ("day")
);

CREATE TABLE "SiteMetricState" (
    "siteId" TEXT NOT NULL,
    "logPath" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "adopted" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "inode" TEXT NOT NULL DEFAULT '',
    "offset" BIGINT NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SiteMetricState_pkey" PRIMARY KEY ("siteId")
);
