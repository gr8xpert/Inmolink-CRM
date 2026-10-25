/**
 * Tenant registry (PLAN §3 #32 #53, PATTERNS §2) — the single source of truth for RLS policies,
 * table grants (`pnpm db:rls`) and the generated isolation suite (`pnpm test:isolation`).
 *
 * Every table in schema `public` must appear here: tenant tables (with `agency_id`) under
 * `tenantTables`, everything else under `globalTables`. The guard fails on anything unregistered,
 * and an unregistered table gets no grants, so access fails closed.
 */
import { PLATFORM_AGENCY_ID } from '@inmolink/platform/tenancy';

/** A staff member's own row, or any row for an active super admin (their own `staff_users` row, policy staff_self). */
const SUPER_ADMIN_OR_OWN_SESSION =
  "staff_user_id = app_user_id() or exists (select 1 from public.staff_users s where s.user_id = app_user_id() and s.role = 'SUPER_ADMIN' and s.deactivated_at is null)";

export type PolicyKind = 'STRICT' | 'NETWORK_READ' | 'PUBLIC_READ';

/** Column overrides (DB column names) for rows the isolation suite seeds. */
export type SampleRow = Record<string, unknown>;

/**
 * A sample value the isolation suite replaces with the reading tenant's agency id — for predicates about
 * the reader, such as `preferred_agency_id = app_agency()` (S1-07).
 */
export const SAMPLE_READER = '{reader}';

/** Like `SAMPLE_READER`, for the reading *user* (`app_user_id()`): `userSelect` samples such as `target_user_id = app_user_id()`. */
export const SAMPLE_USER = '{user}';

/** Rows that satisfy (`visible`) and fail (`hidden`) a read predicate, so the suite can test both sides. */
export interface PredicateSamples {
  visible: SampleRow[];
  hidden: SampleRow[];
}

interface TenantBase {
  /** Values for NOT NULL columns the isolation suite cannot invent (geometry, check-constrained text, …). */
  base?: SampleRow;
  /**
   * Columns `app_user` cannot read at all, on any row (S5-05): SELECT is granted on the other columns only (ADR
   * 0016), like `userSelect.hiddenColumns`. For rows RLS shares with other agencies whose worker-only columns are no
   * reader's business; workers read them as `app_system`.
   */
  hiddenColumns?: readonly string[];
  /**
   * Columns `app_user` may read but never UPDATE (S8-F26): UPDATE is granted on every other column (a column list
   * read from the catalog when the SQL runs). Flags only a worker or script (`app_system`) may change.
   */
  userNoUpdateColumns?: readonly string[];
  /**
   * STRICT only: `app_user` may INSERT its own agency's rows and nothing else (no SELECT, UPDATE or
   * DELETE) — write-only queues such as the outbox. Reads and acknowledgements go through `withSystem()`.
   */
  appendOnly?: true;
  /**
   * History that never changes (audit logs, S1-08): no app role — `app_system` included — gets UPDATE or
   * DELETE. `app_user` reads and appends its own agency's rows (only appends with `appendOnly`),
   * `app_system` reads and appends any, and `auth` / `staff` may grant SELECT and INSERT only. Removing
   * old rows is partition retention (owner), never a statement of an app role.
   */
  immutable?: true;
  /**
   * immutable only: what an `app_user` row must also satisfy to be appended (ANDed with
   * `agency_id = app_agency()` in `own_rows`' WITH CHECK) — e.g. it names the session's own user as the
   * actor. One SQL predicate, reviewed like `networkReadSql`.
   */
  userInsert?: string;
  /**
   * STRICT only (S1-F10): `app_user` reads its own agency's rows only where `sql` holds — a predicate about
   * the reading user (`app_user_id()`), ANDed with `agency_id = app_agency()` — instead of every row
   * (`own_rows` then covers INSERT, UPDATE and DELETE only). `hiddenColumns` are not readable by `app_user`
   * at all: the generator grants SELECT on the other columns only (ADR 0016), so a new column stays
   * unreadable until `pnpm db:rls` runs. `samples` hold rows the suite's reading user (`SAMPLE_USER`) can
   * and cannot read; branches that need other rows (an admin of the agency) are tested in the owning module.
   */
  userSelect?: {
    sql: string;
    hiddenColumns?: readonly string[];
    samples: PredicateSamples;
    /**
     * S11-04: what a row must also satisfy for `app_user` to INSERT, UPDATE or DELETE it (ANDed with
     * `agency_id = app_agency()` in `own_insert` / `own_update` / `own_delete`) — e.g. `user_id = app_user_id()`, so a
     * member changes only their own rows even with a statement that reads no column. One SQL predicate per command,
     * reviewed like `networkReadSql`; the `samples.visible[0]` row must satisfy it (the suite's positive controls).
     */
    write?: { insert?: string; update?: string; delete?: string };
  };
  /**
   * Range-partitioned parent (pg_partman, PLAN §4.1). The guard checks the table is partitioned and that
   * no partition is reachable directly (partitions skip their parent's policies).
   */
  partitioned?: true;
  /**
   * appendOnly only: `app_auth` (anonymous auth flows, `withAuth()`) may INSERT platform rows
   * (`agency_id` = nil UUID) whose `column` starts with `prefix` — e.g. `identity.*` outbox events
   * ("send the verification email") in the sign-up transaction, and nothing else.
   */
  authAppend?: { column: string; prefix: string };
  /**
   * Anonymous auth flows (`app_auth`, `withAuth()`) may reach some rows: the sign-up transaction creates
   * the agency and its founding admin, and access-token minting reads the user's own membership (S1-01).
   * One SQL predicate per command, reviewed like `networkReadSql`. Each must pin rows to `app_agency()`
   * and/or `app_user_id()`, which the flow sets with `setAuthScope()`; without them nothing matches.
   * DELETE is never granted.
   */
  auth?: AuthAccess;
  /**
   * Exactly one row per agency (keyed by `agency_id`): the isolation suite's positive control updates
   * the tenant's row instead of inserting a second one.
   */
  singleRow?: true;
  /**
   * A guard trigger refuses `app_user` INSERTs the service rules do not allow (members join through
   * `app_auth`; invites need an active admin). The isolation suite's positive control then proves the
   * grant by updating the tenant's row and expects its insert to be refused.
   */
  guardedInsert?: true;
  /**
   * Staff request paths (`app_staff`, `withStaff()`, S1-03, ADR 0015) may reach rows across tenants:
   * the verification queue reads every agency's requests and decides them. One SQL predicate per
   * command (`'true'` for all rows); the generator ANDs each with `app_is_staff()`, so a staff
   * transaction whose `app.user_id` is not an active staff member sees and changes nothing. DELETE is
   * never granted; column rules (which fields staff may change) live in guard triggers.
   */
  staff?: StaffAccess;
  /**
   * The table's own (non-constraint) triggers — guard triggers and the directory sync (S1-07). The guard
   * fails if one is missing or disabled, or if the table has a trigger not listed here; their function
   * bodies are part of the catalog fingerprint `pnpm db:rls` records.
   */
  triggers?: readonly string[];
  /**
   * `app_media` (the media worker, S3-F4) may SELECT these columns of every agency's rows — for reference counts
   * of content-addressed objects (a column grant: nothing else of the row). Never writable by it.
   */
  mediaRead?: { columns: readonly string[] };
  /**
   * PUBLIC_READ or STRICT (S6-F1; STRICT since S10-F4): a table written by workers alone (`app_system`). `app_user` reads its own rows (and
   * the network rows `networkReadSql` opens) but gets no INSERT, UPDATE or DELETE grant — `own_rows` is a SELECT
   * policy — so no request path can plant or change what public paths serve.
   */
  userReadOnly?: true;
  /**
   * STRICT only (S11-F3): a job row a request creates and a worker (`app_system`) alone advances. `app_user` reads and
   * inserts its own agency's rows but gets no UPDATE or DELETE grant — a request can neither forge a run's state nor
   * remove a row (and so hide its stored file from the sweep).
   */
  userAppendRead?: true;
  /**
   * STRICT + userReadOnly only (S10-03): rows a trigger appends through these SECURITY DEFINER functions — created in
   * a migration, owned by `app_owner`, executable by no app role (triggers fire without EXECUTE). The `definer_append`
   * policy lets `app_owner` insert (forced RLS binds the owner); the guard accepts these functions as definers.
   */
  definerAppend?: { functions: readonly string[] };
  /**
   * STRICT, not userReadOnly (S11-02): a table two agencies keep in step — each changes its own row, and these SECURITY
   * DEFINER trigger functions (created in a migration, owned by `app_owner`, executable by no app role) write the other
   * agency's copy in the same statement. `app_owner` gets `definer_read`, `definer_append` and `definer_update`
   * policies (forced RLS binds the owner); never DELETE. The guard accepts these functions as definers.
   */
  definerSync?: { functions: readonly string[] };
  /**
   * `app_owner` (the owner of SECURITY DEFINER functions) may read every row (S7-03): a definer function reads the table
   * for a public path and answers less than a row (`website_network_open`: one boolean per agency). No application
   * role gains anything; forced RLS binds the owner too, hence the explicit policy.
   */
  definerRead?: true;
  /**
   * STRICT only (S7-05): `app_intake` (website form intake, `withIntake()`) may INSERT rows of the agency its
   * transaction is pinned to (`agency_id = app_agency()`) and SELECT only `selectColumns` of them (a column grant: the
   * idempotency replay reads its key and body hash, never the client's details). No UPDATE or DELETE.
   */
  intake?: { selectColumns: readonly string[] };
  /**
   * appendOnly only (S7-05): `app_intake` may INSERT rows of its pinned agency whose `column` is one of `values` — the
   * intake transaction's own outbox event — and nothing else.
   */
  intakeAppend?: { column: string; values: readonly string[] };
}

