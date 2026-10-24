import {
  getPgClient,
  publicHiddenColumnsOf,
  SAMPLE_READER,
  SAMPLE_USER,
  setAuthScope,
  type TenantTable,
  type Tx,
  withAuth,
  withIntake,
  withMedia,
  withPublicRead,
  withStaff,
  withTenant,
} from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import { PLATFORM_AGENCY_ID } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolationRegistry, setupIsolation, teardownIsolation } from './fixtures';
import {
  buildRow,
  columnsOf,
  expectNoPublicWrites,
  expectSqlState,
  insertQuery,
  insertSql,
  type Row,
  seed,
  sqlState,
  withReplicaRole,
} from './rows';

/**
 * Cross-tenant suite generated from the tenant registry (PATTERNS §20): every registered table gets
 * the same cases, so a new table is covered as soon as it is registered. Do not hand-write exceptions.
 */

const DENIED = ['42501']; // insufficient_privilege: missing grant or RLS WITH CHECK violation
/** Raised only after RLS let the row through: FK triggers, and unique indexes (e.g. one open request per agency). */
const PASSED_RLS = ['23503', '23505'];

/** Runs `fn` as the tenant and rolls the transaction back (positive controls leave no rows). */
class Rollback extends Error {}
async function rolledBack(agencyId: string, fn: (tx: Tx) => Promise<void>, userId?: string): Promise<void> {
  await withTenant({ agencyId, userId }, async (tx) => {
    await fn(tx);
    throw new Rollback();
  }).catch((err) => {
    if (!(err instanceof Rollback)) throw err;
  });
}

async function rolledBackAuth(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await withAuth(async (tx) => {
    await fn(tx);
    throw new Rollback();
  }).catch((err) => {
    if (!(err instanceof Rollback)) throw err;
  });
}

async function asAppPublic(fn: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await getPgClient('app_public');
  try {
    await fn(client);
  } finally {
    client.release();
  }
}

let admin: pg.Client;
let ownerUrl = '';
let systemUrl = '';
/** An active staff member, and a user with no staff row (S1-03): app_staff acting for each. */
const staffUserId = newId();
const notStaffUserId = newId();
const asStaff = <T>(fn: (tx: Tx) => Promise<T>) => withStaff({ userId: staffUserId, reason: 'isolation' }, fn);
const asNotStaff = <T>(fn: (tx: Tx) => Promise<T>) => withStaff({ userId: notStaffUserId, reason: 'isolation' }, fn);
const asMedia = <T>(fn: (tx: Tx) => Promise<T>) => withMedia('isolation', fn);

beforeAll(async () => {
  const cfg = await setupIsolation();
  ownerUrl = cfg.DATABASE_URL_APP_OWNER;
  systemUrl = cfg.DATABASE_URL_APP_SYSTEM ?? '';
  admin = new pg.Client({ connectionString: cfg.DATABASE_URL_ADMIN });
  await admin.connect();
  for (const id of [staffUserId, notStaffUserId]) {
    await admin.query(`insert into users (id, email, password_hash, name, locale) values ($1, $2, 'x', 'Iso', 'en')`, [
      id,
      `iso-${id}@isolation.test`,
    ]);
  }
  await admin.query(`insert into staff_users (user_id, role) values ($1, 'SUPER_ADMIN')`, [staffUserId]);
});

afterAll(async () => {
  await admin?.query('delete from users where id = any($1)', [[staffUserId, notStaffUserId]]);
  await admin?.end();
  if (ownerUrl) await teardownIsolation(ownerUrl);
});

const count = async (tx: Tx, table: string, agencyId: string) =>
  Number(
    (await tx.execute(sql`select count(*) as n from ${sql.identifier(table)} where agency_id = ${agencyId}`)).rows[0]
      ?.n,
  );

/**
 * A member of the network (S1-07): a VERIFIED agency listed in the directory. Seeded inside
 * `withReplicaRole` (no triggers); an existing directory row (the directory's own samples) is kept.
 */
async function seedNetworkMember(agencyId: string): Promise<void> {
  const columns = await columnsOf(admin, 'agencies');
  await seed(admin, 'agencies', buildRow('agencies', columns, { agency_id: agencyId, status: 'VERIFIED' }));
  await admin.query(
    `insert into agency_directory (agency_id, name, kind, listed) values ($1, 'Iso', 'AGENCY', true)
     on conflict (agency_id) do nothing`,
    [agencyId],
  );
}

function samplesOf(def: TenantTable): { visible: Row[]; hidden: Row[] } {
  if (def.kind === 'STRICT') return def.userSelect ? def.userSelect.samples : { visible: [], hidden: [{}] };
  return def.samples;
}

const tenantNames = Object.keys(isolationRegistry.tenant).sort();
const globalNames = Object.keys(isolationRegistry.global).sort();

