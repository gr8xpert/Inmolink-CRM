-- S12-F8: each client fingerprint names the HMAC key that made it (`hmacKeyLabel`, not secret), so the rotation rehash
-- can tell when every valid registration has a current-key fingerprint (`mls.fingerprintsPending`, runbook step 10).
-- Nullable, no default: existing rows stay null (no table rewrite) until the rehash labels them.
ALTER TABLE "client_registration_fingerprints" ADD COLUMN "key_id" text;--> statement-breakpoint
ALTER TABLE "client_registration_fingerprints" ADD CONSTRAINT "client_registration_fingerprints_key_id_ck" CHECK ("client_registration_fingerprints"."key_id" is null or "client_registration_fingerprints"."key_id" ~ '^[A-Za-z0-9_-]{16}$');