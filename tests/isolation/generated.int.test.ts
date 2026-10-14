import {
  getPgClient,
  SAMPLE_READER,
  SAMPLE_USER,
  setAuthScope,
  type TenantTable,
  type Tx,
  withAuth,
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
      it(`[S0-05] ${table}: tenant B cannot update tenant A's rows`, async () => {
        const res = await withTenant(as(b), (tx) =>
          tx.execute(sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${a}`),
        );
        expect(res.rowCount).toBe(0);
      });

      it(`[S0-05] ${table}: tenant B cannot delete tenant A's rows`, async () => {
        const res = await withTenant(as(b), (tx) =>
          tx.execute(sql`delete from ${sql.identifier(table)} where agency_id = ${a}`),
        );
        expect(res.rowCount).toBe(0);
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
  } else if (!def.appendOnly && def.immutable) {
    it(`[S1-08] ${table}: positive control — tenant B can insert and read its own rows`, async () => {
      await rb(b, async (tx) => {
        expect((await tx.execute(insertSql(table, build({ agency_id: b })))).rowCount).toBe(1);
        expect(await count(tx, table, b)).toBe(2);
      });
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
  const updateA = (tx: Tx) =>
    tx.execute(sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${a}`);
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
});

describe.each(globalNames)('global table %s', (table) => {
  const def = isolationRegistry.global[table];
  let ctid = '';
  let column = '';
  let build: () => Row;

  beforeAll(async () => {
    const columns = await columnsOf(admin, table);
    column = columns[0]?.name ?? '';
    build = () => buildRow(table, columns, {});
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
    it(`[S0-05] ${table}: every tenant can read it`, async () => {
      expect(await withTenant({ agencyId: newId() }, seen)).toBe(1);
    });

    it(`[S0-09] ${table}: app_auth cannot read or write it`, async () => {
      await expectSqlState(() => withAuth(seen), DENIED);
      await expectSqlState(() => withAuth((tx) => tx.execute(insertSql(table, build()))), DENIED);
      await expectSqlState(() => withAuth((tx) => tx.execute(sql`delete from ${sql.identifier(table)}`)), DENIED);
    });
  }

  if (def?.access !== 'staff') {
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
  } else {
    it(`[S0-05] ${table}: app_public cannot read it`, async () => {
      await expectSqlState(() => withPublicRead(seen), DENIED);
    });
  }
});
