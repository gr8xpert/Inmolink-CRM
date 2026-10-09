-- Runs once, on an empty data volume, as the bootstrap superuser in POSTGRES_DB.
-- Keep this list in sync with REQUIRED_EXTENSIONS in scripts/ops/health.ts.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
