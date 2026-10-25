# Rotating `HMAC_KEY` (S11-F13)

`HMAC_KEY` is the dedicated HMAC-SHA256 key (`platform/crypto`, one HKDF subkey per purpose). Every token URL the
platform hands out is stored only as its keyed hash, so a new key on its own makes every one of them answer 404:

| What breaks | Stored as | Who holds the URL |
|---|---|---|
| Per-site XML feeds `/v2/feeds/<token>/{kyero,inmolink}.xml` | `website_feeds.token_hash` (purpose `websites.feed-token`) | Agency admins, pasted into portals |
| Portal feeds `/v2/portal-feeds/<token>/<file>` | `agency_portal_connections.token_hash` (`exports.feed-token`) | Portals (Kyero, idealista, …) |
| Members' calendar feeds `/v2/calendars/<token>/calendar.ics` | `crm_calendar_feeds.token_hash` (`crm.calendar-feed-token`) | Each member's calendar app |

The token itself is never stored, so these hashes **cannot be re-computed**: a URL keeps working only while its hash
can still be found. That is what the dual-key window is for.

Not covered by this runbook: `ENCRYPTION_KEYS` (its own keyring with key ids — add, switch, re-encrypt, drop) and
`MEDIA_URL_KEY` (never rotated; rotating it moves every variant URL).

## The dual-key verify window

| Variable | Meaning |
|---|---|
| `HMAC_KEY` | The current key. Everything is signed and hashed with it, always. |
| `HMAC_KEY_PREVIOUS` | The key `HMAC_KEY` replaced. While set, stored-hash lookups that opt in (`hmacSha256Candidates`, `verifyHmacSha256Rotating`) also accept it. Never used to sign; `verifyHmacSha256` never accepts it. |
| `HMAC_KEY_PREVIOUS_UNTIL` | ISO 8601 with offset (`2026-12-01T00:00:00Z`). The window ends here even if the previous key is still set. Required with a previous key in production; refused without one. |

Boot calls `hmacRotationFromEnv(config, logger)` (api, feed-api, worker). The window lives inside `platform/crypto`:
`hmacSha256Candidates(key, purpose, data)` returns the current key's hash, then the previous key's while the window is
open. The feed servers (site and portal feeds; calendar feeds once `crm.calendarFeed` uses the candidates — S11-F13
follow-up) try them in order and stop at the first hit, so outside a window it is one hash and one query,
and inside it a second statement only for URLs that miss under the current key (feed-api stays within 3 queries).

## Rotation steps

1. **Generate** the new key: `openssl rand -hex 32` (at least 32 characters, never `dev-…`, never a committed value).
2. **Pick the window end.** Default **30 days**, at most **90** (production refuses more) — long enough for agencies
   to update portals and members to re-add their calendar. Portal feeds are the slow part: allow for a portal's
   support turnaround.
3. **Website API keys and 2FA recovery codes** are dual-key (S12-F15): inside the window both keep working.
   - **API keys** are rehashed on use: a request that matches the previous key's hash marks the key in redis-cache
     (`identity.apikeys.rehash`), and `identity.flushApiKeyUsage` (maintenance pool, every minute) stores the current
     key's hash and drops the cached lookup. A key used at least once during the window outlives it; a key unused for
     the whole window stops working when it closes. Before closing it, count the keys still on the previous key (step 10).
     Marks are signed with the current key (a forged one is dropped) and applied only while the window is open. A
     rehash reaches other feed-api processes' in-process lookup cache only after `API_KEYS.CACHE_LOCAL_TTL_SECONDS`
     (15 s), so the last flush that rehashes a key must run at least that long before `HMAC_KEY_PREVIOUS_UNTIL`: in
     practice, every key should have been used (and flushed, every minute) well before the last hour of the window.
   - **Recovery codes** are single-use and stored only as hashes, so unused codes cannot be rehashed: they work until
     the window closes, then stop. Ask users with 2FA to regenerate their recovery codes during the window;
     after it closes, a user who has lost the authenticator app must recover the account through support.
4. **Freeze token rotation during the deploy:** announce a short maintenance window and pause the rotation endpoints
   (`POST /v1/sites/:siteId/feed/token`, `POST /v1/portal-connections/:connectionId/token`,
   `POST /v1/crm/calendar/feed`) until step 6 is done.
5. **Deploy feed-api first** with `HMAC_KEY=<new>`, `HMAC_KEY_PREVIOUS=<old>`, `HMAC_KEY_PREVIOUS_UNTIL=<end>`: it
   then finds tokens of both keys, whatever the old api still issues.
6. **Then deploy api and the worker** (every pool except `media`) with the same three variables, and lift the freeze.
   (realtime does not use `HMAC_KEY`.)
7. **Purge the website API edge cache** (all `/v2` tags; see `cdn.md`): edge Cache-Tags are keyed hashes too, so old
   entries no longer match the tags the worker purges with.
