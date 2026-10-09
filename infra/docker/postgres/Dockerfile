# PostgreSQL 18 + PostGIS 3.6 (Debian), plus pgvector and pg_partman from the PGDG apt repo.
# pg_trgm and pg_stat_statements ship with contrib. Extensions are created by initdb/01-extensions.sql.
FROM postgis/postgis:18-3.6

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    postgresql-18-pgvector \
    postgresql-18-partman \
  && rm -rf /var/lib/apt/lists/*

COPY initdb/ /docker-entrypoint-initdb.d/
