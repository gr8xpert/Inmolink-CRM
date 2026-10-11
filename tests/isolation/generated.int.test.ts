import {
  getPgClient,
  setAuthScope,
  type TenantTable,
  type Tx,
  withAuth,
  withPublicRead,
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
const FK_VIOLATION = '23503';

/** Runs `fn` as the tenant and rolls the transaction back (positive controls leave no rows). */
class Rollback extends Error {}
async function rolledBack(agencyId: string, fn: (tx: Tx) => Promise<void>): Promise<void> {
  await withTenant({ agencyId }, async (tx) => {
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

beforeAll(async () => {
  const cfg = await setupIsolation();
  ownerUrl = cfg.DATABASE_URL_APP_OWNER;
  admin = new pg.Client({ connectionString: cfg.DATABASE_URL_ADMIN });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end();
  if (ownerUrl) await teardownIsolation(ownerUrl);
});

const count = async (tx: Tx, table: string, agencyId: string) =>
  Number(
    (await tx.execute(sql`select count(*) as n from ${sql.identifier(table)} where agency_id = ${agencyId}`)).rows[0]
      ?.n,
  );

function samplesOf(def: TenantTable): { visible: Row[]; hidden: Row[] } {
  if (def.kind === 'STRICT') return { visible: [], hidden: [{}] };
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

  beforeAll(async () => {
    const columns = await columnsOf(admin, table);
    build = (overrides) => buildRow(table, columns, { ...def.base, ...overrides });
    await withReplicaRole(admin, async () => {
      for (const sample of [...visible, ...hidden]) await seed(admin, table, build({ ...sample, agency_id: a }));
      await seed(admin, table, build({ agency_id: b }));
    });
  });

  afterAll(async () => {
    await admin.query(`delete from "${table}" where agency_id = any($1)`, [[a, b]]);
  });

  const adminCount = async (agencyId: string) =>
    Number((await admin.query(`select count(*) as n from "${table}" where agency_id = $1`, [agencyId])).rows[0].n);

  if (def.appendOnly) {
    // Write-only for tenants (e.g. the outbox): every read, update and delete is denied, even on own rows.
    it(`[S0-06] ${table}: append-only — tenants cannot select, update or delete any rows, even their own`, async () => {
      for (const agencyId of [a, b]) {
        await expectSqlState(() => withTenant({ agencyId: b }, (tx) => count(tx, table, agencyId)), DENIED);
        await expectSqlState(
          () =>
            withTenant({ agencyId: b }, (tx) =>
              tx.execute(sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${agencyId}`),
            ),
          DENIED,
        );
        await expectSqlState(
          () =>
            withTenant({ agencyId: b }, (tx) =>
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
        () => withTenant({ agencyId: b }, (tx) => tx.execute(insertSql(table, build({ agency_id: a })))),
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
      await rolledBack(b, async (tx) => {
        expect((await tx.execute(insertSql(table, build({ agency_id: b })))).rowCount).toBe(1);
      });
      expect(await adminCount(b)).toBe(1);
    });
  } else {
    it(`[S0-05] ${table}: tenant A reads all of its own rows`, async () => {
      expect(await withTenant({ agencyId: a }, (tx) => count(tx, table, a))).toBe(visible.length + hidden.length);
    });

    if (def.kind === 'NETWORK_READ') {
      it(`[S0-05] ${table}: tenant B reads tenant A's rows only where the network predicate holds`, async () => {
        expect(await withTenant({ agencyId: b }, (tx) => count(tx, table, a))).toBe(visible.length);
      });
    } else {
      it(`[S0-05] ${table}: tenant B cannot select tenant A's rows`, async () => {
        expect(await withTenant({ agencyId: b }, (tx) => count(tx, table, a))).toBe(0);
      });
    }

    it(`[S0-05] ${table}: tenant B cannot update tenant A's rows`, async () => {
      const res = await withTenant({ agencyId: b }, (tx) =>
        tx.execute(sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${a}`),
      );
      expect(res.rowCount).toBe(0);
    });

    it(`[S0-05] ${table}: tenant B cannot delete tenant A's rows`, async () => {
      const res = await withTenant({ agencyId: b }, (tx) =>
        tx.execute(sql`delete from ${sql.identifier(table)} where agency_id = ${a}`),
      );
      expect(res.rowCount).toBe(0);
      expect(await adminCount(a)).toBe(visible.length + hidden.length);
    });

    it(`[S0-05] ${table}: tenant B cannot insert a row for tenant A`, async () => {
      await expectSqlState(
        () => withTenant({ agencyId: b }, (tx) => tx.execute(insertSql(table, build({ agency_id: a })))),
        DENIED,
      );
    });

    it(`[S0-05] ${table}: tenant B cannot move its own row to tenant A`, async () => {
      await expectSqlState(
        () =>
          withTenant({ agencyId: b }, (tx) =>
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
      await rolledBack(b, async (tx) => {
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
      await rolledBack(b, async (tx) => {
        const res = await tx.execute(
          sql`update ${sql.identifier(table)} set agency_id = agency_id where agency_id = ${b}`,
        );
        expect(res.rowCount).toBe(1);
      });
      await expectSqlState(
        () => rolledBack(b, (tx) => tx.execute(insertSql(table, build({ agency_id: b }))).then(() => undefined)),
        DENIED,
      );
      expect(await adminCount(b)).toBe(1);
    });
  } else if (!def.appendOnly) {
    it(`[S0-05] ${table}: positive control — tenant B can insert and update its own rows`, async () => {
      // Proves the cross-tenant denials above come from the policies, not from a missing grant.
      await rolledBack(b, async (tx) => {
        // In a savepoint: a table whose parents the suite does not create (FK to agencies, users)
        // fails the insert with 23503 — which the FK trigger raises only after RLS let the row through.
        const inserted = await tx
          .transaction(async (sp) => (await sp.execute(insertSql(table, build({ agency_id: b })))).rowCount)
          .catch((err: unknown) => {
            if (sqlState(err) === FK_VIOLATION) return 0;
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

  if (def?.access === 'auth') {
    it(`[S0-09] ${table}: auth table — tenants cannot read it`, async () => {
      await expectSqlState(() => withTenant({ agencyId: newId() }, seen), DENIED);
    });

    it(`[S0-09] ${table}: positive control — app_auth reads and updates it`, async () => {
      await rolledBackAuth(async (tx) => {
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