8. **Check** a known feed URL of the previous key still answers 200, and that new rotations answer 200
   (`GET /v2/feeds/<token>/kyero.xml`, `/v2/portal-feeds/<token>/<file>`).
9. **Re-issue during the window** (tokens are shown once, so only their holders can re-issue them):
   - Site feeds: each agency admin rotates the site's feed token (`POST /v1/sites/:siteId/feed/token`) and updates
     the URL wherever it was pasted.
   - Portal feeds: each agency rotates the connection token (`POST /v1/portal-connections/:connectionId/token`) and
     sends the new URL to the portal.
   - **Members' calendar feeds:** each member rotates their own feed (`POST /v1/crm/calendar/feed`) and re-subscribes
     in their calendar app. Staff cannot issue a member's URL. Send the members of every agency with a live feed a
     notice (in-app and email) with the deadline.
   A rotation revokes the old URL at once, so the window only matters for URLs nobody has re-issued yet.
10. **Close the window** at `HMAC_KEY_PREVIOUS_UNTIL` (it closes itself; boot logs a warning while the variables are
    still set) and then remove `HMAC_KEY_PREVIOUS` and `HMAC_KEY_PREVIOUS_UNTIL` from config at the next deploy. URLs
    still on the old key then answer 404.
    Before that, list the API keys likely still on the previous key — active, created before the cutover and not used
    since (a used key was rehashed; the mark is best effort, so re-check one by authenticating it) — and tell their
    agencies to rotate them: `select agency_id, prefix, last_used_at from api_keys where revoked_at is null and
    created_at < :cutover and coalesce(rotated_at, created_at) < :cutover and (last_used_at is null or last_used_at < :cutover)`.
    **Client fingerprints first (S12-F8):** the window must not close while a valid client registration still lacks a
    fingerprint under the new key — it would stop blocking a duplicate registration ("first valid wins"). Every
    fingerprint row carries the label of its key (`key_id`, `hmacKeyLabel`), and `mls.fingerprintsPending()` counts the
    valid registrations without a current-key row. `mls.rehashFingerprints` (hourly during the window) brings it to 0.
    From 24 h before `HMAC_KEY_PREVIOUS_UNTIL`, `mls.checkFingerprintRehash` (every 15 minutes) records the count; any
    pending registration fires **`HmacRotationRehashPending`** (critical, `infra/monitoring/rules/security.yml`; worker
    log line with the same name). On that alert: check the `maintenance` pool runs (`queues.md`), queue a pass
    (`mls.scheduleFingerprintRehash`), and if it cannot finish in time **move `HMAC_KEY_PREVIOUS_UNTIL` later** (redeploy
    api, feed-api and the worker with the new end, at most 90 days after the cutover) — never let the window close
    with pending > 0.
11. **Destroy the old key** in the secret store once it is out of every deploy (and every backup of the config).

**After a key leak** there is no window: skip `HMAC_KEY_PREVIOUS` entirely, deploy the new key, and have every holder
re-issue (step 9) and every agency rotate its API keys (`POST /v1/api-keys/:keyId/rotate`) and every user regenerate recovery codes. The leaked key must not stay trusted at all.

## Fingerprint-style HMACs (stored lookups)

Some HMACs are lookups of data the platform does hold: client fingerprints (HMAC of a normalized email/phone,
PLAN §8 — MLS client registrations "first valid registration wins", CRM contact de-duplication) and the website-API
lead recipient hash. Their source is stored (encrypted), so they are **re-hashed**, not given a separate stable key:

- During the window, lookups and uniqueness checks match either hash: `inArray(fingerprint,
  hmacSha256Candidates(key, purpose, normalized))` — a registration under the old key still blocks a duplicate.
- A rehash job (worker, `withSystem` with an audit reason, batched per tenant, idempotent) decrypts the source, writes
  the current key's hash, and reports the rows still under the previous key. The window does not close (step 10) until
  that count is zero for every fingerprint table.
- Each module that stores such a fingerprint owns its rehash job; it ships with the table.

## Other HMAC_KEY uses (short-lived or re-derived)

| Use | Effect of a rotation |
|---|---|
| API keys (`identity`, `api-key`) | Dual-key during the window and rehashed on use (S12-F15, step 3); unused keys stop at the window's end. |
| 2FA recovery codes (`recovery-code`) | Dual-key during the window (S12-F15); cannot be rehashed — users regenerate them (step 3). |
| Login / reset links, invites, MFA proofs | Short-lived; links sent before the rotation fail — users ask for a new one, invites are re-sent. |
| `/v2/changes` and search cursors | Signed; clients with an old cursor get a cursor error and resync. |
| Site scope tag, honeytokens, edge Cache-Tags | Re-derived: clients see a new scope (full resync), honeytokens change, the edge cache is purged (step 7). |
| Idempotency and request hashes | 24 h windows: a retry across the rotation is treated as new. |
