# Human actions — things only Shahzaib (or the team) can do

Claude builds around missing items with fixtures and mocks, but these set the real pace. Start the long-lead items in week 1.

| # | Action | Needed by | Lead time | Notes |
|---|---|---|---|---|
| H1 | Legacy Inmolink database dump (read-only copy) + any schema notes | S2-06, S4-04, S14 | days | Keep the dump **outside** the repo; give Claude a local connection string in `.env` |
| H2 | Legacy API access logs (≥ 30 days), legacy API base URL + test credentials, list of client websites with plugin versions | S8-01 | days | Needed to build golden files so no client site breaks |
| H3 | Accounts and keys: GitHub org, Cloudflare (DNS, R2, Turnstile; later Cloudflare for SaaS), Stripe (SEPA DD + Stripe Tax enabled), Resend, Amazon SES, Sentry, Anthropic API, embeddings provider, map tiles provider, **Meta developer app** (business verification + app review for Pages/Instagram publishing; WhatsApp Cloud API for R3) | S0-15, S12-01, S12-07, S13-01, R3 | **Meta: 2–6 weeks**; others: days | Start Meta verification immediately. **S7-07:** an R2 bucket `inmolink-feeds` (no public access) and a feed-api R2 token, Object Read only on it (`S3_FEEDS_ACCESS_KEY_ID` / `S3_FEEDS_SECRET_ACCESS_KEY`); the workers' token gets Object Read & Write on it (runbook deploy.md step 6). **S7-F3:** on `inmolink-media-work`, an R2 lifecycle rule *Abort incomplete multipart uploads* after 1 day for prefix `feed-staging/` (streamed feed images a dead job never completed; runbook deploy.md step 6) |
| H4 | Servers: 3 EU dedicated servers in 2 datacenters (app-1 + db-1 in one, db-2 in another), SSH access for deploys; plus a staging server and a small **drill host** (Docker only, disk ≥ 2× the database) for the weekly restore test | S0-15 | days | Sizes per PLAN §5.5 Stage A; addresses go into `infra/ansible/inventories/*/hosts.yml` and `infra/kamal/*.<env>.yml` |
| H5 | Domains and DNS control: inmolink.es, API hostnames, **the legacy API hostname** (for zero-touch cutover) | S0-15, S14-06 | days | |
| H6 | Portal access: Kyero, thinkSPAIN, A Place in the Sun feed specs/credentials; idealista and Fotocasa partner applications | S9-02, S9-04 | **weeks–months** for idealista/Fotocasa | Apply in S0 |
| H7 | Lawyer (Spain): terms of service, DPA, privacy and cookie policy, collaboration agreement template, client-registration rules, AI disclosure; later affiliate payouts | S16-04 (start in S10) | 4–8 weeks | |
| H8 | External penetration test vendor | S16-03 | 2–4 weeks booking | |
| H9 | Confirm pricing, founding offer and trial terms (PLAN §11) | S13-02 | — | |
| H10 | Brand direction: logo, colours, typography; attend sprint demos for UI feedback | S1-10 onward | — | |
| H11 | Pilot agencies (15–20 in one area) and every client's current provider renewal date | S14-06, S17 | — | |
| H12 | Hire/assign: onboarding & support person (migration waves), new-build data ops person (R2) | S17, R2-08 | weeks | |
| H13 | Resales Online API credentials from a consenting client agency (own listings) | S6-06 | days | Own listings only — never network data |
| H14 | Sample feeds from client agencies: Milenio+, Infocasa, Inmoba, thinkSPAIN | S6-07 | days | |
| H15 | Legacy WordPress plugin source + list of shortcodes/templates actually used on client sites | S8-03, S8-04 | days | |
| H16 | Royalty-free music licence for video reels | R3-10 | days | |
| H17 | Choose e-signature approach (built-in simple e-signature vs provider) after lawyer input | R2-05 | — | |

When an item is done, add the date and details to `STATUS.md` → **Human actions** and tell Claude in the next session.
