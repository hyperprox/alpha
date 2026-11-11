-- Site metrics accuracy: people are visitors that behave like a browser; HyperProx's own requests and scanner
-- probes are counted apart. Additive only. Existing rows keep rules = 1 ("counted before the accuracy fix").
ALTER TABLE "SiteMetricHour"
  ADD COLUMN "rules" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "unconfirmedReq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "unconfirmedPageViews" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "unconfirmed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "botVisitors" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "own" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "probes" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "exposed" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "catchAll" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "SiteMetricDay"
  ADD COLUMN "rules" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "unconfirmedReq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "unconfirmedPageViews" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "unconfirmed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "botVisitors" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "own" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "probes" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "exposed" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "catchAll" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "SiteVisitor" ADD COLUMN "data" JSONB NOT NULL DEFAULT '{}';
