# ADR 0002 — Media: content addressing and deterministic variants

- **Status:** Accepted (design; implemented in S3-03 and S3-04)
- **Date:** 2026-10-11
- **Task:** S0-16 (PLAN §3 #33, §4.1, §7 M2)

## Context

At the design target there are about 60M media objects before dedup and about 30 TB after dedup (PLAN §4.1). The same photo reaches the system many times. A developer's render goes to dozens of agencies, a feed re-sends unchanged images on every run, and legacy migration re-ingests everything. A row per variant (thumb, small, medium, large, OG cover) would multiply 60M rows by five or more. Changing the resize pipeline would then need a backfill across all of them.

## Decision

1. **Content address = SHA-256 of the original bytes.** `media_objects.sha256` is unique across the platform, not per tenant. The browser hashes the file and asks `POST /media/check` (batches of up to 100 hashes) whether each hash is known. It uploads only the unknown files, through signed PUT URLs, then calls `POST /media/register`. A file that already exists anywhere transfers zero bytes.
2. **References, not copies.** Listings attach media through a per-tenant join (position, cover, kind) with a refcount on `media_objects`. Removing the last reference schedules deletion after a 7-day grace period. An orphan job deletes only unreferenced objects older than that.
3. **One normalized master** of at most 2560 px. EXIF is stripped (GPS and camera serials are PII) and HEIC is converted. The master is what variants are built from.
4. **Deterministic variant keys, no variant rows.** The key is `v{pipeline}/{sha}/{size}.webp`, plus a JPEG cover for Open Graph. A `variants_ready` bitmask on the object records which sizes exist. A missing size is generated on demand. Bumping the pipeline version produces new keys side by side, so CDN caches never serve a mix of old and new.
5. **Byte-identical regeneration.** The same pipeline version must produce the same bytes (pinned sharp/libvips settings), so a variant can be deleted and rebuilt at any time.
6. **pHash** is stored for near-duplicate detection (dedupe, R2). SHA-256 catches only exact copies.
7. **Uploads are validated by magic bytes and size**, never by extension (security rules).

## Consequences

- Storage and transfer scale with unique images, not with listings × agencies. The ~35% dedup in §4.1 comes for free.
- Hashes are global, so a client could probe "does this hash exist?" `/media/check` is authenticated and rate-limited. It returns only "known or unknown", never who owns the file or where it is used.
- Deleting shared media is refcount-driven and delayed. Erasure requests must remove references, and the orphan job does the physical delete.
- Pipeline changes are cheap: bump the version, let on-demand generation fill new keys, and expire the old prefix.
- Variant URLs are predictable from the hash. Private media (verification documents, S1-03) lives in a separate private bucket behind signed URLs, never in the public variant space.
