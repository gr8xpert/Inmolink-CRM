# WordPress plugin — real-install checks (H15: S8-F11, S8-F21)

PHPUnit covers these against fakes of the documented Polylang / WPML behaviours and an **assumed** legacy-options
fixture. Nothing here has been run on a real install yet. A person runs this list on throwaway test sites and records
the result in STATUS (S8-F11 / S8-F21 rows). Use a staging WordPress 6.4+ with PHP 8.1+, pretty permalinks
(`/%postname%/`), the v2 plugin from the current commit, `INMOLINK_API_BASE` + a **test** secret key for a test agency
that has at least one published listing and one development.

Record for each site: WordPress, Polylang / WPML versions, URL mode, and pass / fail per line (with the URL you saw).

## A. Legacy settings migration (S8-F11)

1. On a site that runs the **legacy** plugin with a working key, export its options:
   `wp option list --search='*inmolink*' --format=json` (and any other option the legacy source names).
2. Compare names and array keys with `apps/wp-plugin/src/Migration/legacy-map.php` (marked ASSUMED). Fix the table,
   set `status` to `CONFIRMED`, replace `apps/wp-plugin/tests/fixtures/legacy/options.json` with the anonymised
   export (fake key in v2 format), run `pnpm wp:test`.
3. Check the legacy key's format: the v2 plugin only stores `inl_(live|test)_sk…` secret keys. If legacy keys are
   different, the migration reports `key: invalid` and the admin must enter a v2 key — decide whether a key exchange
   is needed (new task) before turning the migration on by default.
4. On a staging copy of that site: deactivate the legacy plugin, add
   `define( 'INMOLINK_MIGRATE_LEGACY_SETTINGS', true );` to wp-config.php, activate v2.
   - [ ] Settings → Inmolink shows the migrated locales / default locale / cache lifetime / listing base, and "a key is
     stored" without typing one.
   - [ ] `wp option get inmolink_legacy_migration` shows `key: migrated`.
   - [ ] `wp inmolink sync` succeeds; `wp inmolink status` shows a cursor.
   - [ ] The legacy options are unchanged (`wp option list --search='*inmolink*'` before / after).
   - [ ] Deactivate + reactivate v2 after clearing the key on the settings page: the key stays cleared.
5. When all pass: flip the default in `LegacySettings::enabled()` (or keep the constant as the opt-in) and record it.

## B. Polylang (S8-F21)

Polylang with English (default) + Spanish, Settings → Inmolink locales `en,es`, listing base `property, es:propiedad`,
development base `development, es:promocion`. Visit Settings → Permalinks once (flushes rules).

For each URL mode below, check:
   - [ ] `/property/{REF}/{slug}/` and `/es/propiedad/{REF}/{slug}/` render the listing in the right language
     (`<html lang>`, texts), status 200.
   - [ ] Same for a development (`/development/…`, `/es/promocion/…`).
   - [ ] A wrong slug 301s to the canonical URL; the `<link rel="canonical">` and hreflang alternates point at the URLs
     above (no `/es/es/`, no `/es/inicio/`).
   - [ ] `/es/propiedad/{REF}/{slug}/?lang=en` 301s to `/es/propiedad/{REF}/{slug}/`.
   - [ ] `wp rewrite list --match=/es/propiedad/{REF}/x/` shows our rule (`inmolink_listing=$matches[1]…&lang=es`),
     not a `(en|es)/…` copy with `$matches[2]`.

Modes:
1. Directory, "Hide URL language information for the default language" **on**.
2. Directory, hide default **off** (`/en/property/…`).
3. Static front page set, "The front page URL contains the language code instead of the page name" **off**
   (home is `/es/inicio/`): listing URLs must still be `/es/propiedad/…`.
4. Subdomain or domain per language (if available): `es.example.test/propiedad/…`.

## C. WPML (S8-F21)

WPML with English (default) + Spanish, same plugin settings as B.

Modes (WPML → Languages → Language URL format):
1. Different languages in directories (default language at root). Run every check of B; additionally
   - [ ] `/es/propiedad/{REF}/{slug}/` routes (WPML strips the directory before rule matching — our rules exist with
     and without `es/`); `/es/property/{REF}/{slug}/` with an identical base in both languages shows Spanish.
2. "Use directory for default language" on: `/en/property/…` routes.
3. Language name added as a parameter: listing URLs are `/propiedad/{REF}/{slug}/?lang=es` (never `?lang=es/…`),
   they render Spanish, and the canonical equals that URL.
4. A different domain per language (if available).

## D. Report

Paste the table into the S8-F21 STATUS row (and S8-F11 for A). Any failure: fix in the adapter
(`apps/wp-plugin/src/I18n/`), add a PHPUnit fake for the behaviour found (`tests/Integration/MultilingualAdaptersTest.php`),
re-run `pnpm wp:test`.