export interface AuthAccess {
  select?: string;
  insert?: string;
  update?: string;
}

export interface StaffAccess {
  select?: string;
  insert?: string;
  update?: string;
  /**
   * S6-08: `app_staff` reads only these columns (a column grant, ADR 0016's shape as an allowlist), so a row that
   * carries secrets (stored credentials, keys in URLs) never reaches a staff query path, whatever the query.
   */
  selectColumns?: readonly string[];
  /** S6-08: `app_staff` writes only these columns (needs `update`). */
  updateColumns?: readonly string[];
}

export type TenantTable = TenantBase &
  (
    | /** Own agency only. */ { kind: 'STRICT' }
    /**
     * Own agency, plus other agencies (`app_user`) may read rows matching the predicate. Never writable
     * by them. RLS shares whole rows: keep private columns in a STRICT side table. The generator ANDs
     * the predicate with `(select public.app_agency_verified())` — only verified agencies read the
     * network (S1-07); the isolation suite reads as a verified agency listed in the directory, and checks
     * that an unverified one sees nothing. Listing-style rows shared with preferred agencies only use
     * `agency_id in (select a from public.app_preferring_agencies() a)` (S1-07).
     */
    | {
        kind: 'NETWORK_READ';
        networkReadSql: string;
        samples: PredicateSamples;
      }
    /**
     * Own agency, plus `app_public` (feed-api, portal) may read matching rows — whole rows, so no private columns —
     * except `hiddenColumns`, which neither `app_user` nor `app_public` may read (S6-F1).
     */
    | {
        kind: 'PUBLIC_READ';
        publicReadSql: string;
        samples: PredicateSamples;
        /**
         * Optional: verified agencies (`app_user`) also read rows matching this predicate, as on NETWORK_READ (the
         * generator adds the same tenant and verified guard). Use an `exists` over a NETWORK_READ table, so the
         * network side follows that table's policy; the isolation suite seeds no parent row, so it checks the
         * hidden side, and the owning module tests the readable side.
         */
        networkReadSql?: string;
        /**
         * Columns `app_public` alone may not read (S7-02): `app_user` keeps them on its own rows. The public grant is a
         * column list of every other column.
         */
        publicHiddenColumns?: readonly string[];
      }
  );

export interface GlobalTable {
  /** Why this table has no `agency_id` (reviewed like an exception). */
  reason: string;
  /** `app_public` may read it (reference data used by public pages). */
  publicRead?: boolean;
  /**
   * `'auth'`: identity data (password hashes, auth tokens). Only `app_auth` (`withAuth()`) and
   * `app_system` may read or write it; `app_user` and `app_public` get nothing (S0-09, ADR 0004).
   *
   * `'staff'`: who is staff (S1-03, ADR 0015). Only `app_system` writes it; `app_staff` reads the row of
   * the user it acts for (`user_id = app_user_id()`, which `app_is_staff()` relies on), and `app_auth`
   * the row of the user its flow is scoped to (S1-04: staff must pass 2FA). Nobody else.
   */
  access?: 'auth' | 'staff';
  /**
   * Reference data the staff console edits (S2-04, e.g. the location tree): `app_staff` may SELECT, INSERT,
   * UPDATE and DELETE every row, gated by `app_is_staff()` (an active staff member). Which staff role may
   * write is the module's policy; `app_system` and the readers are unchanged. Not for `access` tables.
   */
  staffWrite?: true;
  /**
   * `access: 'auth'` only: `app_auth` reaches only the rows of the user its flow is scoped to
   * (`user_id = app_user_id()`, set by `setAuthScope`) — for per-user secrets such as 2FA (S1-04), so
   * no other auth flow can read or change another user's factor.
   */
  userScoped?: true;
  /**
   * `app_user` gets no read (no `global_read` policy, no grant): rows carry other agencies' data (listing refs,
   * feed names) or tenant mappings. Only `app_system` and, with `staffWrite`, active staff reach it (S3-F1).
   * Not with `access`. With `publicRead` (S6-F1): `app_public` reads it and `app_user` does not — public-path data
   * that would tell a tenant more than its own network view does.
   */
  noUserRead?: true;
  /**
   * With `publicRead` and `noUserRead` (S8-02): `app_public` reads only the rows matching this predicate (default: every
   * row). `publicSamples` are rows the isolation suite seeds to check both sides.
   */
  publicReadSql?: string;
  publicSamples?: PredicateSamples;
  /**
   * `app_owner` (the owner of SECURITY DEFINER functions and of the generated definer views, `rls.ts` `DEFINER_VIEWS`)
   * may read every row: the table is read through one of those only (S7-F4, S7-F10), no application role has a grant.
   * Forced RLS binds the owner too, hence the explicit policy.
   */
  definerRead?: true;
  /** `app_media` (the media worker, S3-F4) reads and writes every row; it reaches nothing else. */
  mediaWrite?: true;
  /** Values for NOT NULL columns the isolation suite cannot invent (check-constrained levels, …). */
  base?: SampleRow;
}

export interface TenantRegistry {
  tenant: Record<string, TenantTable>;
  global: Record<string, GlobalTable>;
}

/** A well-formed SHA-256 no real file has (the isolation suite's media rows; checked hex columns). */
const ISOLATION_SHA256 = '0'.repeat(64);

