# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Monorepo scaffold: pnpm workspace + Turborepo with every app and package from PLAN §5.7 as a building skeleton, strict TypeScript/Biome/Vitest presets in `@inmolink/config`, husky + lint-staged, `pnpm verify` (Turbo `--affected`), stubbed root scripts for later tasks, and ADR 0001 with pinned versions. New dev dependencies: turbo, @biomejs/biome, typescript, vitest, tsdown, tsx, husky, lint-staged, @types/node; next, react, react-dom in the Next.js apps. [S0-01]
- Local stack: `docker-compose.yml` with `dev` and `test` profiles (PostgreSQL 18 + PostGIS/pgvector/pg_trgm/pg_partman, PgBouncer, two Redis instances, Meilisearch, MinIO, Mailpit, OTel collector + Jaeger), `scripts/ops/health.ts` (`pnpm infra:health[:test]`), `.env.test.example`. `pnpm dev` starts infra first. New root dev dependencies: pg, @types/pg, ioredis. [S0-02]
- Platform core: `@inmolink/platform` subpaths `config`, `logger`, `errors`, `ids`, `clock`, `crypto`, `crypto/password`, `http`; `AppError` + `ErrorCodes` in `@inmolink/contracts`; ADR 0003 (Argon2id params, AES-256-GCM envelope, rotation, HMAC). `.env.example` gains local-only `ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KEY_ID`, `HMAC_KEY`. New dependencies: zod (contracts, platform), pino, @node-rs/argon2. [S0-03]
- Database package: `@inmolink/db` per-role pools (`app_user`, `app_system`, `app_public`) with `withTenant`, `withSystem`, `withPublicRead`, `getPgClient`, `configureDb`/`closeDb`; `pnpm db:migrate` (advisory-locked role bootstrap with SCRAM verifiers and role-level statement timeouts, then drizzle-kit migrations as `app_owner`), `pnpm db:migrate:test`, `pnpm db:generate`. `DATABASE_URL_APP_SYSTEM` becomes optional and is refused for HTTP processes in production. New dependencies: drizzle-orm, pg (db); drizzle-kit, @types/pg, tsx (db, dev). [S0-04]