describe.each(tenantNames)('tenant table %s', (table) => {
  const def = isolationRegistry.tenant[table] as TenantTable;
  const { visible, hidden } = samplesOf(def);
  const a = newId();
  const b = newId();
  let build: (overrides: Row) => Row;

  /** `userSelect` tables (S1-F10): tenants read as a member, the user the samples name (`SAMPLE_USER`). */
  const reader = newId();
  const as = (agencyId: string) => ({ agencyId, userId: def.userSelect ? reader : undefined });
  const rb = (agencyId: string, fn: (tx: Tx) => Promise<void>) =>
    rolledBack(agencyId, fn, def.userSelect ? reader : undefined);

  /** Sample values naming the reader (`SAMPLE_READER`) become tenant B, which reads the network below. */
  const forReader = (sample: Row): Row =>
    Object.fromEntries(
      Object.entries(sample).map(([k, v]) => [k, v === SAMPLE_READER ? b : v === SAMPLE_USER ? reader : v]),
    );

  beforeAll(async () => {
    const columns = await columnsOf(admin, table);
    build = (overrides) => buildRow(table, columns, { ...def.base, ...overrides });
    await withReplicaRole(admin, async () => {
      for (const sample of [...visible, ...hidden]) {
        await seed(admin, table, build({ ...forReader(sample), agency_id: a }));
      }
      // A `userSelect` table's own row is one its reader may read, so the positive controls can update it.
      await seed(admin, table, build({ ...forReader(def.userSelect ? (visible[0] ?? {}) : {}), agency_id: b }));
      // Only verified agencies read the network (the generator's `app_agency_verified()`, S1-07), and
      // rows of an owner that left the directory may be hidden: both tenants are network members.
      if (def.kind === 'NETWORK_READ') for (const id of [a, b]) await seedNetworkMember(id);
    });
  });

  afterAll(async () => {
    const cleanUp = () => admin.query(`delete from "${table}" where agency_id = any($1)`, [[a, b]]);
    // Immutable tables refuse DELETE even for the superuser (S1-08 triggers); the suite's own rows go with
    // triggers off (replica role).
    if (def.immutable) await withReplicaRole(admin, cleanUp);
    else await cleanUp();
    if (def.kind === 'NETWORK_READ') await admin.query('delete from agencies where agency_id = any($1)', [[a, b]]);
  });

  const adminCount = async (agencyId: string) =>
    Number((await admin.query(`select count(*) as n from "${table}" where agency_id = $1`, [agencyId])).rows[0].n);

  if (def.appendOnly) {
    // Write-only for tenants (e.g. the outbox): every read, update and delete is denied, even on own rows.
    it(`[S0-06] ${table}: append-only — tenants cannot select, update or delete any rows, even their own`, async () => {
      for (const agencyId of [a, b]) {
        await expectSqlState(() => withTenant(as(b), (tx) => count(tx, table, agencyId)), DENIED);
        await expectSqlState(
          () =>
            withTenant(as(b), (tx) =>
              tx.execute(sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${agencyId}`),
            ),
          DENIED,
        );
        await expectSqlState(
          () =>
            withTenant(as(b), (tx) =>
              tx.execute(sql`delete from ${sql.identifier(table)} where agency_id = ${agencyId}`),
            ),
          DENIED,
        );
      }
      expect(await adminCount(a)).toBe(visible.length + hidden.length);
      expect(await adminCount(b)).toBe(1);
    });

    it(`[S0-06] ${table}: append-only — tenant B cannot insert a row for tenant A`, async () => {
      await expectSqlState(
        () => withTenant(as(b), (tx) => tx.execute(insertSql(table, build({ agency_id: a })))),
        DENIED,
      );
    });

    it(`[S0-06] ${table}: append-only — app_user without a tenant cannot read or insert`, async () => {
      const client = await getPgClient('app_user');
      try {
        await expectSqlState(() => client.query(`select count(*) from "${table}"`), DENIED);
        const q = insertQuery(table, build({ agency_id: a }));
        await expectSqlState(() => client.query(q.text, q.values), DENIED);
      } finally {
        client.release();
      }
    });

    it(`[S0-06] ${table}: positive control — tenant B can insert its own rows`, async () => {
      await rb(b, async (tx) => {
        expect((await tx.execute(insertSql(table, build({ agency_id: b })))).rowCount).toBe(1);
      });
      expect(await adminCount(b)).toBe(1);
    });
  } else {
    it(`[S0-05] ${table}: tenant A reads all of its own rows`, async () => {
      const readable = def.userSelect ? visible.length : visible.length + hidden.length;
      expect(await withTenant(as(a), (tx) => count(tx, table, a))).toBe(readable);
    });

    if (def.userSelect) {
      const { hiddenColumns = [] } = def.userSelect;
      it(`[S1-F10] ${table}: userSelect — a member reads only the rows the predicate shows them, never another member's`, async () => {
        expect(await withTenant({ agencyId: a }, (tx) => count(tx, table, a))).toBe(0);
        expect(await withTenant({ agencyId: a, userId: newId() }, (tx) => count(tx, table, a))).toBe(0);
        expect(await withTenant({ agencyId: b, userId: reader }, (tx) => count(tx, table, a))).toBe(0);
        expect(await adminCount(a)).toBe(visible.length + hidden.length);
      });

      it(`[S1-F10] ${table}: userSelect — the hidden columns (${hiddenColumns.join(', ')}) cannot be read, selected, filtered or returned`, async () => {
        for (const column of hiddenColumns) {
          const id = sql.identifier(column);
          const t = sql.identifier(table);
          for (const read of [
            sql`select ${id} from ${t} where agency_id = ${a}`,
            sql`select * from ${t} where agency_id = ${a}`,
            sql`select count(*) from ${t} where agency_id = ${a} and ${id} is not null`,
            sql`select agency_id from ${t} where agency_id = ${a} order by ${id}`,
          ]) {
            await expectSqlState(() => withTenant(as(a), (tx) => tx.execute(read)), DENIED);
          }
        }
      });
    }

    if (def.hiddenColumns?.length) {
      it(`[S5-05] ${table}: hidden columns (${def.hiddenColumns.join(', ')}) cannot be read by app_user, even on its own rows`, async () => {
        for (const column of def.hiddenColumns ?? []) {
          const id = sql.identifier(column);
          const t = sql.identifier(table);
          for (const read of [
            sql`select ${id} from ${t} where agency_id = ${a}`,
            sql`select * from ${t} where agency_id = ${a}`,
            sql`select count(*) from ${t} where agency_id = ${a} and ${id} is not null`,
          ]) {
            await expectSqlState(() => withTenant(as(a), (tx) => tx.execute(read)), DENIED);
          }
        }
      });
    }

    if (def.kind === 'NETWORK_READ') {
      it(`[S0-05] ${table}: tenant B reads tenant A's rows only where the network predicate holds`, async () => {
        expect(await withTenant(as(b), (tx) => count(tx, table, a))).toBe(visible.length);
      });

      it(`[S1-07] ${table}: an agency that is not verified reads none of tenant A's rows`, async () => {
        const setStatus = (status: string) =>
          withReplicaRole(admin, () =>
            admin.query('update agencies set status = $2 where agency_id = $1', [b, status]),
          );
        await setStatus('SUSPENDED');
        try {
          expect(await withTenant(as(b), (tx) => count(tx, table, a))).toBe(0);
        } finally {
          await setStatus('VERIFIED');
        }
        // An agency id with no agency at all, too.
        expect(await withTenant({ agencyId: newId() }, (tx) => count(tx, table, a))).toBe(0);
      });
    } else {
      it(`[S0-05] ${table}: tenant B cannot select tenant A's rows`, async () => {
        expect(await withTenant(as(b), (tx) => count(tx, table, a))).toBe(0);
      });
    }

    if (def.immutable) {
      // Append-only history (S1-08): no UPDATE or DELETE grant at all, so every attempt is refused.
      it(`[S1-08] ${table}: immutable — tenants cannot update or delete any rows, even their own`, async () => {
        for (const agencyId of [a, b]) {
          await expectSqlState(
            () =>
              withTenant(as(b), (tx) =>
                tx.execute(
                  sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${agencyId}`,
                ),
              ),
            DENIED,
          );
          await expectSqlState(
            () =>
              withTenant(as(b), (tx) =>
                tx.execute(sql`delete from ${sql.identifier(table)} where agency_id = ${agencyId}`),
              ),
            DENIED,
          );
        }
        expect(await adminCount(a)).toBe(visible.length + hidden.length);
        expect(await adminCount(b)).toBe(1);
      });

      it(`[S1-08] ${table}: immutable — app_system (workers) cannot update, delete or truncate it either`, async () => {
        const system = new pg.Client({ connectionString: systemUrl });
        await system.connect();
        try {
          for (const q of [
            `update "${table}" set agency_id = agency_id where agency_id = '${a}'`,
            `delete from "${table}" where agency_id = '${a}'`,
            `truncate "${table}"`,
          ]) {
            await expectSqlState(() => system.query(q), DENIED);
          }
        } finally {
          await system.end();
        }
        expect(await adminCount(a)).toBe(visible.length + hidden.length);
      });
    } else {
      // A userReadOnly (S6-F1) or userAppendRead (S11-F3) table refuses the statement outright (no grant): stronger
      // than matching no row.
      const changes = async (run: () => Promise<{ rowCount: number | null }>) => {
        if (def.userReadOnly || def.userAppendRead) await expectSqlState(run, DENIED);
        else expect((await run()).rowCount).toBe(0);
      };

      it(`[S0-05] ${table}: tenant B cannot update tenant A's rows`, async () => {
        await changes(() =>
          withTenant(as(b), (tx) =>
            tx.execute(sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${a}`),
          ),
        );
      });

      it(`[S0-05] ${table}: tenant B cannot delete tenant A's rows`, async () => {
        await changes(() =>
          withTenant(as(b), (tx) => tx.execute(sql`delete from ${sql.identifier(table)} where agency_id = ${a}`)),
        );
        expect(await adminCount(a)).toBe(visible.length + hidden.length);
      });
    }

    it(`[S0-05] ${table}: tenant B cannot insert a row for tenant A`, async () => {
      await expectSqlState(
        () => withTenant(as(b), (tx) => tx.execute(insertSql(table, build({ agency_id: a })))),
        DENIED,
      );
    });

    it(`[S0-05] ${table}: tenant B cannot move its own row to tenant A`, async () => {
      await expectSqlState(
        () =>
          withTenant(as(b), (tx) =>
            tx.execute(sql`update ${sql.identifier(table)} set agency_id = ${a} where agency_id = ${b}`),
          ),
        DENIED,
      );
      expect(await adminCount(b)).toBe(1);
    });

    it(`[S0-05] ${table}: app_user without a tenant sees no rows`, async () => {
      const client = await getPgClient('app_user');
      try {
        await client.query('begin');
        const { rows } = await client.query(`select count(*) as n from "${table}" where agency_id = any($1)`, [[a, b]]);
        await client.query('commit');
        expect(Number(rows[0].n)).toBe(0);
      } finally {
        client.release();
      }
    });
  }

  if (def.kind === 'PUBLIC_READ') {
    it(`[S0-05] ${table}: app_public reads only rows matching the public predicate`, async () => {
      expect(await withPublicRead((tx) => count(tx, table, a))).toBe(visible.length);
    });

    const publicHidden = publicHiddenColumnsOf(def);
    if (publicHidden.length > 0) {
      it(`[S6-F1] ${table}: app_public cannot read the hidden columns (${publicHidden.join(', ')}), even on public rows`, async () => {
        for (const column of publicHidden) {
          const id = sql.identifier(column);
          const t = sql.identifier(table);
          for (const read of [
            sql`select ${id} from ${t} where agency_id = ${a}`,
            sql`select * from ${t} where agency_id = ${a}`,
            sql`select count(*) from ${t} where agency_id = ${a} and ${id} is not null`,
            sql`select agency_id from ${t} where agency_id = ${a} order by ${id}`,
          ]) {
            await expectSqlState(() => withPublicRead((tx) => tx.execute(read)), DENIED);
          }
        }
      });
    }
  } else {
    it(`[S0-05] ${table}: app_public cannot read it`, async () => {
      await expectSqlState(() => withPublicRead((tx) => count(tx, table, a)), DENIED);
    });
  }

  it(`[S0-05] ${table}: app_public cannot insert, update, delete or truncate it, even in a read-write transaction`, async () => {
    await asAppPublic((client) => expectNoPublicWrites(client, table, build({ agency_id: a }), 'agency_id'));
  });

  if (!def.appendOnly && def.singleRow) {
    it(`[S1-01] ${table}: positive control — tenant B can update its own (single) row`, async () => {
      // One row per agency: inserting a second one would hit the key, so prove the grant by updating.
      await rb(b, async (tx) => {
        const res = await tx.execute(
          sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${b}`,
        );
        expect(res.rowCount).toBe(1);
      });
    });
  } else if (!def.appendOnly && def.guardedInsert) {
    it(`[S1-02] ${table}: positive control — tenant B can update its own rows; its guard trigger refuses tenant inserts`, async () => {
      // Rows arrive through another role (sign-up, invite accept) or need an admin the suite does not
      // create, so the grant is proven by updating the seeded row.
      await rb(b, async (tx) => {
        const res = await tx.execute(
          sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${b}`,
        );
        expect(res.rowCount).toBe(1);
      });
      await expectSqlState(
        () => rb(b, (tx) => tx.execute(insertSql(table, build({ agency_id: b }))).then(() => undefined)),
        DENIED,
      );
      expect(await adminCount(b)).toBe(1);
    });
  } else if (!def.appendOnly && (def.immutable || def.userAppendRead)) {
    it(`[S1-08] ${table}: positive control — tenant B can insert and read its own rows`, async () => {
      await rb(b, async (tx) => {
        // In a savepoint, like the positive control below: a history row whose parent the suite does not
        // create (S3-01: listing history → properties) fails with 23503 only after RLS let it through.
        const inserted = await tx
          .transaction(async (sp) => (await sp.execute(insertSql(table, build({ agency_id: b })))).rowCount)
          .catch((err: unknown) => {
            if (PASSED_RLS.includes(sqlState(err) ?? '')) return 0;
            throw err;
          });
        expect(await count(tx, table, b)).toBe(1 + (inserted ?? 0));
      });
      expect(await adminCount(b)).toBe(1);
    });
  } else if (!def.appendOnly && def.userReadOnly) {
    // A read model only workers write (S6-F1): tenants read their own rows (the positive control) and change none.
    it(`[S6-F1] ${table}: read-only for app_user — tenant B reads its own rows but cannot insert, update or delete any`, async () => {
      expect(await withTenant(as(b), (tx) => count(tx, table, b))).toBe(1);
      for (const agencyId of [a, b]) {
        await expectSqlState(
          () => rb(b, (tx) => tx.execute(insertSql(table, build({ agency_id: agencyId }))).then(() => undefined)),
          DENIED,
        );
        await expectSqlState(
          () =>
            rb(b, (tx) =>
              tx
                .execute(sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${agencyId}`)
                .then(() => undefined),
            ),
          DENIED,
        );
        await expectSqlState(
          () =>
            rb(b, (tx) =>
              tx.execute(sql`delete from ${sql.identifier(table)} where agency_id = ${agencyId}`).then(() => undefined),
            ),
          DENIED,
        );
      }
      expect(await adminCount(a)).toBe(visible.length + hidden.length);
      expect(await adminCount(b)).toBe(1);
    });
  } else if (!def.appendOnly) {
    it(`[S0-05] ${table}: positive control — tenant B can insert and update its own rows`, async () => {
      // Proves the cross-tenant denials above come from the policies, not from a missing grant.
      const ownReadable = build({ ...forReader(def.userSelect ? (visible[0] ?? {}) : {}), agency_id: b });
      await rb(b, async (tx) => {
        // In a savepoint: a table whose parents the suite does not create (FK to agencies, users)
        // fails the insert with 23503 — which the FK trigger raises only after RLS let the row through —
        // and a partial unique index the seeded row already fills fails with 23505, also after RLS.
        const inserted = await tx
          .transaction(async (sp) => (await sp.execute(insertSql(table, ownReadable))).rowCount)
          .catch((err: unknown) => {
            if (PASSED_RLS.includes(sqlState(err) ?? '')) return 0;
            throw err;
          });
        const res = await tx.execute(
          sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${b}`,
        );
        expect(res.rowCount).toBe(1 + (inserted ?? 0));
      });
      expect(await adminCount(b)).toBe(1);
    });
  }

  const auth = def.auth;
  if (auth) {
    // Sign-up / token flows (S1-01): app_auth reaches only rows pinned by `setAuthScope`. Unscoped it
    // sees and changes nothing; scoped to tenant B (and a stranger user) it cannot touch tenant A.
    const scopes = [{}, { agencyId: b, userId: newId() }];
    it(`[S1-01] ${table}: app_auth, unscoped or scoped to another tenant, cannot read, update or delete tenant A's rows`, async () => {
      for (const scope of scopes) {
        const inScope = <T>(fn: (tx: Tx) => Promise<T>) =>
          withAuth(async (tx) => {
            await setAuthScope(tx, scope);
            return fn(tx);
          });
        if (auth.select) expect(await inScope((tx) => count(tx, table, a))).toBe(0);
        else await expectSqlState(() => inScope((tx) => count(tx, table, a)), DENIED);
        const update = () =>
          inScope((tx) =>
            tx.execute(sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${a}`),
          );
        if (auth.update && auth.select) expect((await update()).rowCount).toBe(0);
        else await expectSqlState(update, DENIED);
        await expectSqlState(
          () => inScope((tx) => tx.execute(sql`delete from ${sql.identifier(table)} where agency_id = ${a}`)),
          DENIED,
        );
        await expectSqlState(() => inScope((tx) => tx.execute(insertSql(table, build({ agency_id: a })))), DENIED);
      }
      expect(await adminCount(a)).toBe(visible.length + hidden.length);
    });
  } else {
    it(`[S0-09] ${table}: app_auth cannot read, update or delete it`, async () => {
      await expectSqlState(() => withAuth((tx) => count(tx, table, a)), DENIED);
      await expectSqlState(
        () =>
          withAuth((tx) =>
            tx.execute(sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${a}`),
          ),
        DENIED,
      );
      await expectSqlState(
        () => withAuth((tx) => tx.execute(sql`delete from ${sql.identifier(table)} where agency_id = ${a}`)),
        DENIED,
      );
      expect(await adminCount(a)).toBe(visible.length + hidden.length);
    });
  }

  it(`[S0-09] ${table}: app_auth cannot insert a tenant's row`, async () => {
    await expectSqlState(() => withAuth((tx) => tx.execute(insertSql(table, build({ agency_id: a })))), DENIED);
  });

  const staff = def.staff;
  // S6-08: a staff column allowlist narrows UPDATE: the staff checks write one column staff may write.
  const staffColumn = staff?.updateColumns?.[0] ?? 'agency_id';
  const updateA = (tx: Tx) =>
    tx.execute(
      sql`update ${sql.identifier(table)} set ${sql.identifier(staffColumn)} = ${sql.identifier(staffColumn)} where agency_id = ${a}`,
    );
  const deleteA = (tx: Tx) => tx.execute(sql`delete from ${sql.identifier(table)} where agency_id = ${a}`);
  const insertA = (tx: Tx) => tx.execute(insertSql(table, build({ agency_id: a })));
  if (staff) {
    // Staff work across tenants (S1-03), but only while acting for an active staff member.
    it(`[S1-03] ${table}: app_staff for a user who is not staff reaches no rows`, async () => {
      if (staff.select) expect(await asNotStaff((tx) => count(tx, table, a))).toBe(0);
      else await expectSqlState(() => asNotStaff((tx) => count(tx, table, a)), DENIED);
      if (staff.update && staff.select) expect((await asNotStaff(updateA)).rowCount).toBe(0);
      else await expectSqlState(() => asNotStaff(updateA), DENIED);
      await expectSqlState(() => asNotStaff(insertA), DENIED);
      await expectSqlState(() => asNotStaff(deleteA), DENIED);
      expect(await adminCount(a)).toBe(visible.length + hidden.length);
    });

    it(`[S1-03] ${table}: staff read and write only what the staff predicates open, and never delete`, async () => {
      if (staff.select === 'true') {
        expect(await asStaff((tx) => count(tx, table, a))).toBe(visible.length + hidden.length);
      } else if (staff.select) {
        expect(await asStaff((tx) => count(tx, table, a))).toBeLessThanOrEqual(visible.length + hidden.length);
      } else {
        await expectSqlState(() => asStaff((tx) => count(tx, table, a)), DENIED);
      }
      if (!staff.update) await expectSqlState(() => asStaff(updateA), DENIED);
      if (!staff.insert) await expectSqlState(() => asStaff(insertA), DENIED);
      await expectSqlState(() => asStaff(deleteA), DENIED);
      expect(await adminCount(a)).toBe(visible.length + hidden.length);
    });

    if (staff.selectColumns || staff.updateColumns) {
      // S6-08: column allowlists — any other column is neither readable nor writable by staff.
      it(`[S6-08] ${table}: staff read and write only their column allowlists`, async () => {
        const cols = (await columnsOf(admin, table)).map((c) => c.name);
        for (const c of cols.filter((x) => staff.selectColumns && !staff.selectColumns.includes(x))) {
          await expectSqlState(
            () => asStaff((tx) => tx.execute(sql`select ${sql.identifier(c)} from ${sql.identifier(table)} limit 1`)),
            DENIED,
          );
        }
        for (const c of cols.filter((x) => staff.updateColumns && !staff.updateColumns.includes(x))) {
          await expectSqlState(
            () =>
              asStaff((tx) =>
                tx.execute(
                  sql`update ${sql.identifier(table)} set ${sql.identifier(c)} = ${sql.identifier(c)} where false`,
                ),
              ),
            DENIED,
          );
        }
      });
    }
  } else {
    it(`[S1-03] ${table}: app_staff cannot read, update, insert or delete it, even as staff`, async () => {
      for (const run of [asStaff, asNotStaff]) {
        await expectSqlState(() => run((tx) => count(tx, table, a)), DENIED);
        await expectSqlState(() => run(updateA), DENIED);
        await expectSqlState(() => run(insertA), DENIED);
        await expectSqlState(() => run(deleteA), DENIED);
      }
    });
  }

  // The media worker's role (S3-F4): every tenant table refuses it, except the hash column a `mediaRead` table opens.
  if (def.mediaRead) {
    it(`[S3-F4] ${table}: app_media reads only its mediaRead columns of every agency's rows, and writes nothing`, async () => {
      const cols = def.mediaRead?.columns ?? [];
      const seen = await asMedia((tx) =>
        tx.execute(sql`select count(${sql.identifier(cols[0] as string)}) as n from ${sql.identifier(table)}`),
      );
      expect(Number(seen.rows[0]?.n)).toBeGreaterThan(0);
      await expectSqlState(() => asMedia((tx) => count(tx, table, a)), DENIED);
      await expectSqlState(() => asMedia(updateA), DENIED);
      await expectSqlState(() => asMedia(insertA), DENIED);
      await expectSqlState(() => asMedia(deleteA), DENIED);
    });
  } else {
    it(`[S3-F4] ${table}: the media DB role cannot read, update, insert or delete it`, async () => {
      await expectSqlState(() => asMedia((tx) => count(tx, table, a)), DENIED);
      await expectSqlState(() => asMedia(updateA), DENIED);
      await expectSqlState(() => asMedia(insertA), DENIED);
      await expectSqlState(() => asMedia(deleteA), DENIED);
    });
  }

  const authAppend = def.authAppend;
  if (authAppend) {
    const own = { agency_id: PLATFORM_AGENCY_ID, [authAppend.column]: `${authAppend.prefix}isoFixture` };
    it(`[S0-09] ${table}: positive control — app_auth can append a platform row of its own kind`, async () => {
      await rolledBackAuth(async (tx) => {
        expect((await tx.execute(insertSql(table, build(own)))).rowCount).toBe(1);
      });
    });

    it(`[S0-09] ${table}: app_auth cannot append a platform row of another kind, or its kind for a tenant`, async () => {
      const foreign = { ...own, [authAppend.column]: 'billing.isoFixture' };
      await expectSqlState(() => withAuth((tx) => tx.execute(insertSql(table, build(foreign)))), DENIED);
      await expectSqlState(
        () => withAuth((tx) => tx.execute(insertSql(table, build({ ...own, agency_id: a })))),
        DENIED,
      );
    });
  } else {
    it(`[S0-09] ${table}: app_auth cannot append a platform row`, async () => {
      await expectSqlState(
        () => withAuth((tx) => tx.execute(insertSql(table, build({ agency_id: PLATFORM_AGENCY_ID })))),
        DENIED,
      );
    });
  }

  // Website form intake (S7-05): every tenant table refuses app_intake, except an `intake` table (its pinned agency's
  // rows: append, and read back the listed columns only) and an `intakeAppend` table (its own events, its own agency).
  const intakeAs = <T>(agencyId: string, fn: (tx: Tx) => Promise<T>) => withIntake({ agencyId }, fn);
  const rolledBackIntake = (agencyId: string, fn: (tx: Tx) => Promise<void>) =>
    intakeAs(agencyId, async (tx) => {
      await fn(tx);
      throw new Rollback();
    }).catch((err) => {
      if (!(err instanceof Rollback)) throw err;
    });
  const intake = def.intake;
  const intakeAppend = def.intakeAppend;
  if (intake) {
    const listed = intake.selectColumns;
    it(`[S7-05] ${table}: app_intake pinned to tenant B appends B's rows and reads back only (${listed.join(', ')})`, async () => {
      await rolledBackIntake(b, async (tx) => {
        // In a savepoint, like the positive control above: the suite creates no parent rows (FK 23503 is raised
        // only after RLS let the row through).
        await tx
          .transaction(async (sp) => sp.execute(insertSql(table, build({ agency_id: b }))))
          .catch((err: unknown) => {
            if (!PASSED_RLS.includes(sqlState(err) ?? '')) throw err;
          });
        const own = await tx.execute(sql`select ${sql.identifier(listed[0] as string)} from ${sql.identifier(table)}`);
        expect(own.rows.length).toBeGreaterThan(0);
      });
      // Tenant A's rows: invisible (RLS), not insertable, never changed or removed.
      const seenA = await intakeAs(b, (tx) =>
        tx.execute(sql`select ${sql.identifier(listed[0] as string)} from ${sql.identifier(table)}`),
      );
      expect(seenA.rows.length).toBe(await adminCount(b));
      await expectSqlState(() => intakeAs(b, (tx) => tx.execute(insertSql(table, build({ agency_id: a })))), DENIED);
      await expectSqlState(() => intakeAs(b, updateA), DENIED);
      await expectSqlState(() => intakeAs(b, deleteA), DENIED);
      // A column it does not list (the client's details) cannot be read, even on its own agency's rows.
      const columns = await columnsOf(admin, table);
      const other = columns.find((c) => !listed.includes(c.name))?.name as string;
      await expectSqlState(
        () => intakeAs(b, (tx) => tx.execute(sql`select ${sql.identifier(other)} from ${sql.identifier(table)}`)),
        DENIED,
      );
      await expectSqlState(() => intakeAs(b, (tx) => count(tx, table, b)), DENIED);
    });
  } else if (intakeAppend) {
    const own = { agency_id: b, [intakeAppend.column]: intakeAppend.values[0] };
    it(`[S7-05] ${table}: app_intake appends only its own kind of row for its pinned agency, and reads nothing`, async () => {
      await rolledBackIntake(b, async (tx) => {
        await tx
          .transaction(async (sp) => sp.execute(insertSql(table, build(own))))
          .catch((err: unknown) => {
            if (!PASSED_RLS.includes(sqlState(err) ?? '')) throw err;
          });
      });
      await expectSqlState(
        () => intakeAs(b, (tx) => tx.execute(insertSql(table, build({ ...own, agency_id: a })))),
        DENIED,
      );
      await expectSqlState(
        () =>
          intakeAs(b, (tx) => tx.execute(insertSql(table, build({ ...own, [intakeAppend.column]: 'x.isoFixture' })))),
        DENIED,
      );
      await expectSqlState(() => intakeAs(b, (tx) => count(tx, table, b)), DENIED);
      await expectSqlState(() => intakeAs(b, updateA), DENIED);
      await expectSqlState(() => intakeAs(b, deleteA), DENIED);
    });
  } else {
    it(`[S7-05] ${table}: the intake DB role cannot read, update, insert or delete it`, async () => {
      await expectSqlState(() => intakeAs(b, (tx) => count(tx, table, a)), DENIED);
      await expectSqlState(() => intakeAs(b, updateA), DENIED);
      await expectSqlState(() => intakeAs(b, insertA), DENIED);
      await expectSqlState(() => intakeAs(b, deleteA), DENIED);
    });
  }
});

describe.each(globalNames)('global table %s', (table) => {
  const def = isolationRegistry.global[table];
  let ctid = '';
  let column = '';
  let build: () => Row;

  beforeAll(async () => {
    const columns = await columnsOf(admin, table);
    column = columns[0]?.name ?? '';
    build = () => buildRow(table, columns, { ...def?.base });
    ctid = await withReplicaRole(admin, () => seed(admin, table, build()));
  });

  afterAll(async () => {
    if (ctid) await admin.query(`delete from "${table}" where ctid = $1::tid`, [ctid]);
  });

  const seen = (tx: Tx) =>
    tx
      .execute(sql`select count(*) as n from ${sql.identifier(table)} where ctid = ${ctid}::tid`)
      .then((r) => Number(r.rows[0]?.n));

  if (def?.access === 'staff') {
    it(`[S1-03] ${table}: staff table — tenants and app_public cannot read it`, async () => {
      await expectSqlState(() => withTenant({ agencyId: newId() }, seen), DENIED);
      await expectSqlState(() => withPublicRead(seen), DENIED);
    });

    it(`[S1-04] ${table}: app_auth sees only the row of the user its flow is scoped to`, async () => {
      const owner = (await admin.query(`select user_id from "${table}" where ctid = $1::tid`, [ctid])).rows[0]?.user_id;
      expect(await withAuth(seen)).toBe(0);
      expect(await withAuth((tx) => setAuthScope(tx, { userId: notStaffUserId }).then(() => seen(tx)))).toBe(0);
      expect(await withAuth((tx) => setAuthScope(tx, { userId: owner }).then(() => seen(tx)))).toBe(1);
    });

    it(`[S1-03] ${table}: app_staff sees only the row of the user it acts for, and writes nothing`, async () => {
      const owner = (await admin.query(`select user_id from "${table}" where ctid = $1::tid`, [ctid])).rows[0]?.user_id;
      expect(await withStaff({ userId: owner, reason: 'isolation' }, seen)).toBe(1);
      expect(await asNotStaff(seen)).toBe(0);
      await expectSqlState(() => asStaff((tx) => tx.execute(insertSql(table, build()))), DENIED);
      await expectSqlState(
        () =>
          asStaff((tx) =>
            tx.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${sql.identifier(column)}`),
          ),
        DENIED,
      );
      await expectSqlState(() => asStaff((tx) => tx.execute(sql`delete from ${sql.identifier(table)}`)), DENIED);
    });

    it(`[S1-03] ${table}: tenants and app_auth cannot write it`, async () => {
      await expectSqlState(() => withAuth((tx) => tx.execute(insertSql(table, build()))), DENIED);
      await expectSqlState(() => withAuth((tx) => tx.execute(sql`delete from ${sql.identifier(table)}`)), DENIED);
    });
  } else if (def?.access === 'auth') {
    it(`[S0-09] ${table}: auth table — tenants cannot read it`, async () => {
      await expectSqlState(() => withTenant({ agencyId: newId() }, seen), DENIED);
    });

    if (def.userScoped) {
      it(`[S1-04] ${table}: user-scoped — app_auth unscoped or scoped to another user sees and changes nothing`, async () => {
        expect(await withAuth(seen)).toBe(0);
        await rolledBackAuth(async (tx) => {
          await setAuthScope(tx, { userId: newId() });
          expect(await seen(tx)).toBe(0);
          const res = await tx.execute(
            sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${sql.identifier(column)} where ctid = ${ctid}::tid`,
          );
          expect(res.rowCount).toBe(0);
        });
        await expectSqlState(
          () =>
            withAuth(async (tx) => {
              await setAuthScope(tx, { userId: newId() });
              await tx.execute(insertSql(table, build()));
            }),
          DENIED,
        );
      });
    }

    it(`[S0-09] ${table}: positive control — app_auth reads and updates it`, async () => {
      await rolledBackAuth(async (tx) => {
        if (def.userScoped) {
          const owner = (await admin.query(`select user_id from "${table}" where ctid = $1::tid`, [ctid])).rows[0]
            ?.user_id;
          await setAuthScope(tx, { userId: owner });
        }
        expect(await seen(tx)).toBe(1);
        const res = await tx.execute(
          sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${sql.identifier(column)} where ctid = ${ctid}::tid`,
        );
        expect(res.rowCount).toBe(1);
      });
    });
  } else {
    if (def?.noUserRead) {
      it(`[S3-F1] ${table}: noUserRead — a member session cannot select from it`, async () => {
        await expectSqlState(() => withTenant({ agencyId: newId() }, seen), DENIED);
      });
    } else {
      it(`[S0-05] ${table}: every tenant can read it`, async () => {
        expect(await withTenant({ agencyId: newId() }, seen)).toBe(1);
      });
    }

    it(`[S0-09] ${table}: app_auth cannot read or write it`, async () => {
      await expectSqlState(() => withAuth(seen), DENIED);
      await expectSqlState(() => withAuth((tx) => tx.execute(insertSql(table, build()))), DENIED);
      await expectSqlState(() => withAuth((tx) => tx.execute(sql`delete from ${sql.identifier(table)}`)), DENIED);
    });
  }

  if (def?.mediaWrite) {
    it(`[S3-F4] ${table}: mediaWrite — the media DB role reads and changes every row`, async () => {
      await asMedia(async (tx) => {
        expect(await seen(tx)).toBe(1);
        const up = await tx.execute(
          sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${sql.identifier(column)} where ctid = ${ctid}::tid`,
        );
        expect(up.rowCount).toBe(1);
        throw new Rollback();
      }).catch((err) => {
        if (!(err instanceof Rollback)) throw err;
      });
    });
  } else {
    it(`[S3-F4] ${table}: the media DB role cannot read or write it`, async () => {
      await expectSqlState(() => asMedia(seen), DENIED);
      await expectSqlState(() => asMedia((tx) => tx.execute(insertSql(table, build()))), DENIED);
      await expectSqlState(
        () =>
          asMedia((tx) =>
            tx.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${sql.identifier(column)}`),
          ),
        DENIED,
      );
      await expectSqlState(() => asMedia((tx) => tx.execute(sql`delete from ${sql.identifier(table)}`)), DENIED);
    });
  }

  it(`[S7-05] ${table}: the intake DB role cannot read or write it`, async () => {
    const intake = <T>(fn: (tx: Tx) => Promise<T>) => withIntake({ agencyId: newId() }, fn);
    await expectSqlState(() => intake(seen), DENIED);
    await expectSqlState(() => intake((tx) => tx.execute(insertSql(table, build()))), DENIED);
    await expectSqlState(() => intake((tx) => tx.execute(sql`delete from ${sql.identifier(table)}`)), DENIED);
  });

  if (def?.staffWrite) {
    it(`[S2-04] ${table}: staffWrite — active staff read and change it; app_staff for a non-staff user gets nothing`, async () => {
      // Positive controls, each rolled back (an UPDATE gives the row a new ctid): an active staff member reads,
      // updates and deletes the row.
      const rolledBackStaff = (fn: (tx: Tx) => Promise<void>) =>
        asStaff(async (tx) => {
          await fn(tx);
          throw new Rollback();
        }).catch((err) => {
          if (!(err instanceof Rollback)) throw err;
        });
      expect(await asStaff(seen)).toBe(1);
      await rolledBackStaff(async (tx) => {
        const up = await tx.execute(
          sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${sql.identifier(column)} where ctid = ${ctid}::tid`,
        );
        expect(up.rowCount).toBe(1);
      });
      await rolledBackStaff(async (tx) => {
        const del = await tx.execute(sql`delete from ${sql.identifier(table)} where ctid = ${ctid}::tid`);
        expect(del.rowCount).toBe(1);
      });
      // `app_is_staff()` is false: no row is visible or changeable, and inserts fail the policy.
      expect(await asNotStaff(seen)).toBe(0);
      const none = await asNotStaff((tx) =>
        tx.execute(
          sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${sql.identifier(column)} where ctid = ${ctid}::tid`,
        ),
      );
      expect(none.rowCount).toBe(0);
      await expectSqlState(() => asNotStaff((tx) => tx.execute(insertSql(table, build()))), DENIED);
    });
  } else if (def?.access !== 'staff') {
    it(`[S1-03] ${table}: app_staff cannot read or write it`, async () => {
      await expectSqlState(() => asStaff(seen), DENIED);
      await expectSqlState(() => asStaff((tx) => tx.execute(insertSql(table, build()))), DENIED);
    });
  }

  it(`[S0-05] ${table}: tenants cannot insert, update or delete`, async () => {
    const agencyId = newId();
    await expectSqlState(() => withTenant({ agencyId }, (tx) => tx.execute(insertSql(table, build()))), DENIED);
    await expectSqlState(
      () =>
        withTenant({ agencyId }, (tx) =>
          tx.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${sql.identifier(column)}`),
        ),
      DENIED,
    );
    await expectSqlState(
      () => withTenant({ agencyId }, (tx) => tx.execute(sql`delete from ${sql.identifier(table)}`)),
      DENIED,
    );
  });

  it(`[S0-05] ${table}: app_public cannot insert, update, delete or truncate it, even in a read-write transaction`, async () => {
    await asAppPublic((client) => expectNoPublicWrites(client, table, build(), column));
  });

  if (def?.publicRead) {
    it(`[S0-05] ${table}: app_public can read it`, async () => {
      expect(await withPublicRead(seen)).toBe(1);
    });
    const samples = def.publicSamples;
    if (samples) {
      it(`[S8-02] ${table}: publicReadSql — app_public reads exactly the rows its predicate opens`, async () => {
        for (const [sample, expected] of [
          ...samples.visible.map((v) => [v, 1] as const),
          ...samples.hidden.map((h) => [h, 0] as const),
        ]) {
          const row = buildRow(table, await columnsOf(admin, table), { ...def.base, ...sample });
          const at = await withReplicaRole(admin, () => seed(admin, table, row));
          try {
            const n = await withPublicRead((tx) =>
              tx
                .execute(sql`select count(*) as n from ${sql.identifier(table)} where ctid = ${at}::tid`)
                .then((r) => Number(r.rows[0]?.n)),
            );
            expect(n, JSON.stringify(sample)).toBe(expected);
          } finally {
            await admin.query(`delete from "${table}" where ctid = $1::tid`, [at]);
          }
        }
      });
    }
  } else {
    it(`[S0-05] ${table}: app_public cannot read it`, async () => {
      await expectSqlState(() => withPublicRead(seen), DENIED);
    });
  }
});

// S8-F26: the legacy-key flag and the v1 shim's two id lookups are locked at the database.
describe('legacy key flag and id lookups (S8-F26)', () => {
  const agencyId = newId();
  const keyId = newId();
  const listingNew = newId();
  const contactNew = newId();
  const siteId = newId();
  const tag = `iso-${keyId.slice(0, 8)}`;

  beforeAll(async () => {
    const keyCols = await columnsOf(admin, 'api_keys');
    const mapCols = await columnsOf(admin, 'legacy_id_maps');
    await withReplicaRole(admin, async () => {
      await seed(admin, 'api_keys', buildRow('api_keys', keyCols, { id: keyId, agency_id: agencyId }));
      await seed(
        admin,
        'website_sites',
        buildRow('website_sites', await columnsOf(admin, 'website_sites'), {
          ...isolationRegistry.tenant.website_sites?.base,
          id: siteId,
          agency_id: agencyId,
        }),
      );
      await seed(
        admin,
        'legacy_id_maps',
        buildRow('legacy_id_maps', mapCols, { entity: 'listing', legacy_id: `${tag}-l`, new_id: listingNew }),
      );
      await seed(
        admin,
        'legacy_id_maps',
        buildRow('legacy_id_maps', mapCols, { entity: 'contact', legacy_id: `${tag}-c`, new_id: contactNew }),
      );
    });
  });

  afterAll(async () => {
    await admin.query('delete from api_keys where id = $1', [keyId]);
    await withReplicaRole(admin, () => admin.query('delete from website_sites where id = $1', [siteId]));
    await admin.query('delete from legacy_id_maps where legacy_id like $1', [`${tag}%`]);
  });

  it('[S8-F26] app_user cannot update api_keys.legacy_query_key (42501), but still updates the other columns', async () => {
    await expectSqlState(
      () =>
        withTenant({ agencyId }, (tx) =>
          tx.execute(sql`update api_keys set legacy_query_key = true where id = ${keyId}`),
        ),
      DENIED,
    );
    await expectSqlState(
      () =>
        withTenant({ agencyId }, (tx) =>
          tx.execute(sql`update api_keys set legacy_query_key = legacy_query_key where id = ${keyId}`),
        ),
      DENIED,
    );
    await rolledBack(agencyId, async (tx) => {
      const r = await tx.execute(
        sql`update api_keys set updated_at = now(), rate_tier = rate_tier where id = ${keyId}`,
      );
      expect(r.rowCount).toBe(1);
    });
    const { rows } = await admin.query('select legacy_query_key from api_keys where id = $1', [keyId]);
    expect(rows[0].legacy_query_key).toBe(false);
  });

  it('[S8-F26] an app_user insert that sets legacy_query_key gets 42501 from the guard; false passes the guard', async () => {
    const userId = newId();
    const insert = (flag: boolean) =>
      withTenant({ agencyId, userId }, (tx) =>
        tx.execute(sql`insert into api_keys (id, agency_id, name, kind, prefix, key_hash, scopes, created_by, site_id, legacy_query_key)
          values (${newId()}, ${agencyId}, 'k', 'SECRET', ${`${tag}-${flag}`}, 'h', '{}', ${userId}, ${siteId}, ${flag})`),
      );
    const err = await insert(true).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(sqlState(err)).toBe('42501');
    expect(String((err as Error).message + (err as { cause?: Error }).cause?.message)).toMatch(/not a legacy key/);
    // The control: the same row without the flag is refused only by the agency FK (the guard let it through).
    await expectSqlState(() => insert(false), PASSED_RLS);
  });

  it('[S8-F26] app_system can still set the flag', async () => {
    const system = new pg.Client({ connectionString: systemUrl });
    await system.connect();
    try {
      const r = await system.query('update api_keys set legacy_query_key = true where id = $1', [keyId]);
      expect(r.rowCount).toBe(1);
      await system.query('update api_keys set legacy_query_key = false where id = $1', [keyId]);
    } finally {
      await system.end();
    }
  });

  const lookups = [
    sql`select * from public.legacy_target_ids(array['x']::text[])`,
    sql`select * from public.legacy_ids_of(array[${newId()}]::uuid[])`,
  ];

  it('[S8-F26] app_user, app_intake, app_auth and app_staff get 42501 calling either lookup', async () => {
    for (const q of lookups) {
      await expectSqlState(() => withTenant({ agencyId }, (tx) => tx.execute(q)), DENIED);
      await expectSqlState(() => withIntake({ agencyId }, (tx) => tx.execute(q)), DENIED);
      await expectSqlState(() => withAuth((tx) => tx.execute(q)), DENIED);
      await expectSqlState(() => asStaff((tx) => tx.execute(q)), DENIED);
    }
  });

  it('[S8-F26] app_public gets listing ids only: a contact map row never comes back, from either lookup', async () => {
    const got = await withPublicRead(async (tx) => ({
      target: (
        await tx.execute(
          sql`select entity, legacy_id, new_id from public.legacy_target_ids(array[${`${tag}-l`}, ${`${tag}-c`}]::text[])`,
        )
      ).rows,
      of: (
        await tx.execute(
          sql`select new_id, legacy_id from public.legacy_ids_of(array[${listingNew}, ${contactNew}]::uuid[])`,
        )
      ).rows,
    }));
    expect(got.target).toEqual([{ entity: 'listing', legacy_id: `${tag}-l`, new_id: listingNew }]);
    expect(got.of).toEqual([{ new_id: listingNew, legacy_id: `${tag}-l` }]);
  });

  it('[S8-F26] both lookups are owned by app_owner', async () => {
    const { rows } = await admin.query(
      `select p.proname, pg_get_userbyid(p.proowner) as owner from pg_proc p
        where p.proname in ('legacy_target_ids', 'legacy_ids_of') and p.pronamespace = 'public'::regnamespace`,
    );
    expect(rows.map((r) => `${r.proname}:${r.owner}`).sort()).toEqual([
      'legacy_ids_of:app_owner',
      'legacy_target_ids:app_owner',
    ]);
  });

  it('[S9-review] the portal feed token lookup (SECURITY DEFINER) is owned by app_owner', async () => {
    const { rows } = await admin.query(
      `select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer from pg_proc p
        where p.proname = 'portal_feed_by_token' and p.pronamespace = 'public'::regnamespace`,
    );
    expect(rows).toEqual([{ owner: 'app_owner', definer: true }]);
  });
});

// S10-F4: portal secrets never reach a request path; the generator's and push job's state is theirs alone.
describe('portal secrets and worker tables (S10-F4)', () => {
  const agencyId = newId();
  const connectionId = newId();
  const propertyId = newId();
  const runId = newId();
  const reg = isolationRegistry.tenant;

  beforeAll(async () => {
    await withReplicaRole(admin, async () => {
      await seed(
        admin,
        'agency_portal_connections',
        buildRow('agency_portal_connections', await columnsOf(admin, 'agency_portal_connections'), {
          ...reg.agency_portal_connections?.base,
          id: connectionId,
          agency_id: agencyId,
          credentials_enc: 'v1.isolation-envelope',
          push_error: 'AUTH_REJECTED',
        }),
      );
      await seed(
        admin,
        'portal_listing_sync',
        buildRow('portal_listing_sync', await columnsOf(admin, 'portal_listing_sync'), {
          ...reg.portal_listing_sync?.base,
          connection_id: connectionId,
          property_id: propertyId,
          agency_id: agencyId,
          remote_id: 'remote-1',
        }),
      );
      await seed(
        admin,
        'portal_feed_runs',
        buildRow('portal_feed_runs', await columnsOf(admin, 'portal_feed_runs'), {
          ...reg.portal_feed_runs?.base,
          id: runId,
          connection_id: connectionId,
          agency_id: agencyId,
        }),
      );
    });
  });

  afterAll(async () => {
    await withReplicaRole(admin, async () => {
      await admin.query('delete from portal_listing_sync where connection_id = $1', [connectionId]);
      await admin.query('delete from portal_feed_runs where connection_id = $1', [connectionId]);
      await admin.query('delete from agency_portal_connections where id = $1', [connectionId]);
    });
  });

  it('[S10-F4] app_user selecting credentials_enc or token_hash gets 42501, even on its own row; the rest reads', async () => {
    for (const read of [
      sql`select credentials_enc from agency_portal_connections where id = ${connectionId}`,
      sql`select token_hash from agency_portal_connections where id = ${connectionId}`,
      sql`select * from agency_portal_connections where id = ${connectionId}`,
      sql`select id from agency_portal_connections where credentials_enc is not null`,
      sql`update agency_portal_connections set name = name where id = ${connectionId} returning token_hash`,
    ]) {
      await expectSqlState(() => withTenant({ agencyId }, (tx) => tx.execute(read)), DENIED);
    }
    const r = await withTenant({ agencyId }, (tx) =>
      tx.execute<{ push_error: string; credential_keys: string[] }>(
        sql`select push_error, credential_keys from agency_portal_connections where id = ${connectionId}`,
      ),
    );
    expect(r.rows).toEqual([{ push_error: 'AUTH_REJECTED', credential_keys: [] }]);
  });

  it('[S10-F4] app_user writing portal_listing_sync.remote_id gets 42501; sync rows and feed runs are SELECT-only', async () => {
    for (const write of [
      sql`update portal_listing_sync set remote_id = 'planted' where connection_id = ${connectionId}`,
      sql`insert into portal_listing_sync (connection_id, property_id, agency_id, state, remote_id, payload_hash, synced_at)
          values (${connectionId}, ${newId()}, ${agencyId}, 'SYNCED', 'planted', 'h', now())`,
      sql`delete from portal_listing_sync where connection_id = ${connectionId}`,
      sql`update portal_feed_runs set status = 'FAILED' where id = ${runId}`,
      sql`insert into portal_feed_runs (id, agency_id, connection_id, trigger, status, started_at, finished_at)
          values (${newId()}, ${agencyId}, ${connectionId}, 'EVENT', 'WRITTEN', now(), now())`,
      sql`delete from portal_feed_runs where id = ${runId}`,
    ]) {
      await expectSqlState(() => withTenant({ agencyId }, (tx) => tx.execute(write)), DENIED);
    }
    // Reads still work (the dashboard's run list and the delete check).
    const n = await withTenant({ agencyId }, async (tx) => {
      const sync = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from portal_listing_sync where connection_id = ${connectionId}`,
      );
      const runs = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from portal_feed_runs where connection_id = ${connectionId}`,
      );
      return [sync.rows[0]?.n, runs.rows[0]?.n];
    });
    expect(n).toEqual([1, 1]);
    const { rows } = await admin.query('select remote_id from portal_listing_sync where connection_id = $1', [
      connectionId,
    ]);
    expect(rows).toEqual([{ remote_id: 'remote-1' }]);
  });

  it('[S10-F4] app_user cannot update feed_run_id, feed_sha256, push_error or nightly_at; the setup columns update', async () => {
    for (const write of [
      sql`update agency_portal_connections set feed_run_id = ${newId()} where id = ${connectionId}`,
      sql`update agency_portal_connections set feed_sha256 = 'planted' where id = ${connectionId}`,
      sql`update agency_portal_connections set push_error = null where id = ${connectionId}`,
      sql`update agency_portal_connections set nightly_at = now() where id = ${connectionId}`,
    ]) {
      await expectSqlState(() => withTenant({ agencyId }, (tx) => tx.execute(write)), DENIED);
    }
    await rolledBack(agencyId, async (tx) => {
      const r = await tx.execute(
        sql`update agency_portal_connections set name = 'Renamed', credentials_enc = 'v1.new', version = version + 1
             where id = ${connectionId}`,
      );
      expect(r.rowCount).toBe(1);
    });
  });

  it('[S10-F4] a change of credentials or on/off clears push_error (trigger); other changes keep it', async () => {
    const pushError = async (tx: Tx) =>
      (
        await tx.execute<{ push_error: string | null }>(
          sql`select push_error from agency_portal_connections where id = ${connectionId}`,
        )
      ).rows[0]?.push_error;
    // One update per transaction: the seeded row's agency does not exist, and a row this transaction already wrote is
    // FK-checked again on its next update.
    const pushErrorAfter = async (change: ReturnType<typeof sql>, expected: string | null) =>
      rolledBack(agencyId, async (tx) => {
        await tx.execute(change);
        expect(await pushError(tx)).toBe(expected);
      });
    await pushErrorAfter(
      sql`update agency_portal_connections set name = 'Other' where id = ${connectionId}`,
      'AUTH_REJECTED',
    );
    await pushErrorAfter(
      sql`update agency_portal_connections set enabled = enabled where id = ${connectionId}`,
      'AUTH_REJECTED',
    );
    await pushErrorAfter(
      sql`update agency_portal_connections set credentials_enc = 'v1.new' where id = ${connectionId}`,
      null,
    );
    await pushErrorAfter(sql`update agency_portal_connections set enabled = false where id = ${connectionId}`, null);
  });
});

describe('data export job state (S11-F3)', () => {
  const agencyId = newId();
  const exportId = newId();

  beforeAll(async () => {
    await withReplicaRole(admin, async () => {
      await seed(
        admin,
        'data_export_jobs',
        buildRow('data_export_jobs', await columnsOf(admin, 'data_export_jobs'), {
          ...isolationRegistry.tenant.data_export_jobs?.base,
          id: exportId,
          agency_id: agencyId,
          created_by: newId(),
          status: 'RUNNING',
        }),
      );
    });
  });

  afterAll(async () => {
    await withReplicaRole(admin, async () => {
      await admin.query('delete from data_export_jobs where id = $1', [exportId]);
    });
  });

  it('[S11-F3] app_user updating any column (status, expires_at, file_deleted_at, kind, created_by) or deleting the row gets 42501; app_system writes them', async () => {
    for (const write of [
      sql`update data_export_jobs set status = 'SUCCEEDED' where id = ${exportId}`,
      sql`update data_export_jobs set expires_at = now() + interval '1 year' where id = ${exportId}`,
      sql`update data_export_jobs set file_deleted_at = now() where id = ${exportId}`,
      sql`update data_export_jobs set attempts = attempts + 1 where id = ${exportId}`,
      sql`update data_export_jobs set kind = 'ACCOUNT' where id = ${exportId}`,
      sql`update data_export_jobs set created_by = ${newId()} where id = ${exportId}`,
      sql`update data_export_jobs set updated_at = now() where id = ${exportId}`,
      sql`delete from data_export_jobs where id = ${exportId}`,
    ]) {
      await expectSqlState(() => withTenant({ agencyId }, (tx) => tx.execute(write)), DENIED);
    }
    // the agency still reads its own row (the status page)
    const own = await withTenant({ agencyId }, (tx) =>
      tx.execute<{ status: string }>(sql`select status from data_export_jobs where id = ${exportId}`),
    );
    expect(own.rows).toEqual([{ status: 'RUNNING' }]);
    const system = new pg.Client({ connectionString: systemUrl });
    await system.connect();
    try {
      const r = await system.query(
        `update data_export_jobs set status = 'FAILED', expires_at = now(), file_deleted_at = now() where id = $1`,
        [exportId],
      );
      expect(r.rowCount).toBe(1);
    } finally {
      await system.end();
    }
  });
});