/** Tables with `agency_id`. Add each new tenant table here, then run `pnpm db:rls`. */
export const tenantTables: Record<string, TenantTable> = {
  // Transactional outbox: request transactions insert their own agency's events; the dispatcher
  // reads and acknowledges every agency's rows through withSystem(). Platform events use the nil UUID;
  // auth flows (app_auth) may append those too (sign-up / reset emails).
  // Staff decisions (app_staff, S1-03) append the decided agency's `agencies.*` events in the same
  // transaction — never platform (nil-agency) rows or another module's events, which workers trust.
  outbox_events: {
    kind: 'STRICT',
    appendOnly: true,
    authAppend: { column: 'type', prefix: 'identity.' },
    // Website form intake (app_intake, S7-05) appends the lead's own event for the agency its transaction is pinned to.
    intakeAppend: { column: 'type', values: ['websites.lead.received'] },
    staff: {
      insert: `(starts_with(type, 'agencies.') and agency_id <> '${PLATFORM_AGENCY_ID}'::uuid) or (type = 'taxonomy.data.changed' and agency_id = '${PLATFORM_AGENCY_ID}'::uuid)`,
    },
  },
  // The tenant itself (S1-01). Sign-up (app_auth) creates it PENDING; a repeated sign-up for an
  // unconfirmed email may rename it while it is still PENDING and not onboarded. Status changes are
  // staff-only (S1-03) — no service lets a tenant write `status`. Staff (app_staff) read every agency
  // and change only `status` (guard trigger, migration 0011).
  agencies: {
    kind: 'STRICT',
    singleRow: true,
    // S6-F1: staff's give-to-get reason is theirs (staff read it as app_staff), not the agency's to read.
    hiddenColumns: ['give_to_get_reason'],
    triggers: ['agencies_guard', 'agencies_guard_insert', 'agencies_directory_sync'],
    staff: { select: 'true', update: 'true' },
    // S7-03: `website_network_open` (SECURITY DEFINER) reads the give-to-get exemption and age for the website API.
    definerRead: true,
    auth: {
      select: `agency_id = app_agency() and status = 'PENDING' and onboarded_at is null`,
      insert: `agency_id = app_agency() and status = 'PENDING' and onboarded_at is null`,
      update: `agency_id = app_agency() and status = 'PENDING' and onboarded_at is null`,
    },
  },
  // S1-06: CHECK constraints bound every setting, so the suite's invented row needs a valid locale list.
  // S11-01: `definerRead` — the client registration trigger (`client_registrations_receipt`) reads the target owner's
  // `registration_validity_days` (nothing else) to cap a registration's validity.
  agency_settings: {
    kind: 'STRICT',
    singleRow: true,
    definerRead: true,
    auth: { insert: 'agency_id = app_agency()' },
    base: { enabled_locales: '{es}' },
  },
  // Logo, colours, contact (S1-06). Created by the agency's first profile save (app_user). S7-02: public pages
  // (`app_public`) read the branding and contact details an agency shows to clients (`agencies.publicAgencies`,
  // `agencies.ownerIdentities`).
  agency_profiles: {
    kind: 'PUBLIC_READ',
    singleRow: true,
    // Every row, for the sanitizer (an owner's published contacts are removed whether or not it is listed now);
    // the presenter reads listed agencies only. Contacts and colours only: logo and bookkeeping columns stay hidden.
    publicReadSql: 'true',
    publicHiddenColumns: ['logo_storage_key', 'logo_content_type', 'logo_size_bytes', 'logo_updated_at', 'version'],
    samples: { visible: [{}], hidden: [] },
  },
  agency_translations: { kind: 'STRICT' },
  // Membership + role (S1-01, S1-02). app_auth reads only the user it is signing in, and writes only
  // the membership of the user it is signing up or who accepts an invite. Tenant sessions change only
  // role and deactivation, as an admin, never their own (guard trigger, migration 0008).
  // Staff (S1-09) read every agency's members: the tenant detail lists them, and an impersonation session
  // may only target an active member (0026 guard). Staff never write memberships.
  // S10-06: `definerRead` — the calendar feed's definer lookup checks the feed's member is active (and in a CRM role)
  // and reads member attendees' names. A definer function bypasses `own_rows`: every one that reads this table must
  // filter by the agency it serves (`agency_id = …`).
  agency_members: {
    kind: 'STRICT',
    definerRead: true,
    guardedInsert: true,
    triggers: ['agency_members_guard'],
    staff: { select: 'true' },
    auth: {
      select: 'user_id = app_user_id()',
      // Sign-up: the agency is one app_auth can see (the PENDING, not-onboarded agency being signed
      // up). Invite: this user accepted an invite of this agency for exactly this role.
      insert:
        'agency_id = app_agency() and user_id = app_user_id() and exists (select 1 from agencies a where a.agency_id = app_agency() union all select 1 from agency_invites i where i.agency_id = app_agency() and i.accepted_user_id = app_user_id() and i.role = agency_members.role)',
      update:
        'agency_id = app_agency() and user_id = app_user_id() and exists (select 1 from agencies a where a.agency_id = app_agency())',
    },
  },
  // Invites (S1-02). Admins create and revoke them (guard trigger); the email job sets the token. The
  // accept flow (app_auth) pins its scope to the agency named in the link, reads that agency's open
  // invites, and marks one accepted by the user it just created. The coalesce reads "open, or
  // accepted by the scoped user" (`accepted_user_id` is set together with `accepted_at`).
  agency_invites: {
    kind: 'STRICT',
    guardedInsert: true,
    triggers: ['agency_invites_guard'],
    auth: {
      select:
        'agency_id = app_agency() and coalesce(accepted_user_id, app_user_id()) is not distinct from app_user_id()',
      // Only with a user in scope, never a revoked invite; the guard trigger (0009) limits it to
      // marking an open invite accepted by that user.
      update:
        'agency_id = app_agency() and revoked_at is null and coalesce(accepted_user_id, app_user_id()) = app_user_id()',
    },
  },
  // Verification (S1-03). The agency submits requests and uploads documents; staff read every agency's
  // and decide requests. Guard triggers (0011): tenants never change a request after submitting it,
  // nor a document once attached; staff change only the decision columns of an open request.
  agency_verification_requests: {
    kind: 'STRICT',
    staff: { select: 'true', update: 'true' },
    triggers: ['agency_verification_requests_guard'],
  },
  agency_verification_documents: {
    kind: 'STRICT',
    staff: { select: 'true' },
    triggers: ['agency_verification_documents_guard'],
  },
  // Website API keys (S1-05). Agency admins manage their own; feed-api (app_public) authenticates a
  // request by prefix before it knows the tenant, so it reads usable keys of every agency: the stored
  // hash is an HMAC under HMAC_KEY of a 256-bit secret, and the rest is metadata the API enforces.
  // `agency_active` mirrors the agency status (app_public cannot read `agencies`).
  // Inserts need the session's own user as creator (guard trigger 0018), which the suite cannot fake.
  api_keys: {
    kind: 'PUBLIC_READ',
    guardedInsert: true,
    // S8-F26: the legacy-query-key mark (S8-02) is set by the key import / `pnpm legacy:key-flag` (app_system) only.
    userNoUpdateColumns: ['legacy_query_key'],
    triggers: ['api_keys_guard'],
    publicReadSql: 'revoked_at is null and agency_active',
    samples: {
      visible: [{}],
      hidden: [{ revoked_at: '2026-01-01T00:00:00Z' }, { agency_active: false }],
    },
  },
  // Agency websites (S7-01): the website API (feed-api, `app_public`) reads a key's site before it has a tenant
  // session. Public website configuration only (prefix, locales, public contact overrides, inventory policy).
  // S7-04 (S7-01 Decision 6): `created_by` is not public (a member's id); the guard (migration 0093) lets tenants
  // create a site only as the session user at version 1, change it only with version + 1, and never delete one.
  website_sites: {
    kind: 'PUBLIC_READ',
    publicReadSql: 'true',
    publicHiddenColumns: ['created_by'],
    guardedInsert: true,
    triggers: ['website_sites_guard'],
    base: { mode: 'WIDGET', locales: '{en}', default_locale: 'en' },
    samples: { visible: [{}], hidden: [] },
  },
  // Per-site XML feeds (S7-07): feed-api (`app_public`) looks a feed token's keyed hash up before it has a tenant
  // session; a revoked feed is invisible to it. The admin who set the token and the last run's error are not public.
  website_feeds: {
    kind: 'PUBLIC_READ',
    publicReadSql: 'revoked_at is null',
    publicHiddenColumns: ['created_by', 'last_error', 'idempotency_hash'],
    base: { token_hint: 'abcd' },
    samples: { visible: [{}], hidden: [{ revoked_at: '2026-01-01T00:00:00Z' }] },
  },
  // Portal connections (S9-01): an agency's feeds to Kyero, thinkSPAIN, … Credentials are an encrypted envelope, the
  // feed token only a keyed hash. S9-03: feed-api (app_public) never reads the table; the SECURITY DEFINER lookup
  // `portal_feed_by_token(hash)` (owner app_owner, `definerRead`) answers the served file of one live token and no
  // other column — never the credentials.
  // S10-F4: the credentials envelope and the token hash are never read on a request path (the push job reads the
  // envelope as app_system; the token hash only through the definer lookup); the served file, the nightly mark and the
  // push stop are worker state app_user cannot change (a change of credentials or on/off clears the stop: its trigger).
  agency_portal_connections: {
    kind: 'STRICT',
    base: { channel_code: 'isolation-portal', name: 'Isolation', token_hint: 'abcd' },
    definerRead: true,
    hiddenColumns: ['credentials_enc', 'token_hash'],
    userNoUpdateColumns: [
      'feed_run_id',
      'feed_sha256',
      'feed_bytes',
      'feed_item_count',
      'feed_generated_at',
      'push_error',
      'nightly_at',
    ],
    triggers: ['agency_portal_connections_push_retry'],
  },
  portal_connection_properties: { kind: 'STRICT', base: { action: 'INCLUDE' } },
  // Listings a connection's last run left out and why (S9-02).
  portal_connection_issues: { kind: 'STRICT', base: { errors: '[]', checked_at: '2026-01-01T00:00:00Z' } },
  // A connection's feed runs (S9-03): written by the generator, read by the dashboard (S10-F4: SELECT only for app_user).
  portal_feed_runs: {
    kind: 'STRICT',
    userReadOnly: true,
    base: {
      trigger: 'EVENT',
      status: 'WRITTEN',
      started_at: '2026-01-01T00:00:00Z',
      finished_at: '2026-01-01T00:00:00Z',
    },
  },
  // Push portals' per-listing state (S9-04): the portal's id and the hash of the payload last sent. Written by the push
  // job (app_system) only; the dashboard reads it (S10-F4: SELECT only for app_user).
  portal_listing_sync: {
    kind: 'STRICT',
    userReadOnly: true,
    base: { state: 'SYNCED', payload_hash: 'isolation', synced_at: '2026-01-01T00:00:00Z' },
  },
  // Inbound website leads (S7-05): STRICT to the presenting agency (the site's, PLAN §3 #12) — a network listing's
  // owner never reads the client's details. feed-api writes them as `app_intake` (`withIntake`, pinned to the site's
  // agency) and reads back only the idempotency columns; the worker acknowledges them as `app_system`.
  website_leads: {
    kind: 'STRICT',
    intake: { selectColumns: ['id', 'site_id', 'idempotency_hash', 'request_hash', 'kind', 'created_at'] },
    base: {
      kind: 'ENQUIRY',
      verification: 'TURNSTILE',
      request_hash: 'x',
      locale: 'en',
      name: 'Iso Fixture',
      email: 'iso@example.com',
      email_hash: 'x',
      key_tier: 'STANDARD',
    },
  },
  // Directory of verified agencies (S1-07): name and kind only. Verified agencies read the listed rows
  // (find a partner, show partner names). A trigger on `agencies` keeps it in step in the status change's
  // transaction — staff decisions (app_staff) and app_system. Tenants never write it, and staff write only
  // what `agencies` says (guard trigger, migration 0022); app_user's grant is proven by a no-op update.
  // The `listed = false` side is tested in the agencies module (one row per agency: the suite seeds one).
  // S7-02: public pages (`app_public`) read the rows too — the presenting agency's name on its websites (listed
  // agencies, `agencies.publicAgencies`) and the owner names the white-label sanitizer removes (`ownerIdentities`). The network side is tested in the
  // agencies module (the suite seeds network members for NETWORK_READ tables only).
  agency_directory: {
    kind: 'PUBLIC_READ',
    singleRow: true,
    // Every row (S7-02 security review): the white-label sanitizer removes an owner's name whether or not it is
    // listed now; a directory row holds only name, kind and listed.
    publicReadSql: 'true',
    networkReadSql: 'listed',
    // S11-05: `chat_threads_mirror` (SECURITY DEFINER) checks both agencies of a network reply thread are listed.
    definerRead: true,
    staff: { select: 'true', insert: 'true', update: 'true' },
    samples: { visible: [{ listed: true }], hidden: [] },
    triggers: ['agency_directory_guard'],
  },
  // Preferred agencies (S1-07, PLAN §3 #57): the relationship only. The preferred agency reads the rows
  // naming it whose owner is listed (VERIFIED) — what `app_preferring_agencies()` returns to listing
  // policies; a suspended owner's relationships are invisible. Admins of a verified agency add verified
  // agencies, at most 200; rows are never updated (guard trigger 0022). Notes are in the STRICT table below.
  preferred_agencies: {
    kind: 'NETWORK_READ',
    guardedInsert: true,
    networkReadSql:
      'preferred_agency_id = app_agency() and exists (select 1 from public.agency_directory d where d.agency_id = preferred_agencies.agency_id and d.listed)',
    samples: { visible: [{ preferred_agency_id: SAMPLE_READER }], hidden: [{}] },
    triggers: ['preferred_agencies_guard'],
  },
  // The owner's internal note on a preferred agency (S1-07): never visible to the preferred agency.
  // Admins only (guard trigger 0022).
  preferred_agency_notes: { kind: 'STRICT', guardedInsert: true, triggers: ['preferred_agency_notes_guard'] },
  // Audit log (S1-08): append-only, monthly partitions, no UPDATE/DELETE/TRUNCATE for anyone (grants, and
  // triggers for the owner, migration 0024). Rows name who acted, and each role may only name itself:
  // - members' request transactions (app_user) append their agency's rows as their own user, never as
  //   staff. `impersonated_by` must equal the transaction's `app.impersonated_by` (S1-09: set by `withTenant`
  //   for an impersonated session, whose row the request ctx checks first), so an impersonated request
  //   cannot write a row without the staff member, nor a normal one name someone.
  // - login, 2FA and invite flows (app_auth) append `identity.*` rows about the user they are scoped to,
  //   under that user's membership agency (the nil agency without one) — checked here, not trusted from
  //   the caller — as that user or anonymous, never impersonated.
  // - staff (app_staff) append staff and agencies rows naming themselves, and read every row (S1-09).
  audit_logs: {
    kind: 'STRICT',
    immutable: true,
    partitioned: true,
    triggers: ['audit_logs_immutable', 'audit_logs_no_truncate'],
    base: { type: 'iso.fixture', actor_kind: 'user' },
    userInsert: `actor_user_id is not distinct from app_user_id() and actor_kind <> 'staff' and impersonated_by is not distinct from app_impersonated_by()`,
    auth: {
      insert: `agency_id = app_agency() and agency_id = coalesce((select m.agency_id from public.agency_members m where m.user_id = app_user_id()), '${PLATFORM_AGENCY_ID}'::uuid) and target_type = 'user' and target_id = app_user_id() and starts_with(type, 'identity.') and impersonated_by is null and actor_kind in ('user', 'anonymous') and coalesce(actor_user_id, app_user_id()) = app_user_id()`,
    },
    staff: {
      select: 'true',
      insert: `actor_kind = 'staff' and actor_user_id = app_user_id() and impersonated_by is null and split_part(type, '.', 1) in ('staff', 'agencies')`,
    },
  },
  // S12-01: AI gateway usage (ADR 0008). Calls and monthly spend are written by the gateway as app_system only (the
  // budget check must not be forgeable by a request); members read their own agency's rows (usage page).
  ai_jobs: {
    kind: 'STRICT',
    userReadOnly: true,
    base: {
      feature: 'test.feature',
      kind: 'GENERATE',
      model: 'test-model',
      input_hash: '0'.repeat(64),
      status: 'SUCCEEDED',
    },
  },
  ai_usage_monthly: { kind: 'STRICT', userReadOnly: true, base: { month: '2026-01-01' } },
  // S12-01: thumbs up/down on AI outputs — members append and read their agency's; nobody edits or deletes them.
  ai_feedback: { kind: 'STRICT', userAppendRead: true, base: { feature: 'test.feature', rating: 1 } },
  // S10-08: data export runs (contacts, leads, listings, the account ZIP) — the agency's own; counts and codes only,
  // the exported file lives in the private bucket. Admins create them, the worker runs them. S11-F3: rows are
  // worker-only once created — claimed, recorded and expired as `app_system` — so app_user (an admin's request) reads
  // and inserts but cannot update (mark a run succeeded, extend its expiry) or delete (hide a file from the sweep).
  data_export_jobs: {
    kind: 'STRICT',
    base: { kind: 'CONTACTS', format: 'csv', status: 'FAILED' },
    userAppendRead: true,
  },
  // Staff impersonation sessions (S1-09), under the agency acted on. An impersonated request reads its own
  // session row (app_user, own agency) to check it is still open; tenants never write it (guard 0026; a
  // no-op update proves the grant). The access-token mint (app_auth) reads the staff member's own rows;
  // staff start only their own sessions and end their own; super admins also see and end anyone's (S1-F9).
  // Rows hold the staff member's reason: `app_user` reads a row only as the member it targets (the per-request
  // `findMemberAccess` check) or as an admin of the agency (`GET /v1/staff-access`), and never `staff_user_id`
  // (S1-F10, ADR 0016). The admin side is tested in the identity module.
  staff_impersonations: {
    kind: 'STRICT',
    guardedInsert: true,
    userSelect: {
      sql: `target_user_id = app_user_id() or exists (select 1 from public.agency_members m where m.agency_id = app_agency() and m.user_id = app_user_id() and m.role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN') and m.deactivated_at is null)`,
      hiddenColumns: ['staff_user_id'],
      samples: { visible: [{ target_user_id: SAMPLE_USER }], hidden: [{}] },
    },
    triggers: ['staff_impersonations_guard'],
    base: {
      reason: 'isolation fixture reason',
      started_at: '2100-01-01T00:00:00Z',
      expires_at: '2100-01-01T00:30:00Z',
    },
    auth: { select: 'staff_user_id = app_user_id()' },
    staff: {
      select: SUPER_ADMIN_OR_OWN_SESSION,
      insert: 'staff_user_id = app_user_id()',
      update: SUPER_ADMIN_OR_OWN_SESSION,
    },
  },
  // Listings (S3-01, PLAN §6, §3 #57). Other verified agencies read a listing that is SHARED or PUBLIC,
  // ACTIVE and not deleted, while its owner is listed in the directory (VERIFIED: a suspended owner's
  // listings leave the network) — and with share scope PREFERRED only if the owner prefers the reader.
  // Only shareable columns: private ones (S4-F1: also the feed reference and quality score) live in
  // `property_privates`. A listing unconfirmed for 120 days leaves
  // the network (S3-08: `network_hidden_at`, set by the freshness sweep, cleared by a confirmation).
  properties: {
    kind: 'NETWORK_READ',
    // S7-03: `website_network_open` (SECURITY DEFINER) counts the agency's network-shared listings for the website API.
    definerRead: true,
    networkReadSql: `visibility in ('SHARED', 'PUBLIC') and status = 'ACTIVE' and deleted_at is null
      and network_hidden_at is null
      and exists (select 1 from public.agency_directory d where d.agency_id = properties.agency_id and d.listed)
      and (share_scope = 'ALL' or agency_id in (select a from public.app_preferring_agencies() a))`,
    samples: {
      visible: [
        { visibility: 'SHARED', status: 'ACTIVE' },
        { visibility: 'PUBLIC', status: 'ACTIVE' },
      ],
      hidden: [
        { visibility: 'PRIVATE', status: 'ACTIVE' },
        { visibility: 'SHARED', status: 'DRAFT' },
        { visibility: 'SHARED', status: 'SOLD' },
        { visibility: 'SHARED', status: 'ACTIVE', deleted_at: new Date() },
        { visibility: 'SHARED', status: 'ACTIVE', share_scope: 'PREFERRED' },
        { visibility: 'SHARED', status: 'ACTIVE', network_hidden_at: new Date() },
      ],
    },
  },
  // A listing's private fields (cadastral reference, seller, internal notes, keys): owner agency only.
  property_privates: { kind: 'STRICT' },
  // Listing documents (S3-F5): the owner agency's only, never the network or websites.
  listing_documents: {
    kind: 'STRICT',
    base: { file_name: 'isolation.pdf', content_type: 'application/pdf', size_bytes: 1, sha256: ISOLATION_SHA256 },
  },
  // A listing's translations, features and media: readable wherever the listing itself is (the `exists`
  // runs under the reader's RLS on `properties`; the composite FK keeps the row's agency the listing's).
  // The generated suite seeds no parent listing, so these rows are hidden there; the readable side is
  // tested in the properties module (`schema.int.test.ts`).
  property_translations: {
    kind: 'NETWORK_READ',
    networkReadSql: 'exists (select 1 from public.properties p where p.id = property_translations.property_id)',
    base: { locale: 'es' },
    samples: { visible: [], hidden: [{}] },
  },
  property_features: {
    kind: 'NETWORK_READ',
    networkReadSql: 'exists (select 1 from public.properties p where p.id = property_features.property_id)',
    samples: { visible: [], hidden: [{}] },
  },
  property_media: {
    kind: 'NETWORK_READ',
    // Documents (nota simple, contracts: seller names, DNI, cadastral data) never leave the owner agency.
    networkReadSql:
      "kind <> 'DOCUMENT' and exists (select 1 from public.properties p where p.id = property_media.property_id)",
    base: { sha256: ISOLATION_SHA256 },
    samples: { visible: [], hidden: [{}] },
    // the media worker counts references to each stored object (S3-F4): the hash, nothing else
    mediaRead: { columns: ['sha256'] },
  },
  // Read models (S5-01): written by the search worker (`withSystem`), read by public paths (`app_public`) only
  // where `public` (a PUBLIC listing, a unit of an OPEN development). Client-safe fields only, by construction.
  // Network search (S5-05) hydrates its results from them: a verified agency reads another's read model exactly
  // where it may read the listing or unit itself (the `exists` runs under the reader's RLS on `properties` /
  // `units`: share scope, preferred agencies, freshness, development access). Readable side tested in search.
  // S6-F1: only the worker writes them (no user DML); `public` is false for an owner agency that is not VERIFIED.
  listing_read_models: {
    kind: 'PUBLIC_READ',
    userReadOnly: true,
    publicReadSql: 'public',
    // Index-only: who a PRIVATE_NETWORK development is shared with, and a listing's share scope (security review);
    // unreadable by app_user and app_public alike (S6-F1). S6-F2: the owner's preferred list (on its PREFERRED
    // listings) and the freshness flag are index-only too.
    hiddenColumns: ['share_scope', 'allowed_agency_ids', 'network_hidden', 'preferred_agency_ids'],
    networkReadSql: `(kind = 'LISTING' and exists (select 1 from public.properties p where p.id = listing_read_models.target_id))
      or (kind = 'UNIT' and exists (select 1 from public.units u where u.id = listing_read_models.target_id))`,
    base: {
      kind: 'LISTING',
      locale: 'en',
      public: false,
      status: 'ACTIVE',
      version: 1,
      card: '{}',
      detail: '{}',
      etag: 'x',
    },
    samples: { visible: [{ public: true }], hidden: [{ public: false }] },
  },
  // Price and status history: the owner's, not shared, append-only (members read and append, never rewrite).
  property_price_histories: { kind: 'STRICT', immutable: true },
  property_status_histories: { kind: 'STRICT', immutable: true },
  // S3-07: the agency's tags on its listings (internal), members' saved list views and bulk action records.
  property_tags: { kind: 'STRICT', base: { tag: 'isolation' } },
  listing_views: { kind: 'STRICT', base: { name: 'isolation view', columns: '{ref}' } },
  // S3-09: members' bookmark folders and the listings saved in them (private to the member). S4-F1: a member reads
  // only their own (`user_id = app_user_id()`), not only through the app's filter — colleagues' notes stay theirs.
  bookmark_folders: {
    kind: 'STRICT',
    base: { name: 'isolation folder' },
    userSelect: { sql: 'user_id = app_user_id()', samples: { visible: [{ user_id: SAMPLE_USER }], hidden: [{}] } },
  },
  listing_bookmarks: {
    kind: 'STRICT',
    userSelect: { sql: 'user_id = app_user_id()', samples: { visible: [{ user_id: SAMPLE_USER }], hidden: [{}] } },
  },
  // `total` must equal the number of listing ids (CHECK); one action waiting per member (partial unique index)
  listing_bulk_actions: { kind: 'STRICT', base: { type: 'STATUS', listing_ids: '{}', total: 0 } },
  // S3-10: an agency's own text for listings it presents — used only in its own channels. S7-02: its websites read
  // them as `app_public` (feed-api, `properties.siteOverrides`, always filtered by the site's agency): only overrides
  // of targets public paths may show (a public read model of the listing or unit, or of a unit of the development).
  // The readable side is tested in the websites module (the suite seeds no read model).
  listing_overrides: {
    kind: 'PUBLIC_READ',
    publicReadSql: `(target_kind = 'DEVELOPMENT' and exists (select 1 from public.listing_read_models r
        where r.development_id = listing_overrides.target_id and r.public))
      or (target_kind <> 'DEVELOPMENT' and exists (select 1 from public.listing_read_models r
        where r.target_id = listing_overrides.target_id and r.public))`,
    samples: { visible: [], hidden: [{}] },
    base: {
      target_kind: 'LISTING',
      target_id: '00000000-0000-4000-8000-000000000010',
      locale: 'en',
      title: 'isolation override',
    },
  },
  // New developments (S4-01, PLAN §6, §3 #21). Other verified agencies read a development that is not deleted,
  // while its owner is listed in the directory, and that is OPEN or PRIVATE_NETWORK with a `development_access`
  // row naming them (the `exists` runs under the reader's RLS on `development_access`). The allowed side of
  // PRIVATE_NETWORK is tested in the developments module (`schema.int.test.ts`): the suite seeds no access row.
  developments: {
    kind: 'NETWORK_READ',
    networkReadSql: `deleted_at is null
      and exists (select 1 from public.agency_directory d where d.agency_id = developments.agency_id and d.listed)
      and (access = 'OPEN' or exists (select 1 from public.development_access a
        where a.development_id = developments.id and a.allowed_agency_id = app_agency()))`,
    // Owner-only data on a shared row (S5-F1): the legacy import's key is read as app_system only.
    hiddenColumns: ['legacy_id'],
    samples: {
      visible: [{ access: 'OPEN' }],
      hidden: [{ access: 'PRIVATE_NETWORK' }, { access: 'OPEN', deleted_at: new Date() }],
    },
  },
  // The agencies a PRIVATE_NETWORK development is shared with: the allowed agency reads the rows naming it.
  development_access: {
    kind: 'NETWORK_READ',
    networkReadSql: 'allowed_agency_id = app_agency()',
    samples: { visible: [{ allowed_agency_id: SAMPLE_READER }], hidden: [{}] },
  },
  // A development's translations, phases, units and shared documents: readable wherever the development is
  // (composite FKs keep the row's agency the development's). Readable side tested in the developments module.
  development_translations: {
    kind: 'NETWORK_READ',
    networkReadSql: 'exists (select 1 from public.developments d where d.id = development_translations.development_id)',
    base: { locale: 'es' },
    samples: { visible: [], hidden: [{}] },
  },
  development_phases: {
    kind: 'NETWORK_READ',
    networkReadSql: 'exists (select 1 from public.developments d where d.id = development_phases.development_id)',
    samples: { visible: [], hidden: [{}] },
  },
  units: {
    kind: 'NETWORK_READ',
    networkReadSql: 'exists (select 1 from public.developments d where d.id = units.development_id)',
    samples: { visible: [], hidden: [{}] },
  },
  development_documents: {
    kind: 'NETWORK_READ',
    networkReadSql:
      'shared and exists (select 1 from public.developments d where d.id = development_documents.development_id)',
    // Which member uploaded a file is the owner's internal record, not the reader's (S5-F1): app_system only.
    hiddenColumns: ['uploaded_by'],
    base: { content_type: 'application/pdf', sha256: ISOLATION_SHA256 },
    samples: { visible: [], hidden: [{}, { shared: true }] },
  },
  // Price list versions (AI extraction, review, diffs) and unit price history: the owner's workflow, not shared.
  price_lists: { kind: 'STRICT' },
  unit_price_histories: { kind: 'STRICT', immutable: true },
  unit_status_histories: { kind: 'STRICT', immutable: true },
  // S6-01: feed imports — connections (encrypted credentials), runs, per-item errors and mapping profiles are the
  // agency's own; the worker reads and writes them as the agency (`withTenant`), the scheduler via `withSystem`.
  feed_mapping_profiles: { kind: 'STRICT', base: { name: 'Isolation mapping', connector: 'isolation' } },
  // S6-08: staff read every agency's connections and runs (import health dashboard) and resume a connection the
  // anomaly guard paused (the service writes only the pause columns; the change is audited).
  feed_connections: {
    kind: 'STRICT',
    // S7-F1: staff's resume reason is theirs (like the give-to-get reason, S6-F1), not the agency's to read.
    hiddenColumns: ['staff_resume_reason'],
    // Column grants (S6-08 security review): never the URL (keys in query strings), credentials or settings; writes
    // only to the pause and the schedule slot a resume sets.
    staff: {
      select: 'true',
      update: 'true',
      selectColumns: [
        'id',
        'agency_id',
        'name',
        'connector',
        'enabled',
        'schedule_minutes',
        'next_run_at',
        'last_run_at',
        'last_run_state',
        'paused_at',
        'pause_reason',
        'pause_details',
        'paused_run_id',
        'accept_anomaly_once',
        'staff_resume_reason',
        'content_changed_at',
        'version',
        'created_at',
        'updated_at',
      ],
      updateColumns: [
        'paused_at',
        'pause_reason',
        'pause_details',
        'paused_run_id',
        'accept_anomaly_once',
        'staff_resume_reason',
        'next_run_at',
        'version',
        'updated_at',
      ],
    },
    base: { name: 'Isolation feed', connector: 'isolation', url: 'https://feeds.example.com/isolation.xml' },
  },
  feed_runs: { kind: 'STRICT', staff: { select: 'true' }, base: { trigger: 'MANUAL' } },
  // S7-F1: tombstones of uploaded sheets deleted from storage (the agency's own; the sweep writes them via withSystem).
  feed_sheet_releases: { kind: 'STRICT' },
  feed_item_errors: { kind: 'STRICT', base: { position: 0, code: 'ISOLATION' } },
  // S6-F4: per-connection source hashes of feed records (the agency's own; written in the batch transaction).
  feed_source_hashes: { kind: 'STRICT', base: { external_ref: 'isolation', hash: ISOLATION_SHA256 } },
  // S6-02: the feed references a run saw (the agency's own feed runs; written in the batch transaction).
  property_import_seen: { kind: 'STRICT', base: { external_ref: 'isolation' } },
  // S6-02: feed import staging (UNLOGGED); a batch's rows live and die inside its transaction.
  property_import_staging: {
    kind: 'STRICT',
    base: {
      ref: 'isolation',
      hash: ISOLATION_SHA256,
      held: '{}',
      status: 'ACTIVE',
      transaction_type: 'SALE',
      currency: 'EUR',
      price_on_request: false,
      location_precision: 'APPROX',
      feature_ids: '{}',
      translations: '[]',
      new_ref: 'ISOLATN1',
    },
  },
  // S6-02: a listing's feed image URLs waiting for the media worker, and URL → content hash (hash-first). The
  // generated suite seeds no parent listing for the queue (composite FK); its own rows are tested in media.
  feed_image_queue: { kind: 'STRICT', base: { urls: '{https://example.com/a.jpg}' } },
  feed_image_sources: { kind: 'STRICT', base: { url_key: ISOLATION_SHA256, sha256: ISOLATION_SHA256 } },
  // S10-01: CRM contacts (the agency's clients: PII), their e-mails, phones, notes and CSV imports — own agency only.
  // S10-06: `definerRead` — the calendar feed's definer lookup reads a contact attendee's name (nothing else). A definer
  // function bypasses `own_rows`: every one that reads this table must filter by the agency it serves (`agency_id = …`).
  contacts: { kind: 'STRICT', definerRead: true, base: { types: '{BUYER}', source: 'MANUAL' } },
  contact_emails: { kind: 'STRICT', base: { email: 'isolation@example.com' } },
  contact_phones: { kind: 'STRICT', base: { phone: '+34600000000' } },
  contact_notes: { kind: 'STRICT', base: { body: 'isolation' } },
  contact_facets: { kind: 'STRICT', base: { facet: 'tag:isolation' } },
  contact_imports: {
    kind: 'STRICT',
    base: { file_kind: 'csv', file_bytes: 1, status: 'UPLOADED', on_duplicate: 'SKIP', errors: '[]' },
  },
  // S10-02: CRM leads — the holder's only (the client, the message: PII). When the target is another agency's (a
  // network listing, a developer's unit) the holder also writes a `lead_introductions` row, which the target's owner
  // reads (`owner_agency_id = app_agency()`, verified readers only): introducer, source and target — no client column
  // exists there, so the owner never reads the client's details (PLAN §3 #12). The owner cannot write it (NETWORK_READ
  // rows are never writable by readers); nobody changes or removes it (immutable: the holder appends it with the lead,
  // and the lead's deletion cascades as the table owner). The readable side with a real lead is tested in the crm
  // module.
  // S10-03: `leads_stage_guard` (BEFORE INSERT / UPDATE OF stage_id, status) refuses a status that is not its stage's;
  // `leads_stage_history` (AFTER) appends the move through a definer function (`lead_stage_history`). The suite's rows
  // name a stage it does not create (its own insert then fails the FK, after RLS).
  leads: {
    kind: 'STRICT',
    base: {
      source: 'MANUAL',
      kind: 'ENQUIRY',
      status: 'NEW',
      stage_id: '01900000-0000-7000-8000-00000000a003',
      stage_rank: 'i',
    },
    triggers: ['leads_stage_guard', 'leads_stage_history'],
  },
  // S10-03: the agency's pipeline stages (names, order, the status each stands for) — own agency only.
  // `pipeline_stages_guard`: app_user never deletes one (archived instead) nor changes its status, seed key, agency or
  // idempotency hashes.
  pipeline_stages: {
    kind: 'STRICT',
    base: { status: 'IN_PROGRESS', position: 0, name: 'isolation' },
    triggers: ['pipeline_stages_guard'],
  },
  // S10-03: every stage a lead entered (time in stage, reports) — own agency only, read-only for app_user: only the
  // `leads_stage_history` trigger appends (`lead_stage_history_append()`, SECURITY DEFINER owned by app_owner, through
  // the `definer_append` policy). The lead's deletion cascades.
  lead_stage_history: {
    kind: 'STRICT',
    userReadOnly: true,
    definerAppend: { functions: ['lead_stage_history_append'] },
  },
  // S11-F10: the report rollups (leads per stage now; moves per UTC day and stage; response seconds per UTC day and
  // first responder) — own agency
  // only, worker-written (`app_system` rebuilds them from `leads`): no request path can plant a report's numbers.
  crm_stage_counts: { kind: 'STRICT', userReadOnly: true, base: { leads: 1, entered_epoch_sum: 0 } },
  crm_response_rollups: {
    kind: 'STRICT',
    userReadOnly: true,
    base: { day: '2026-01-01', leads: 1, responded: 0, seconds_sum: 0 },
  },
  crm_stage_move_rollups: {
    kind: 'STRICT',
    userReadOnly: true,
    base: { day: '2026-01-01', entered: 1, exited: 0, stay_sum: 0 },
  },
  lead_introductions: {
    kind: 'NETWORK_READ',
    immutable: true,
    networkReadSql: 'owner_agency_id = app_agency()',
    base: { source: 'WEBSITE', kind: 'ENQUIRY', target_kind: 'LISTING' },
    samples: { visible: [{ owner_agency_id: SAMPLE_READER }], hidden: [{}] },
  },
  // The agency's lead assignment rule (S10-02): one row per agency, admins write it.
  lead_routing_settings: { kind: 'STRICT', singleRow: true, base: { mode: 'UNASSIGNED', agent_user_ids: '{}' } },
  // S10-04: the activity timeline (calls, notes, lead and listing changes about the agency's clients) — own agency only;
  // monthly partitions (pg_partman, reached only through the parent). Not immutable: a contact merge re-points rows.
  activities: {
    kind: 'STRICT',
    partitioned: true,
    base: { type: 'OTHER', listing_id: '01900000-0000-7000-8000-00000000a001' },
  },
  // S10-05: the agency's tasks and reminders — own agency only. A merge re-points `contact_id`; the reminder sweep and
  // send job (app_system) write `reminded_at` / `reminder_sent_for`. app_user cannot update the send marker nor the
  // idempotency hashes; it does update `reminded_at` (re-arming on a new due date, reopen or remind on).
  tasks: {
    kind: 'STRICT',
    userNoUpdateColumns: ['reminder_sent_for', 'idempotency_hash', 'request_hash'],
    base: { title: 'isolation', status: 'OPEN', assigned_user_id: '01900000-0000-7000-8000-00000000a002' },
  },
  // S10-06: the agency's calendar (viewings, meetings, calls) and who attends — own agency only. A merge re-points an
  // attendee's `contact_id`; the reminder sweep / send job (app_system) write `reminded_at` / `reminder_sent_for`.
  // feed-api (app_public) reads none of it itself: the SECURITY DEFINER `calendar_feed_by_token(hash, …)` (owner
  // app_owner, `definerRead`) answers one live feed token's events — the member's own — with the attendees' names only.
  calendar_events: {
    kind: 'STRICT',
    definerRead: true,
    userNoUpdateColumns: ['idempotency_hash', 'request_hash'],
    base: {
      type: 'MEETING',
      title: 'isolation',
      starts_at: '2026-01-01T10:00:00Z',
      ends_at: '2026-01-01T11:00:00Z',
      organizer_user_id: '01900000-0000-7000-8000-00000000a002',
    },
  },
  calendar_event_attendees: {
    kind: 'STRICT',
    definerRead: true,
    userNoUpdateColumns: ['reminder_sent_for'],
    base: {
      event_id: '01900000-0000-7000-8000-00000000a004',
      user_id: '01900000-0000-7000-8000-00000000a002',
      starts_at: '2026-01-01T10:00:00Z',
    },
  },
  // S10-07: seller prospects (the acquisition board: owners the agency is trying to win, confidential notes) — own
  // agency only, never shared with the network nor read by a public path. A merge re-points `contact_id`; the
  // idempotency hashes are written once, on insert.
  seller_prospects: {
    kind: 'STRICT',
    userNoUpdateColumns: ['idempotency_hash', 'request_hash', 'created_by'],
    base: { title: 'isolation', stage: 'NEW', stage_rank: 'i' },
  },
  // S10-06: members' ICS feed tokens — the keyed hash only, never readable by app_user; looked up by the definer
  // function above (definerRead).
  calendar_feeds: {
    kind: 'STRICT',
    definerRead: true,
    hiddenColumns: ['token_hash'],
    userNoUpdateColumns: ['token_hash', 'token_hint', 'user_id', 'created_at'],
    // token_hash and user_id are invented per row (unique token; one live feed per member)
    base: { token_hint: 'abcd' },
  },
  // S11-04: members' notifications — read, marked and deleted by their recipient only (`userSelect`, `write`), never by
  // colleagues; any member's request may raise one for a colleague (insert). Members change `read_at` only; the digest
  // job (app_system) writes `email_pending` / `digested_at`. Monthly partitions (pg_partman, reached only through the
  // parent), 12 months kept.
  notifications: {
    kind: 'STRICT',
    partitioned: true,
    base: { type: 'ISOLATION' },
    userNoUpdateColumns: [
      'id',
      'created_at',
      'user_id',
      'type',
      'actor_user_id',
      'params',
      'link',
      'source_key',
      'in_app',
      'email_pending',
      'digested_at',
    ],
    userSelect: {
      sql: 'user_id = app_user_id()',
      write: { update: 'user_id = app_user_id()', delete: 'user_id = app_user_id()' },
      samples: { visible: [{ user_id: SAMPLE_USER }], hidden: [{}] },
    },
  },
  // S11-04: members' choices per notification type and channel — own agency only. Readable by colleagues' requests on
  // purpose (raising a notification for a colleague reads their choice in the same transaction). The service writes
  // only the caller's own rows; RLS does not narrow writes to the member: the registry has no "agency reads, member
  // writes" shape the isolation suite can check (`userSelect` must hide rows from other members) — follow-up.
  notification_preferences: { kind: 'STRICT', base: { type: 'ISOLATION' } },
  // S11-01: client registrations (PLAN §3 #8) — one table per reader, each under one policy (perf review: two ORed
  // policies left no list index-ordered). The introducer's registration (the client's details encrypted, its contact,
  // target, validity): app_user changes only `contact_id` (a merge re-points it) and never deletes one
  // (`client_registrations_guard`: evidence for both sides); `client_registrations_receipt` (definer) caps the validity
  // at the owner's setting and appends the owner's receipt.
  client_registrations: {
    kind: 'STRICT',
    userNoUpdateColumns: [
      'target_agency_id',
      'target_kind',
      'target_id',
      'registered_by_user_id',
      'details_enc',
      'registered_at',
      'expires_at',
    ],
    triggers: ['client_registrations_receipt', 'client_registrations_guard'],
    base: { target_kind: 'LISTING', registered_at: '2026-01-01T00:00:00Z', expires_at: '2026-07-01T00:00:00Z' },
  },
  // The target owner's receipt: who registered a client for which target and until when — nothing of the client. Read
  // by the owner only; appended only by the registration's trigger.
  client_registration_receipts: {
    kind: 'STRICT',
    userReadOnly: true,
    definerAppend: { functions: ['client_registrations_receipt'] },
    base: { target_kind: 'LISTING' },
  },
  // The introducer's keyed fingerprints (the cross-agency exclusion constraint compares them). Written once per
  // registration (and by the rehash job during an HMAC rotation, app_system); app_user never changes one.
  client_registration_fingerprints: {
    kind: 'STRICT',
    userNoUpdateColumns: ['target_id', 'fingerprint', 'registered_at', 'expires_at'],
    // app_user never deletes one (only the retention sweep, app_system); the FK ties it to its registration's target and
    // capped validity (ON UPDATE CASCADE)
    triggers: ['client_registration_fingerprints_guard'],
    base: { registered_at: '2026-01-01T00:00:00Z', expires_at: '2026-07-01T00:00:00Z' },
  },
  // S11-02, viewing requests (PLAN §3 #9). The introducer's request: its registration and contact, the state and the
  // terms snapshot. app_user never changes the terms, the target, the parties or the owner's acceptance (only the
  // owner's row sets it) and never deletes one (`viewing_requests_guard`). `viewing_requests_receipt` (definer) appends
  // the owner's copy; `viewing_requests_sync` (definer) copies the shared state to it; `viewing_terms_guard` refuses a
  // change of the terms, parties or target (every role but app_owner) and of the owner's acceptance once given (every
  // role); `viewing_requests_insert_guard` lets app_user insert only a proposal awaiting the owner.
  viewing_requests: {
    kind: 'STRICT',
    definerSync: { functions: ['viewing_request_receipts_sync'] },
    userNoUpdateColumns: [
      'id',
      'owner_agency_id',
      'registration_id',
      'requested_by_user_id',
      'target_kind',
      'target_id',
      'commission_bp',
      'commission_fixed_cents',
      'commission_currency',
      'split_bp',
      'commission_includes_vat',
      'terms_valid_until',
      'terms_at',
      'introducer_accepted_at',
      'introducer_accepted_by',
      'owner_accepted_at',
      'owner_accepted_by',
      'created_at',
      'created_ms',
      'idempotency_hash',
      'request_hash',
    ],
    triggers: [
      'viewing_requests_insert_guard',
      'viewing_requests_receipt',
      'viewing_requests_sync',
      'viewing_terms_guard',
      'viewing_requests_guard',
    ],
    base: {
      target_kind: 'LISTING',
      // a proposal awaiting the owner: the only row app_user may insert (`viewing_requests_insert_guard`)
      status: 'REQUESTED',
      awaiting: 'OWNER',
      proposed_start_at: '2026-02-01T10:00:00Z',
      expires_at: '2026-01-20T00:00:00Z',
      commission_bp: 500,
      split_bp: 5000,
      commission_includes_vat: false,
      terms_valid_until: '2026-07-01T00:00:00Z',
    },
  },
  // The owner's copy: who requested a viewing of which target, when, on which terms — nothing of the client. Appended
  // only by the request's trigger (`guardedInsert`: app_user inserts are refused); the owner answers on it (status,
  // times, its acceptance) and `viewing_request_receipts_sync` (definer) copies that to the introducer's row.
  viewing_request_receipts: {
    kind: 'STRICT',
    guardedInsert: true,
    definerSync: { functions: ['viewing_requests_receipt', 'viewing_requests_sync'] },
    userNoUpdateColumns: [
      'request_id',
      'introducer_agency_id',
      'target_kind',
      'target_id',
      'commission_bp',
      'commission_fixed_cents',
      'commission_currency',
      'split_bp',
      'commission_includes_vat',
      'terms_valid_until',
      'terms_at',
      'introducer_accepted_at',
      'introducer_accepted_by',
      'created_at',
      'created_ms',
    ],
    triggers: ['viewing_request_receipts_sync', 'viewing_terms_guard', 'viewing_request_receipts_guard'],
    base: {
      target_kind: 'LISTING',
      // a proposal awaiting the owner: the only row app_user may insert (`viewing_requests_insert_guard`)
      status: 'REQUESTED',
      awaiting: 'OWNER',
      proposed_start_at: '2026-02-01T10:00:00Z',
      expires_at: '2026-01-20T00:00:00Z',
      commission_bp: 500,
      split_bp: 5000,
      commission_includes_vat: false,
      terms_valid_until: '2026-07-01T00:00:00Z',
    },
  },
  // S11-03, chat (PLAN §7 M12). Each agency reads its own copy of a thread (one policy per table). The thread row
  // (kind, the other agency, title, subject, last activity — no content) is agency-visible; app_user inserts its own
  // (`chat_threads_insert_guard` stamps the starter and times); only a DIRECT thread's starter renames it and nobody
  // deletes one (`chat_threads_guard`). `chat_threads_mirror`
  // (definer) appends the other agency's copy of a VIEWING thread, only for a viewing request between exactly those two
  // agencies; `chat_messages_fanout` (definer) moves both copies' `last_message_at`.
  chat_threads: {
    kind: 'STRICT',
    definerSync: { functions: ['chat_threads_mirror', 'chat_messages_fanout'] },
    userNoUpdateColumns: [
      'id',
      'kind',
      'peer_agency_id',
      'network_post_id',
      'subject',
      'created_by_user_id',
      'created_at',
      'last_message_at',
      'closed_at',
    ],
    triggers: ['chat_threads_insert_guard', 'chat_threads_mirror', 'chat_threads_guard'],
    base: { kind: 'DIRECT' },
  },
  // The agency's members in a thread and their read state. A member joins a VIEWING thread themselves, or is added by
  // the starter of a DIRECT thread in the transaction that started it (`chat_participants_guard`); workers seat a viewing
  // thread's default members. Members change only their own `last_read_at` and remove nobody
  // (`chat_participants_change_guard`); `chat_messages_fanout` (definer) keeps
  // `last_message_at` (and the sender's read state) and the notify job (app_system) `notified_at`.
  chat_participants: {
    kind: 'STRICT',
    // S11-05: `chat_threads_mirror` (definer) seats a network post's author on a reply thread's copy
    definerSync: { functions: ['chat_messages_fanout', 'chat_threads_mirror'] },
    userNoUpdateColumns: ['thread_id', 'user_id', 'joined_at', 'last_message_at', 'notified_at'],
    triggers: ['chat_participants_guard', 'chat_participants_change_guard'],
  },
  // The agency's copy of each message: read by the thread's participants only (and its sender), appended by a
  // participant as themselves (`chat_messages_fanout` refuses anyone else and appends the other agency's copy). Never
  // changed (no updatable column) nor deleted by a request (`chat_messages_guard`).
  chat_messages: {
    kind: 'STRICT',
    definerSync: { functions: ['chat_messages_fanout'] },
    userNoUpdateColumns: [
      'id',
      'thread_id',
      'sender_agency_id',
      'sender_user_id',
      'sender_name',
      'body',
      'client_key',
      'created_at',
    ],
    triggers: ['chat_messages_guard', 'chat_messages_fanout'],
    userSelect: {
      sql: 'sender_user_id = app_user_id() or exists (select 1 from public.chat_participants p where p.agency_id = chat_messages.agency_id and p.thread_id = chat_messages.thread_id and p.user_id = app_user_id())',
      write: { insert: 'sender_user_id = app_user_id()' },
      samples: { visible: [{ sender_user_id: SAMPLE_USER }], hidden: [{}] },
    },
  },
  // S11-05, network board (PLAN §7 M11). A post is what its agency chose to publish to the network (kind, title, text,
  // criteria, expiry — no author, client or commission): verified agencies read the OPEN, unexpired posts of listed
  // agencies; only its agency writes it. `definerRead`: `chat_threads_mirror` checks a NETWORK thread replies to an
  // open post of the other agency and copies its title.
  network_posts: {
    kind: 'NETWORK_READ',
    definerRead: true,
    // what was published never changes; a request only closes the post (`network_posts_guard`: OPEN -> CLOSED)
    userNoUpdateColumns: [
      'id',
      'kind',
      'title',
      'body',
      'transaction_type',
      'property_type_ids',
      'location_ids',
      'location_scope_ids',
      'feature_ids',
      'price_min_cents',
      'price_max_cents',
      'currency',
      'beds_min',
      'baths_min',
      'area_min_m2',
      'area_max_m2',
      'expires_at',
      'created_at',
    ],
    triggers: ['network_posts_guard'],
    networkReadSql: `status = 'OPEN' and expires_at > now()
      and exists (select 1 from public.agency_directory d where d.agency_id = network_posts.agency_id and d.listed)`,
    base: { kind: 'BUYER_REQUEST', title: 'Villa wanted', body: 'Sea views', expires_at: '2099-01-01T00:00:00Z' },
    samples: {
      visible: [{ status: 'OPEN' }],
      hidden: [
        { status: 'CLOSED', closed_at: '2026-01-02T00:00:00Z' },
        { status: 'OPEN', created_at: '2020-01-01T00:00:00Z', expires_at: '2020-02-01T00:00:00Z' },
      ],
    },
  },
  // A post's private side: who posted it and its Idempotency-Key — its agency only, written once with the post and never
  // changed nor removed by a request (`userAppendRead`). `definerRead`: `chat_threads_mirror` seats the author on the
  // post's agency's copy of a reply thread.
  network_post_authors: { kind: 'STRICT', userAppendRead: true, definerRead: true },
  // A member's board subscriptions (filters): the member's own only — colleagues neither read nor change them.
  network_subscriptions: {
    kind: 'STRICT',
    userSelect: {
      sql: 'user_id = app_user_id()',
      write: {
        insert: 'user_id = app_user_id()',
        update: 'user_id = app_user_id()',
        delete: 'user_id = app_user_id()',
      },
      samples: { visible: [{ user_id: SAMPLE_USER }], hidden: [{}] },
    },
    base: { name: 'Marbella villas' },
  },
};

