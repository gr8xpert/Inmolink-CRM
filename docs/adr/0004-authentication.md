# ADR 0004 — Authentication: Auth.js sessions, access tokens, `app_auth` role

- **Status:** Accepted (proposed in S0-09; extends PLAN §3 #30 #31 and #50 — review at the S0 sprint review)
- **Date:** 2026-10-10
- **Task:** S0-09

## Context

PLAN §3 #30: Auth.js v5 sessions for the dashboard, short-lived JWTs verified by Fastify. Login happens
before any tenant is known, and staff users have no agency, so the login identity cannot live in a
STRICT tenant table. The existing roles do not fit the auth flows: `app_user` would need SELECT on
`users` (every tenant session could then read every password hash), and `app_system` (BYPASSRLS) is
refused in request paths.

## Decision

### Identity data and the `app_auth` role
- `users` and `auth_tokens` are **global tables with `access: 'auth'`** in the tenant registry. Only the
  new login role **`app_auth`** (RLS on, no BYPASSRLS, 5 s statement timeout) and `app_system` reach
  them; `app_user` and `app_public` get no privilege at all. `app_auth` has no grant on any other table,
  except INSERT into `outbox_events` restricted by policy to the platform agency (nil UUID) — the
  registry flag `authAppend`. The generator, guard and isolation suite cover both rules.
- `withAuth(fn)` (`@inmolink/db`) opens an `app_auth` transaction and is allowed in request paths.
  Core passes it to services as `AuthCtx { requestId, transaction }`: auth services hash or verify
  passwords before opening a transaction instead of holding one open around Argon2.
- Agency membership and roles come later (S1-01/S1-02) in a STRICT table; `users` stays tenant-free.

### Sessions and tokens
- **Web session:** Auth.js `5.0.0-beta.32` (the v5 line is still published as beta) with the Credentials
  provider and the JWT session strategy, in an encrypted, httpOnly, `SameSite=Strict` cookie (7 days,
  refreshed daily). Credentials are checked by `identity.verifyCredentials`, after per-IP and per-email
  rate limits (fail closed).
- **Access tokens:** the web server mints 15-minute JWTs per audience (`api`, `realtime`) at
  `GET /session/token?aud=…`. **Ed25519 (`EdDSA`)** via `jose`: web holds the private key
  (`AUTH_JWT_PRIVATE_KEY`, `AUTH_JWT_KEY_ID`), api and realtime hold only public keys
  (`AUTH_JWT_PUBLIC_KEYS=kid:spki,…`), so a compromised verifier cannot mint. Claims: `sub` (user id),
  `aud`, `iss=inmolink-web`, `typ=at+jwt`, `sv` (session version), `iat`, `exp`; `agency` once
  memberships exist. Verification checks algorithm, key id, issuer, audience, expiry (5 s leeway) and
  max age.
- **Revocation:** every mint re-reads the user (`ACTIVE`, email verified, `session_version`). A password
  reset bumps `session_version`, so an old web session stops getting tokens; outstanding access tokens
  live at most 15 minutes. The API does not hit the database per request.
- **API:** `Authorization: Bearer` only — the API never reads cookies, so there is no CSRF surface.
  `requireSession` runs as a route `onRequest` hook, before the per-user/per-tenant rate limits
  (`preHandler`). **Realtime:** token in the Socket.io handshake `auth` payload, plus an exact-origin
  allowlist (`WEB_URL`) in Engine.io `allowRequest`; sockets are disconnected when their token expires.

### Email links
- Verification (24 h) and reset (60 min) links carry a 32-byte random token; only an HMAC
  (`HMAC_KEY`, purpose `auth-token`) is stored. Consumption is one `UPDATE … WHERE used_at IS NULL AND
  expires_at > now RETURNING`, so a link works exactly once. Issuing a new link retires older unused
  links of the same kind.
- Requests emit outbox events with IDs only; the worker job `identity.sendAuthEmail` (pool `email`)
  creates the token and sends the email through `platform/email` after its transaction commits, so a
  token never passes through the outbox or Redis.
- No account enumeration: sign-up and reset requests always show the same result (a taken email gets an
  "account exists" email instead), and unknown email / wrong password / disabled account are one error.

## Consequences
- One more database credential (`DATABASE_URL_APP_AUTH`) per environment; `db:migrate` bootstraps it.
- Rotating the signing key: add the new public key to every verifier, switch the signer, drop the old
  public key after 15 minutes.
- A stolen access token is valid for up to 15 minutes; there is no per-token deny list.
- Apps that run auth flows (today only `web`) need `app_auth`; `api` and `realtime` need only public keys.

## Amendment — two-factor authentication (S1-04, 2026-10-11)
- **TOTP** (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step) in `platform/crypto/totp.ts` (no dependency). Secrets in
  `user_mfa` (AES-256-GCM, AAD bound to the user row; the web gets `ENCRYPTION_KEYS`); `last_used_step`
  makes a code work once. 10 recovery codes (50 bits, `xxxxx-xxxxx`) in `user_recovery_codes`, stored as
  HMACs (purpose `recovery-code`), spent by one `UPDATE … WHERE used_at IS NULL`.
- Both tables are `access: 'auth'` with the new registry flag **`userScoped`**: `app_auth` reaches only rows
  with `user_id = app_user_id()`. `app_auth` also reads its own `staff_users` row (policy `auth_self`).
- **Required** for staff and both admin roles (`AGENCY_ADMIN`, `DEVELOPER_ADMIN`); optional for others, and
  then required for anyone who enabled it. Staff and admins cannot turn it off.
- **Enforcement at the mint:** `issueAccessToken` takes `mfaVerified` from the session and throws
  `MFA_REQUIRED` when the user needs 2FA. Every dashboard page, action and `/session/token` goes through it;
  the web sends such sessions to `/two-factor` (challenge, or enrolment when none exists).
- **Session upgrade:** the Auth.js session carries `mfa`. Auth.js passes browser-supplied data to the `jwt`
  callback on `update`, so only an identity **proof** — `exp.HMAC(user, session_version, exp)`, purpose
  `mfa-proof`, 2 minutes — sets it. The proof is created and handed over server-side only.
- **Remember this browser (30 days):** cookie `__Host-inmolink.mfa-device` (httpOnly, Secure, Strict) holding
  `exp.HMAC(user, session_version, confirmed_at, exp)`; a password reset or a new enrolment ends it.
- **Limits** (fail closed, counted before any check): 5 codes / 5 min and 20 / day per user, 30 / 15 min per IP.
