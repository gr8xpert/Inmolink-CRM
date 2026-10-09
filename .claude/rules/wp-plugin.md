---
paths:
  - "apps/wp-plugin/**"
---

# WordPress plugin rules (PHP)

- PHP 8.1+, WordPress 6.4+. Namespace `Inmolink\Plugin`; PSR-4 autoload via a bundled autoloader. No runtime Composer dependencies unless vendored and prefixed (e.g., with Strauss).
- Follow WordPress Coding Standards; run PHPCS (WPCS) and Plugin Check in CI.
- Escape all output (`esc_html`, `esc_attr`, `esc_url`, `wp_kses_post`); sanitize all input; nonces on every admin form and AJAX action; capability checks on every admin page.
- The API secret key is stored with `update_option` (autoload off) and never printed to the front end. Browser calls use the publishable key only.
- Caching: transients for search results (TTL from settings, default 5 min); a mirror table for listing detail pages updated by the `/v2/changes` delta sync (WP-Cron + real cron recommended). If the API is unreachable, serve stale cache and show no error to visitors.
- Backward compatibility: every legacy shortcode and its attributes keep working (mapped to the new blocks). Removing one requires a STATUS note.
- SEO: pretty URLs per locale (Polylang/WPML aware), JSON-LD, canonical and hreflang, sitemap provider integration.
- Forms post to `/v2/leads` and `/v2/viewing-requests` server-side (no API secret in JS), protected by Turnstile.
- Text domain `inmolink`; all strings translatable; ship `.pot` plus EN/ES/NL/DE/FR/SV translations.
- Updates come from the Inmolink update server (signed package URL, version JSON). Never phone home with visitor data.
- Tests: PHPUnit with the WP test suite for API client, cache layer, shortcode mapping and URL routing.