/**
 * Tables without `agency_id`. Readable by `app_user` (unless `noUserRead`), written only by `withSystem()` (app_system) —
 * except `access: 'auth'` tables, which only `app_auth` and `app_system` reach.
 */
export const globalTables: Record<string, GlobalTable> = {
  // Portal catalog (S9-01): Kyero, thinkSPAIN, A Place in the Sun, generic XML (idealista and Fotocasa planned).
  portal_channels: {
    reason: 'catalog of portals an agency can feed, written by staff / sync via withSystem()',
    staffWrite: true,
  },
  // S12-01: the prompt registry — every shipped prompt file version and its hash; the same for every agency.
  prompt_versions: {
    reason: 'AI prompt registry (platform data), written by the gateway sync via withSystem()',
    base: { tier: 'FAST', content_hash: '0'.repeat(64) },
  },
  // Staff-managed flags; per-agency overrides are ID lists, so agencies cannot enable their own (S0-07).
  feature_flags: { reason: 'platform feature flags, written by staff via withSystem()' },
  // Login identity: looked up by email before any tenant is known; staff users have no agency (S0-09).
  // S10-06: `definerRead` — the calendar feed's definer lookup checks the feed member's login is ACTIVE (its status
  // only). Like every definer read, the function names the row it needs (here the feed's user id), never a scan.
  users: { reason: 'login identity, resolved before a tenant is known', access: 'auth', definerRead: true },
  auth_tokens: { reason: 'email verification and password reset tokens (hashed)', access: 'auth' },
  // Second factor (S1-04): checked at login and on every access-token mint, before a tenant is known.
  user_mfa: { reason: 'TOTP second factor of a login identity (secret encrypted)', access: 'auth', userScoped: true },
  user_recovery_codes: { reason: '2FA recovery codes of a login identity (hashed)', access: 'auth', userScoped: true },
  // Staff have no agency (S1-03, ADR 0015). Granted by `pnpm staff:grant`; app_staff reads its own row.
  staff_users: { reason: 'Inmolink staff, who have no agency', access: 'staff' },
  // Location tree and groups (S2-01): shared reference data; staff and import scripts write via withSystem().
  locations: {
    reason: 'platform location tree shared by every agency',
    publicRead: true,
    staffWrite: true,
    base: { level: 'COUNTRY', depth: 1 },
  },
  location_translations: { reason: 'names and slugs of locations', publicRead: true, staffWrite: true },
  location_aliases: { reason: 'feed spellings mapped to canonical locations', publicRead: true, staffWrite: true },
  location_groups: { reason: 'curated location groups such as Costa del Sol', publicRead: true, staffWrite: true },
  location_group_translations: { reason: 'names and slugs of location groups', publicRead: true, staffWrite: true },
  location_group_members: { reason: 'members of location groups', publicRead: true, staffWrite: true },
  // Property types and features (S2-02): shared reference data, written via withSystem().
  property_type_groups: { reason: 'property type groups (Apartment, House, …)', publicRead: true, staffWrite: true },
  property_type_group_translations: {
    reason: 'names and slugs of property type groups',
    publicRead: true,
    staffWrite: true,
  },
  property_types: { reason: 'platform property types', publicRead: true, staffWrite: true },
  property_type_translations: { reason: 'names and slugs of property types', publicRead: true, staffWrite: true },
  property_type_aliases: { reason: 'feed spellings mapped to property types', publicRead: true, staffWrite: true },
  feature_groups: { reason: 'feature groups (Pool, Security, …)', publicRead: true, staffWrite: true },
  feature_group_translations: { reason: 'names and slugs of feature groups', publicRead: true, staffWrite: true },
  features: {
    reason: 'platform features with Lucide icon names',
    publicRead: true,
    staffWrite: true,
    base: { icon: 'waves' },
  },
  feature_translations: { reason: 'names and slugs of features', publicRead: true, staffWrite: true },
  feature_aliases: { reason: 'feed spellings mapped to features', publicRead: true, staffWrite: true },
  // Unmatched feed values (S2-05): staff queue, written by import workers via withSystem().
  taxonomy_unmatched: {
    reason: 'feed values with no confident taxonomy match, awaiting staff mapping',
    staffWrite: true,
    // examples name agencies' listing refs and feed names (S3-F1)
    noUserRead: true,
    base: { kind: 'location' },
  },
  // Content-addressed media (S3-03): one original per SHA-256 for every agency. Tenants read it (the upload
  // check: is this hash stored already?); only the media worker writes it, recounting references via withSystem().
  media_objects: {
    reason: 'content-addressed media originals shared by every agency (deduplicated by SHA-256)',
    // the media worker's own table (S3-F4)
    mediaWrite: true,
    base: { sha256: ISOLATION_SHA256, content_type: 'image/jpeg' },
  },
  // Postgres fallback search (S5-04): PUBLIC index documents only, written with read models via withSystem().
  // Not under RLS: array and numeric comparisons are not leakproof, so a policy would keep them out of index scans.
  // S6-F1: public paths only — a member session would map every PUBLIC listing to its owner without the verified gate.
  listing_search_docs: {
    reason: 'search filter fields of PUBLIC listings and units of every agency (website search fallback)',
    publicRead: true,
    noUserRead: true,
  },
  // Public codes (S7-02): an opaque code per listing or unit once public, shown and matched by websites as
  // `<prefix>-<code>` for other agencies' listings. Written by the search worker (withSystem); public paths read them.
  listing_public_codes: {
    reason: 'opaque public codes of PUBLIC listings and units of every agency (white-labelled website references)',
    publicRead: true,
    noUserRead: true,
    base: { code: 'AB12CD34' },
  },
  // Commission of PUBLIC targets (S7-F4): worker-written; no role reads it (the website fallback probes the generated
  // view `search_commission_floor` — ids paying at least the transaction's minimum, run as its owner, S7-F10), so no
  // public path can select a commission.
  // Public change log (S7-03): written with read models by the search worker (withSystem); `/v2/changes` reads it.
  listing_public_changes: {
    reason: 'changes of PUBLIC listings and units of every agency (website API delta feed, `/v2/changes`)',
    publicRead: true,
    noUserRead: true,
    base: { kind: 'LISTING', ref: 'INL-TEST' },
  },
  // Website developments (S7-F6): one aggregate row per development with public units, written with the units'
  // fallback rows by the search worker (withSystem); `/v2/developments` reads it. Public paths only, like the fallback.
  listing_search_developments: {
    reason: 'unit aggregates of developments with PUBLIC units of every agency (website API `/v2/developments`)',
    publicRead: true,
    noUserRead: true,
  },
  listing_search_commissions: {
    reason:
      'total commission of PUBLIC listings and units of every agency (website minimum-commission filter): written by the search worker; read by app_public only through the owner-run view search_commission_floor, which answers target ids, never the value (S7-F10)',
    noUserRead: true,
    definerRead: true,
    base: { commission_bp: 300 },
  },
  // Search index sync queue (S5-03): written with read models by the search worker via withSystem().
  search_index_queue: {
    reason: 'targets of every agency whose search index document must be pushed again (worker-only work queue)',
    noUserRead: true,
  },
  // Read-model rebuild queue (S5-F4): written by the search subscriptions and drained by the search worker via withSystem().
  read_model_queue: {
    reason: 'listings and units of every agency whose read models must be rebuilt (worker-only work queue)',
    noUserRead: true,
  },
  // Quality recompute queue (S6-F3): written by the quality subscriptions and drained by the quality worker via withSystem().
  quality_queue: {
    reason: 'listings of every agency whose quality score must be computed again (worker-only work queue)',
    noUserRead: true,
  },
  // Recurring jobs' resume points (S5-F2): the orphan sweeps' last keys, written by workers via withSystem().
  job_checkpoints: {
    reason: 'where a bounded recurring job (an orphan sweep over every agency) stopped, so the next run resumes',
    noUserRead: true,
  },
  // Legacy migration (S2-06): old ID → new ID, written by import scripts via withSystem().
  legacy_id_maps: {
    reason: 'every legacy ID and the v2 ID it became (ADR 0006), permanent',
    // Written by import scripts only; tenant entity maps (S14) must not be readable across agencies (S3-F1), so no
    // `app_user` read. S8-02 (narrows S3-F1's "app_system only"): the v1 shim (feed-api, `app_public`) reads the
    // taxonomy maps (location, property type, feature: platform reference data) to resolve legacy filter ids. Listing
    // and unit maps stay unreadable by every app role: the shim reaches them only through the SECURITY DEFINER lookups
    // `legacy_target_ids` / `legacy_ids_of` (owner `app_owner`, `definerRead`), which answer ids for given ids only.
    noUserRead: true,
    publicRead: true,
    publicReadSql: `entity in ('location', 'propertyType', 'feature')`,
    publicSamples: {
      visible: [{ entity: 'location' }, { entity: 'propertyType' }, { entity: 'feature' }],
      hidden: [{ entity: 'listing' }, { entity: 'unit' }, { entity: 'contact' }],
    },
    definerRead: true,
    base: { entity: 'location', method: 'exact' },
  },
};

export const registry: TenantRegistry = { tenant: tenantTables, global: globalTables };

/** Merges registries (production + test fixtures). Duplicate table names are a programming error. */
export function mergeRegistries(...parts: TenantRegistry[]): TenantRegistry {
  const out: TenantRegistry = { tenant: {}, global: {} };
  for (const part of parts) {
    for (const [name, def] of Object.entries(part.tenant)) {
      if (Object.hasOwn(out.tenant, name) || Object.hasOwn(out.global, name)) {
        throw new Error(`table ${name} is registered twice`);
      }
      out.tenant[name] = def;
    }
    for (const [name, def] of Object.entries(part.global)) {
      if (Object.hasOwn(out.tenant, name) || Object.hasOwn(out.global, name)) {
        throw new Error(`table ${name} is registered twice`);
      }
      out.global[name] = def;
    }
  }
  return out;
}
