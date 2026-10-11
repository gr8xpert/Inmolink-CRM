# ADR 0013 — Public page JavaScript budget

- **Status:** Accepted — option 1 (approved by Shahzaib, 2026-10-11)
- **Date:** 2026-10-11
- **Task:** S0 review; affects S7–S8 (hosted sites) and S15 (portal)

## Context

CLAUDE.md sets two budgets for public pages: LCP < 2.0 s on mobile, and first-load JS ≤ 120 KB gzip. The S0 review built `apps/public` for production and measured **141.7 KB gzip** on every route. That is all framework code: react-dom 70.3 KB, the Next.js app-router runtime 48.4 KB and small runtime chunks. The app has no `'use client'` file yet, and the 38.7 KB nomodule polyfill is not counted. With Next.js 16 + React 19 (ADR 0001), the 120 KB budget fails before any page code exists, and every later page can only add to it.

## Decision

**Accepted: option 1**, with long-lived immutable caching of JavaScript checked as part of the budget. The options considered:

1. **Split the budget (recommended).** Track the framework floor separately: it may not grow more than 5% over the measured 141.7 KB without a review. Route code stays at ≤ 30 KB gzip on top of the framework. LCP < 2.0 s stays the gate that users feel, and it is still checked on every public page. Hosted sites and the portal stay on Next.js (server components, a few small client islands).
2. **Change the public stack.** For example, Astro or plain server rendering with Preact islands (about 10–20 KB). This meets 120 KB, but it adds a second frontend stack next to the dashboard and changes PLAN §3 (stack) and ADR 0001.
3. **Keep 120 KB as written.** Not possible with Next.js and React 19; every public task would fail its budget.

**Caching (added at approval).** Next.js serves JS chunks with content-hashed names; they must keep `Cache-Control: public, max-age=31536000, immutable` at origin and CDN, so repeat visits download nothing. Caching does not replace the budget: most public visits are first visits to that site (search, portals, shared links), browsers partition caches per site (each hosted agency domain downloads the framework again), Core Web Vitals include cold loads, and cached JS still has to be parsed and hydrated on every page view.

## Consequences

- With option 1, CLAUDE.md's budget row for public pages reads "LCP < 2.0 s mobile · framework ≤ 149 KB gzip (141.7 + 5%) · route JS ≤ 30 KB gzip". `/perf-check` measures both numbers and checks the immutable cache header on JS chunks, and the bundle check in CI gets the same two limits.
- With option 2, a new ADR replaces the stack row of ADR 0001 for `apps/public`, and S7/S15 are planned with the new stack.
- Public-page tasks record framework JS and route JS separately in STATUS.
