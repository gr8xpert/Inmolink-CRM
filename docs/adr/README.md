# Architecture decision records

One file per decision: `NNNN-short-title.md` with **Status**, **Context**, **Decision** and **Consequences**. `tests/workspace/docs.test.ts` checks that every ADR has those sections and is listed below.

- A new decision gets the next free number. Numbers are never reused or renumbered, because rules, PATTERNS and STATUS cite them.
- A decision that contradicts PLAN §3 is written as **Proposed**, flagged in `docs/build/STATUS.md`, and settled at the sprint review (PLAN §23).
- When a decision changes, update the ADR in the same PR (status, date and what changed), or supersede it with a new one that links back.
- Scale triggers (PLAN §5.6) each get their own ADR.

| # | Decision | Status |
|---|---|---|
| [0001](0001-stack-and-versions.md) | Stack and pinned versions | Accepted |
| [0002](0002-media-content-addressing.md) | Media: content addressing and deterministic variants | Accepted (design) |
| [0003](0003-password-hashing-and-encryption.md) | Password hashing (Argon2id parameters) and secret encryption | Accepted |
| [0004](0004-authentication.md) | Authentication: Auth.js sessions, access tokens, `app_auth` | Accepted |
| [0005](0005-search-adapter-and-fallback.md) | Search: one adapter, one listings index, Postgres fallback | Accepted (design) |
| [0006](0006-legacy-migration.md) | Legacy migration: golden-file shim, idempotent ETL, DNS cutover | Accepted (design) |
| [0007](0007-backups-and-ha.md) | Backups and high availability | Accepted |
| [0008](0008-ai-gateway-and-model-defaults.md) | AI gateway and model defaults | Accepted (design) |
| [0009](0009-drizzle-orm.md) | Drizzle ORM on node-postgres | Accepted |
| [0010](0010-modular-monolith-and-boundaries.md) | Modular monolith with enforced boundaries | Accepted |
| [0011](0011-tenancy-and-rls.md) | Tenancy and row-level security | Accepted |
| [0012](0012-website-api-and-caching.md) | Website API and caching | Accepted (design) |
| [0013](0013-public-page-js-budget.md) | Public page JavaScript budget | Proposed |
| [0014](0014-outbox-wake-up.md) | Outbox wake-up without NOTIFY in business transactions | Proposed |

"Accepted (design)" means the decision is settled but the code lands with a later task, which the ADR names.
