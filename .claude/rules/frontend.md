---
paths:
  - "apps/web/**"
  - "apps/public/**"
  - "packages/ui/**"
  - "packages/i18n/**"
---

# Frontend rules (Next.js)

## Data flow
- **apps/web (dashboard):** talks to `apps/api` through the generated typed client in `packages/contracts`/`packages/sdk` with TanStack Query. One API for web, PWA and the future native app. No direct DB or core imports in client components.
- **apps/public (portal, selections, client portal, iFrame embeds):** server components may call **read services** from `@inmolink/core` (search, read models, site content) directly — never repos or raw tables. Use ISR/`revalidate` and cache tags; pages must be CDN-cacheable.
- Server Components by default. Add `'use client'` only for interactivity, as low in the tree as possible.

## Performance
- First-load JS budgets: public ≤ 120 KB gzip, dashboard ≤ 250 KB gzip per route. Check with the bundle analyzer when adding dependencies.
- Heavy UI (MapLibre maps, charts, rich-text editor, PDF preview, drag-and-drop) only via `next/dynamic` with a skeleton.
- Images: CDN variant URLs from `platform/storage` helpers with `sizes`/`srcset`; never full-size originals; cover image `priority` only above the fold.
- Lists over 200 rows are virtualized. Search inputs debounce 250 ms. Prefetch only primary navigation.
- No moment.js, no full lodash, no UI kits besides shadcn/ui + Tailwind.

## UI
- Components from `packages/ui` (shadcn). Add new primitives there, not inside apps.
- Forms: react-hook-form + Zod schema from `packages/contracts`; show server errors by `error.code`.
- Every string through next-intl (`packages/i18n`); no hard-coded text, dates or currencies — use the locale formatters.
- Accessibility: labelled inputs, keyboard navigation, focus states, colour contrast AA.
- Client Mode: when active, render the Client Mode banner and never request fields the server strips; do not rely on CSS hiding.

## Public SEO (apps/public)
- Locale-prefixed routes, `generateMetadata` with canonical + hreflang, JSON-LD (`RealEstateListing`, `RealEstateAgent`, `BreadcrumbList`), per-locale sitemaps.
- Deleted or moved URLs return 301 from `legacy_url_redirects` / redirect map — never 404 for a URL that existed.
- Lighthouse ≥ 90 (performance, SEO, accessibility) on listing detail, search and location pages.
