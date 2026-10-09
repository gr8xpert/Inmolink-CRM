# ADR 0003 — Password hashing and secret encryption

- **Status:** Accepted
- **Date:** 2026-10-10
- **Task:** S0-03 (PLAN §3 #52, §12)

## Context

PLAN §12 requires Argon2id for passwords and AES-256-GCM with key versioning for stored secrets and client PII. The security rules point to this ADR for the exact parameters. Production runs Node 22 and 24. `crypto.argon2` exists only in newer Node 24 releases and is still experimental, so it cannot be the only implementation.

## Decision

### Passwords (`@inmolink/platform/crypto/password`, a separate subpath so only identity loads the native binary)
- **Library:** `@node-rs/argon2` 2.2.2. It ships prebuilt N-API binaries, so it needs no install script and no `allowBuilds` entry.
- **Parameters:** Argon2id, v=0x13, `m=19456` KiB (19 MiB), `t=2`, `p=1`, 32-byte output, 16-byte random salt. This is the OWASP baseline. Each login costs about 19 MiB for tens of milliseconds, so a burst of 50 concurrent logins stays under 1 GB.
- **Upgrades:** `needsRehash(hash)` compares a stored hash with the policy. Identity rehashes on the next successful login. Raising the parameters is a policy change plus an update to this ADR. No migration is needed.
- **Limits:** inputs longer than 1024 bytes are rejected. Stored hashes whose costs exceed 4× the policy are refused, so a tampered hash cannot pin memory.
- **Timing:** `dummyVerify()` checks a precomputed policy hash when the account does not exist, so response timing does not reveal registered emails. A test fails if that constant drifts from the policy.
- **No pepper** for now. Adding one later means a keyed `secret` and a rehash on login.

### Encryption (`platform/crypto/aead.ts`)
- AES-256-GCM, 12-byte random IV, 16-byte tag. Envelope: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url).
- Keys come from env: `ENCRYPTION_KEYS=keyId:base64,...` and `ENCRYPTION_ACTIVE_KEY_ID`. New writes use the active key. Reads pick the key by the envelope's key ID.
- **Rotation:** add the new key → make it active → a worker job re-encrypts rows where `needsReencrypt()` is true (lands with the first encrypted column) → remove the old key.
- **Associated data is required:** callers build it with `aadFor({ agencyId, table, column, rowId })` (a JSON array, so the parts cannot run together). A ciphertext copied to another row, column or tenant fails authentication.
- **Boot checks:** `platform/config` parses `ENCRYPTION_KEYS` and builds the keyring at boot. With `NODE_ENV=production` it refuses key IDs starting `dev` and HMAC keys starting `dev-` (the `.env.example` values).

### HMAC
- HMAC-SHA256 with a dedicated `HMAC_KEY` (≥ 32 chars), never the encryption keys. Every call names a purpose (`fingerprint`, `idempotency`, …), and HKDF derives a subkey per purpose, so a MAC made for one purpose never verifies for another. Comparisons are constant-time.
- Third-party webhook signatures (hex, provider secret) use `verifyRawHmacSha256Hex`.
- Reset, invite and share tokens come from `newToken()` (32 random bytes). UUIDv7 IDs and listing refs are never secrets.

## Consequences
- Losing a key ID that still has ciphertexts makes that data unreadable. Keys live in the secret store and are only removed after the re-encrypt job reports zero rows.
- `@node-rs/argon2` is a native dependency. If a target platform has no prebuilt binary, the fallback is `crypto.argon2` once production runs only Node ≥ 24.7. The PHC hash format stays the same.
