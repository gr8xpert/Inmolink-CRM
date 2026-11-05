# Staging QA, R1

Finished 2026-11-05 on commit `eb616816`, at 52% weekly usage (limit 70%). Test accounts and made-up data only, apart from
the Resales feed on the unverified test2. No production change.

**Verdict: pass with notes.** No high finding is open on staging. The pilot still needs H11 and the other outside items.

## Fixed during QA and retested on staging

| Task | Fix |
|---|---|
| S17-F31 | Clients can like and enquire on selection links |
| S17-F32 | Logging out revokes that session on the server |
| S17-F33 | Website and portal leads record the form's processing consent (the lawyer confirms the wording, H7) |
| S17-F34, F36, F41, F44 | Members are not offered controls the API refuses; permission messages say why |
| S17-F35, F45, F52 | Client Mode: pages closed by the API say so instead of showing errors |
| S17-F37, F43 | Selections show references, clearer board errors, Spanish property types (migration 0182 did nothing, 0183 fixed it and a check now catches the mistake) |
| S17-F38, F48, F51, F52 | No sideways scroll at 390 px on the pages found |
| S17-F39, F49, F55 | Public sitemap exists, is listed in robots.txt only while it exists, and can be overwritten on R2 |
| S17-F40 | Same "Page not found" for an unknown or foreign id |
| S17-F42 | Calendar events can be edited |
| S17-F46, F47 | Impersonation loop gone; staff acting as a member read tickets, never write, and their reads are audited |
| S17-F50, F51 | New chat from the inbox; one conversation per colleague; untitled chats show the colleague's name; per-field sign-up messages |
| S17-F52 | Bookmark wording; no false "details changed" note after approving a verification |
| S17-F53 | PDFs render in deployed workers, sandbox on, in their own container |
| S17-F54 | Portfolios up to 50 listings can be stored (smaller photos, 80 MB limit) |

## Passed on the final versions

- **Deploy:** deploy, rollback and roll-forward on `eb616816`: 14,530 health requests through Cloudflare, 0 non-200 (8m20s, 2m54s, 4m40s). 22 containers, 0 restarts, 0 out-of-memory, outbox 0 dead.
- **Selection links and white label:** a saved PUBLIC network listing renders anonymously with the presenting agency's name and its own code. No owner agency, contacts, commission or notes in the page, its JSON or the selection PDF's text.
- **PDFs:** brochure, portfolio, selection and viewing terms render from the UI or API in about 2 to 6 s. Spanish accents correct. The terms PDF names the agencies and terms and no client.
- **Onboarding:** e-mail link, forced 2FA, recovery codes, CIF checksum, document upload, staff approval, "verified" e-mail.
- **Network:** search and all filters, private, draft and under-offer listings hidden, preferred-only sharing, commission and split, no private fields in JSON or HTML.
- **Collaboration:** board, replies and closed threads; registrations and duplicate detection; viewing request, accept, reschedule, cancel, decline; viewing chat.
- **Chat privacy:** another agency gets 404 on every thread, message and read route.
- **Earlier lanes:** public website, embed, staff console, CRM, contacts import, Resales filters 1 to 3 on test2.

## Not tested

- E-mail in the last retest (earlier lanes received onboarding and alert e-mails).
- Give-to-get locked state: both verified agencies are in the welcome period.
- `REGISTRATION_CONFLICT` and lead protection across introducers: needs a third verified agency.
- One open viewing request per registration; the viewing expiry job.
- A website, portal or feed carrying network listings: both test sites are own-listings only.
- A real 50-listing portfolio: 20 and 50 were measured by DevOps with real photos and made-up text; nobody has judged the small photos on A4.
- Portal and embed browser form submit (Turnstile cannot pass in an automated browser).
- WordPress plugin: no release yet. Plugin `latest.json` uses the fixed path but has not had a second release.
- Websocket connections and a running PDF job across a container swap. The next scheduled sitemap run (only manual runs proven).

## Open findings, not fixed

**Possible gap:** the last lane found no screen for registering a client or requesting a viewing, only the API and a read-only list.

**Low:**
- Portfolio silently leaves out listings that are not public; the cover count can surprise.
- Closed bookmark button reads "Bookmark" until opened, even when saved.
- Notifications: "Viewing request updated" does not say what changed; saved-search alerts can repeat a reference; untitled chat notification ends in a colon.
- `/en/network`: clicking Map gets a 503 on the page fetch (3 of 3), the map still shows. Possibly the same as the 503s on hover; Speed Brain unconfirmed.
- No confirmation on task delete or calendar cancel; notification settings Save shows no confirmation.
- Invalid listing filters are silently ignored; contact form shows a generic error.
- List-view calendar heading range without a year.
- CSV export writes `'+` before phone numbers.
- `/v1/listings/:id/bookmarks` answers 200 for any id.
- Developments reference has odd characters; contacts table clipping fix unconfirmed; three robots meta tags on some pages.
- Dashboard with JavaScript off shows Loading; a 200 status on some not-found pages (documented, streaming).
- API key last-used updates with a delay (by design).
- Staff console cannot attach files, and its attachment reads are not separately audited.
- Support replies notify by e-mail only.
- Logout edge cases: Redis down at logout, no absolute session age, logout while impersonating, `/session/expired` GET signs out.
- A copied impersonation token against the API was not directly tested.
- Requests of 5 to 7 s about every 2 minutes on health probes, before and during deploys; cause not found.

## Needs the owner

1. H11 pilot agencies; H3, H7, H8 as in HUMAN-ACTIONS.
2. Review Parcela and Casa pareada; the lawyer confirms the form's tick as processing consent (H7).
3. Portfolio photos: are small photos sharp enough on A4? (STATUS Decisions, S17-F54.)
4. Should there be a screen to register a client and request a viewing?
5. Should STAFF_SUPPORT be able to toggle the give-to-get exemption and reach verification decisions?
6. Check the `inmolink.es` zone's Browser Cache TTL: responses show `max-age=31536000` that the app does not set (`robots.txt` went stale at the edge).

## Before production

- Fill the billing catalog: empty on staging, so no trial starts (`billing: the trial plan is not in the catalog`). Plan limits are off there. How it is meant to be filled was not traced.
- Set `SUPPORT_INBOX_EMAIL`, unset on staging: staff must watch the queue.
- The PDF role's security list in STATUS Decisions (S17-F53): own Redis user, own storage token and bucket, network limits, signing key, kernel patching, weekly browser builds.
- Confirm `inmolink-feeds` is kept apart between staging and production; empty the shared bucket names first.
- `i18n:draft` was not run: only `en` and `es` exist.

## Left on staging

- **QA data:** QA- records in test1, QA-Net Agency (created through `identity.register` by a one-off script, Turnstile untouched; verified by staff) with its 3 listings, tickets, chats, selections, bookmark folder, site "QA-Pub Embed site", listing SLT62WB2.
- **Dead jobs:** `pdf.dead` 2 and `exports.dead` 2 from before the fixes. The first terms PDF was replayed and rendered; the other belongs to a cancelled viewing. They expire after 30 days.
- `dev-staff@` was STAFF_SUPPORT during QA, back to STAFF_DATA_OPS at 12:59 UTC.
