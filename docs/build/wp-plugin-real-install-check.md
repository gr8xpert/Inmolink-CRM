# WordPress plugin — real-install checks (S8-F21)

PHPUnit covers these against fakes of the documented Polylang / WPML behaviours. (S17-F4: the legacy settings
migration, S8-F11, and its section A are removed — the old Inmolink plugin's settings are not migrated; a v2 site is
set up with a v2 key.) Nothing here has been run on a real install yet. A person runs this list on throwaway test
sites and records the result in STATUS (S8-F21 rows). Use a staging WordPress 6.4+ with PHP 8.1+, pretty permalinks
(`/%postname%/`), the v2 plugin from the current commit, `INMOLINK_API_BASE` + a **test** secret key for a test agency
that has at least one published listing and one development.

Record for each site: WordPress, Polylang / WPML versions, URL mode, and pass / fail per line (with the URL you saw).

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
