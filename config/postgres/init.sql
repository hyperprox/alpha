-- HyperProx — Postgres initialisation
-- Prisma migrations handle schema — this just sets up extensions and tuning

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- fuzzy search on names
CREATE EXTENSION IF NOT EXISTS "btree_gin"; -- composite index support

-- Tune for container workload
ALTER SYSTEM SET shared_buffers = '256MB';
ALTER SYSTEM SET effective_cache_size = '512MB';
ALTER SYSTEM SET work_mem = '16MB';
ALTER SYSTEM SET maintenance_work_mem = '64MB';
ALTER SYSTEM SET checkpoint_completion_target = '0.9';
ALTER SYSTEM SET wal_buffers = '16MB';
ALTER SYSTEM SET log_min_duration_statement = '1000'; -- log slow queries >1s
