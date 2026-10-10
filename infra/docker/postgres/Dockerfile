# PostgreSQL 18 + PostGIS 3.6 (Debian), plus pgvector and pg_partman from the PGDG apt repo.
# pg_trgm and pg_stat_statements ship with contrib. Extensions are created by initdb/01-extensions.sql.
# The same image runs locally, in CI and on db-1/db-2 (S0-15): WAL-G and the ops scripts in bin/ are
# what Ansible, `scripts/ops/restore-drill.ts` and the tests call, so a drill exercises production's commands.
FROM postgis/postgis:18-3.6@sha256:60f6ad1d21ea86a67d47780b9a0d1e1d200500f62b19293fa834d0dea80b8677

ARG WALG_VERSION=v3.0.9
ARG WALG_SHA256_AMD64=4f03ee4679db7f660bfd1b2b8291ac5df247cd2ec48074b60c112f4897299f24
ARG WALG_SHA256_ARM64=20191a37ad091a880c25f4cc907e6f0deb7f12bdd8a53fd62dbc7fcbf2eac712
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    postgresql-18-pgvector \
    postgresql-18-partman \
    ca-certificates \
    curl \
  && case "${TARGETARCH:-amd64}" in \
       amd64) asset=wal-g-pg-22.04-amd64; sum="$WALG_SHA256_AMD64" ;; \
       arm64) asset=wal-g-pg-22.04-aarch64; sum="$WALG_SHA256_ARM64" ;; \
       *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
     esac \
  && curl -fsSL -o /tmp/wal-g.tar.gz "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/${asset}.tar.gz" \
  && echo "${sum}  /tmp/wal-g.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/wal-g.tar.gz -C /tmp \
  && install -m 0755 "/tmp/${asset}" /usr/local/bin/wal-g \
  && rm -rf /tmp/wal-g* \
  && apt-get purge -y curl && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* \
  && wal-g --version

COPY initdb/ /docker-entrypoint-initdb.d/
COPY --chmod=0755 bin/ /usr/local/bin/
