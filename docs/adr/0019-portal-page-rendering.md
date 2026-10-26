# ADR 0019 — Portal page rendering (inmolink.es)

- **Status:** Accepted — option (A), Shahzaib 2026-10-26: keep the app-router pages and accept the measured cost until the staging measurement (H4)
- **Date:** 2026-10-26
- **Task:** S15-01 (PLAN §3 #63, §7 M14); affects S15-02 (enquiries, sitemaps, 301s) and S15-03 (profile pages)

## Context

S15-01's acceptance check is Lighthouse ≥ 90 (performance, accessibility, SEO) on the portal's search, location and
listing pages (mobile). The pages were built as PATTERNS §19 shows them: Next.js app-router server components in
`apps/public`, no client component except an opt-in map island (route JS 3.5–5.6 KB gzip, framework 131.9 KB — inside
ADR 0013's split budget).

Measured with `pnpm perf:lighthouse --runs 5` (Lighthouse 13.5, mobile, simulated throttling, CPU multiplier 4, local
production build, test stack, a quiet machine; median of 5):

| Page | Rendering | Perf | A11y | SEO | LCP | TBT |
|---|---|---|---|---|---|---|
| `/en/properties` (search) | Next.js app router | 85 | 100 | 100 | 1.81 s | 489 ms |
| `/en/properties/…/marbella` (location) | Next.js app router | 86 | 100 | 100 | 1.41 s | 564 ms |
| `/en/property/villa-in-marbella-…` (listing) | Next.js app router | 87 | 100 | 100 | 1.72 s | 528 ms |
| `/en/development/marina-heights-…` | Next.js app router | 84 | 100 | 100 | 2.41 s | 531 ms |
| `/s/<token>` (selection) | route handler, static HTML, no JS | 96 | 100 | 100 | 1.44 s | 228 ms |
| `/embed/<site>/en` (embed search) | route handler, static HTML, no JS | 100 | 100 | 100 | 1.05 s | 35 ms |
| `/embed/<site>/en/listing/<ref>` | route handler, static HTML, no JS | 100 | 100 | 100 | 1.26 s | 40 ms |

Everything but performance is at 100, and LCP is under 2 s except on the development page (2.41 s, not yet
explained). Performance is lost to **Total Blocking Time, ~500 ms on every app-router page whatever its content**:
the development page (a heading and a small table) blocks as long as the search page (20 cards and the filter form).
A trace of the listing page puts it in the framework chunk (react-dom + the app-router runtime): ~670 ms of scripting,
one long task of ~420 ms (parsing the inline RSC payload and hydrating the whole tree), plus parsing the HTML with its
duplicate RSC payload. Earlier code-side work already took what the pages themselves added (a 4,762-type filter list
in the shared test database capped at 60 options, the `NextIntlClientProvider` removed from the layout — route JS
15.7 → 5.6 KB — CDN image sizes capped for phones, the LCP image preloaded, the filter form folded behind a CSS-only
toggle on phones). What remains is the framework's fixed cost.

The host is slow for Lighthouse's calibration: `environment.benchmarkIndex` 810–874 (three runs), with the mobile
preset's CPU multiplier of 4 (calibrated for a faster desktop). Lighthouse's simulated TBT scales with the host's
observed main-thread time, so a faster reference machine (staging, H4) would score app-router pages higher — but the
zero-JS pages on the same host show the gap is real: ~450 ms of blocking that those pages do not have. Lab TBT is a
proxy for field interactivity (INP) on mid-range phones, which most portal visitors use.

## Decision

**Accepted: (A)** (Shahzaib, 2026-10-26). Two options were proposed; the recommendation was (B).

**(A) Keep app-router pages, accept the measured cost.** PATTERNS §19 stays. The portal's performance target is set
to the measured level (≥ 85 on this host) until a staging measurement (H4) on a reference machine; S15-01's
acceptance check is re-worded accordingly and re-measured on staging. No code change.
- Keeps: Next's metadata API, ISR (`revalidate`, on-demand `revalidateTag`), `notFound()` / `permanentRedirect()`,
  client navigation and prefetch if ever wanted, React server components with async data loading in components.
- Costs: ~500 ms TBT (this host) on every portal page view, the framework download (132 KB gzip) on every first
  visit; the ≥ 90 check is not met on this host and may not be on staging either (a reference host might bring TBT
  to ~250–350 ms: borderline).

**(B) Portal pages as plain HTML with zero client JS** — the way the iFrame embeds (S7-F8) and selection pages
(S12-04) are already built in the same app, and which score 96–100 on the same host.
- Each portal page becomes a route handler (`route.ts`) that reads through the same core read services
  (`website-api/portal.ts`, unchanged), renders static markup with the embeds' HTML runtime
  (`apps/public/src/embed/html/jsx-runtime.ts`: synchronous JSX to escaped strings; data is loaded before render),
  and answers with its own headers: `Cache-Control` (s-maxage + stale-while-revalidate), strong `ETag`, and the
  S7-06 edge `Cache-Tag`s of the listings shown (so a price change purges the CDN copy — app-router pages cannot set
  response headers per page and rely on short TTLs).
- The stylesheet: the Tailwind build inlined once per response or served as one immutable file (as the embeds do with
  `/embed-assets/<file>`). The map: one small hand-written script (the current `tile-map` logic, ~3 KB), loaded only
  when the visitor opens the map (`<button>` + `import()` of a static asset). S15-02's enquiry form follows the
  embeds' form (a plain POST + Turnstile's script loaded on that page only).
- What changes in PATTERNS §19: the shape becomes "public portal page = route handler + read service + HTML view",
  replacing `page.tsx` with `generateMetadata`/`revalidate`; metadata (title, canonical, hreflang, OG, JSON-LD) is
  rendered by a shared head component; `notFound()` → a 404 response rendered by the shared 404 view;
  `permanentRedirect()` → `Response` 301 (a true 301 for S15-02's legacy URLs — Next's `permanentRedirect` answers
  308); ISR → CDN caching by headers plus edge-tag purges (no Next data cache).
- What is lost: client-side navigation and prefetch (unused today: the portal links are plain `<a>`), the Next
  metadata API and `revalidateTag`, async server components (data is loaded in the handler, then rendered), and the
  `next/dynamic` convention (replaced by a plain `import()` of one asset). Dashboard and future hosted sites keep
  Next.js as ADR 0013 decided; this ADR is about the portal only.
- Size: the views are already server-only components with no hooks — they port to the HTML runtime almost as they
  are (≈ 1,200 lines of `apps/public/src/portal/ui` touched mechanically: props instead of `getTranslations`,
  `translator()` from `@inmolink/i18n/server` as the embeds use), six page files become six route handlers
  (≈ 400 lines), a shared document/head view (≈ 150 lines), the map as a static asset (≈ 120 lines), the proxy matcher
  and next.config header rules adjusted, tests reworked from `renderToStaticMarkup` to the runtime's `render` (the
  embed tests' style). Core, contracts and i18n are unchanged. Estimate: 1.5–2 days including Lighthouse, e2e and
  reviews.

**Recommendation: (B).** The portal is static, SEO-first content read mostly on phones; its only interactivity is an
opt-in map and (S15-02) a form — exactly the embeds' profile, for which the zero-JS pattern already exists, is
reviewed and scores 100 on the same host. (B) meets S15-01's acceptance check without depending on a staging host
that may still be borderline, removes ~500 ms of main-thread blocking and 132 KB of framework download from every
first visit, and gives S15-02 two things it needs (true 301s, per-response `Cache-Tag`s for purges). (A)'s gains —
client navigation, the metadata API, ISR — are either unused by the portal or replaced by the CDN caching the website
API already uses. The cost is a one-off mechanical port inside S15 before S15-02/S15-03 add more pages on the
app-router pattern.

## Consequences

- If (B) is approved: an S15 follow-up ports the portal pages (S15-01 stays open or closes with the follow-up linked);
  PATTERNS §19 is rewritten for portal pages; S15-02 (enquiries, sitemaps, 301s) and S15-03 (profiles) build on the
  route-handler pattern; `/perf-check` and `perf:lighthouse` keep gating ≥ 90 on the portal pages.
- If (A) is approved: S15-01's acceptance check and CLAUDE.md's public-page row get the measured target until the
  staging measurement (H4); PATTERNS §19 stays; the gap is recorded in STATUS and revisited after H4.
- Either way: `perf:lighthouse` is not part of CI today (CI runs `perf:bundle` only; the e2e suite asserts ≥ 90 only
  on `/s/<token>` and accessibility on the dashboard shell), so the portal's Lighthouse gate is a local / staging check.
