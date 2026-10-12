import { getPgClient, type Tx, withPublicRead, withTenant } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupIsolation, teardownIsolation } from './fixtures';
import { buildRow, columnsOf, expectSqlState, seed, withReplicaRole } from './rows';

/**
 * PREFERRED sharing through the real policy generator (S1-07): `iso_fx_preferred` carries the listing
 * policy S3-02 ships (`share_scope = 'PREFERRED' and agency_id in (select a from
 * public.app_preferring_agencies() a)`, ANDed by the generator with the verified-reader check), over the real
 * `preferred_agencies` and `agency_directory` tables. S3-02 repeats these checks on `listings`.
 */

let admin: pg.Client;
let ownerUrl = '';

const owner = newId(); // shares listings
const partner = newId(); // on owner's preferred list
const other = newId(); // verified, not on the list
const second = newId(); // also on owner's list (partner must not learn about it)

const TABLE = 'iso_fx_preferred';

const count = (agencyId: string) => withTenant({ agencyId }, async (tx) => scopesSeenBy(tx));

async function scopesSeenBy(tx: Tx): Promise<string[]> {
  const r = await tx.execute<{ share_scope: string }>(
    sql`select share_scope from ${sql.identifier(TABLE)} where agency_id = ${owner} order by share_scope`,
  );
  return r.rows.map((row) => row.share_scope);
}

const setStatus = (agencyId: string, status: 'VERIFIED' | 'SUSPENDED') =>
  withReplicaRole(admin, async () => {
    await admin.query('update agencies set status = $2 where agency_id = $1', [agencyId, status]);
    await admin.query('update agency_directory set listed = $2 where agency_id = $1', [
      agencyId,
      status === 'VERIFIED',
    ]);
  });

const prefer = (agencyId: string, preferredAgencyId: string) =>
  withReplicaRole(admin, () =>
    admin.query('insert into preferred_agencies (agency_id, preferred_agency_id) values ($1, $2)', [
      agencyId,
      preferredAgencyId,
    ]),
  );

beforeAll(async () => {
  const cfg = await setupIsolation();
  ownerUrl = cfg.DATABASE_URL_APP_OWNER;
  admin = new pg.Client({ connectionString: cfg.DATABASE_URL_ADMIN });
  await admin.connect();
  const agencyColumns = await columnsOf(admin, 'agencies');
  await withReplicaRole(admin, async () => {
    for (const id of [owner, partner, other, second]) {
      await seed(admin, 'agencies', buildRow('agencies', agencyColumns, { agency_id: id, status: 'VERIFIED' }));
      await admin.query(
        `insert into agency_directory (agency_id, name, kind, listed) values ($1, $2, 'AGENCY', true)`,
        [id, `Iso ${id}`],
      );
    }
    for (const scope of ['ALL', 'PREFERRED', 'PRIVATE']) {
      await admin.query(`insert into ${TABLE} (id, agency_id, share_scope) values ($1, $2, $3)`, [
        newId(),
        owner,
        scope,
      ]);
    }
  });
  await prefer(owner, partner);
  await prefer(owner, second);
});

afterAll(async () => {
  await admin?.query(`delete from ${TABLE} where agency_id = $1`, [owner]);
  await admin?.query('delete from agencies where agency_id = any($1)', [[owner, partner, other, second]]);
  await admin?.end();
  if (ownerUrl) await teardownIsolation(ownerUrl);
});

describe('PREFERRED share scope (S1-07)', () => {
  it('[S1-07] a PREFERRED-scope row is visible to preferred agencies and invisible to others', async () => {
    expect(await count(partner)).toEqual(['ALL', 'PREFERRED']);
    expect(await count(second)).toEqual(['ALL', 'PREFERRED']);
    expect(await count(other)).toEqual(['ALL']);
    expect(await count(owner)).toEqual(['ALL', 'PREFERRED', 'PRIVATE']);
  });

  it('[S1-07] removing an agency from the list revokes access on the next query (no caching)', async () => {
    // One open transaction of the partner: the removal commits between two of its statements.
    const client = await getPgClient('app_user');
    try {
      await client.query('begin');
      await client.query(`select set_config('app.agency_id', $1, true)`, [partner]);
      const seen = async () =>
        (await client.query(`select share_scope from ${TABLE} where agency_id = $1 order by 1`, [owner])).rows.map(
          (r) => r.share_scope,
        );
      expect(await seen()).toEqual(['ALL', 'PREFERRED']);
      await admin.query('delete from preferred_agencies where agency_id = $1 and preferred_agency_id = $2', [
        owner,
        partner,
      ]);
      expect(await seen()).toEqual(['ALL']);
      await client.query('commit');
    } finally {
      client.release();
    }
    expect(await count(partner)).toEqual(['ALL']);
    await prefer(owner, partner);
    expect(await count(partner)).toEqual(['ALL', 'PREFERRED']);
  });

  it('[S1-07] a preferred agency that is no longer verified sees nothing; an unlisted owner shares no PREFERRED rows', async () => {
    await setStatus(partner, 'SUSPENDED');
    try {
      expect(await count(partner)).toEqual([]);
    } finally {
      await setStatus(partner, 'VERIFIED');
    }
    // The owner left the directory (suspended): its PREFERRED rows stop reaching partners at once.
    // ALL rows of a suspended owner are the listing policy's business (S3-02), not this helper's.
    await setStatus(owner, 'SUSPENDED');
    try {
      expect(await count(partner)).toEqual(['ALL']);
    } finally {
      await setStatus(owner, 'VERIFIED');
    }
    expect(await count(partner)).toEqual(['ALL', 'PREFERRED']);
  });

  it('[S1-07] app_preferring_agencies answers only for the calling agency, and only app_user may call it', async () => {
    const preferringOf = (agencyId: string) =>
      withTenant({ agencyId }, async (tx) =>
        (await tx.execute<{ a: string }>(sql`select a from app_preferring_agencies() a`)).rows.map((r) => r.a),
      );
    expect(await preferringOf(partner)).toEqual([owner]);
    expect(await preferringOf(other)).toEqual([]);
    expect(await preferringOf(owner)).toEqual([]); // not mutual
    // The partner reads the relationship naming it, never the owner's other partners, never the note.
    const relationshipsSeenBy = (agencyId: string) =>
      withTenant({ agencyId }, async (tx) =>
        (
          await tx.execute<{ preferred_agency_id: string }>(
            sql`select preferred_agency_id from preferred_agencies where agency_id = ${owner}`,
          )
        ).rows.map((r) => r.preferred_agency_id),
      );
    expect(await relationshipsSeenBy(partner)).toEqual([partner]);
    // A suspended owner's relationships are invisible to its partners.
    await setStatus(owner, 'SUSPENDED');
    try {
      expect(await relationshipsSeenBy(partner)).toEqual([]);
      expect(await preferringOf(partner)).toEqual([]);
    } finally {
      await setStatus(owner, 'VERIFIED');
    }
    await expectSqlState(
      () => withPublicRead((tx) => tx.execute(sql`select a from app_preferring_agencies() a`)),
      ['42501'],
    );
  });

  it('[S1-07] the PREFERRED policy is planned as one semi-join, not a function call per listing row', async () => {
    const plan = await withTenant({ agencyId: partner }, async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const r = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`explain (costs off) select share_scope from ${sql.identifier(TABLE)} where agency_id = ${owner}`,
      );
      return r.rows.map((row) => row['QUERY PLAN']).join('\n');
    });
    // Inlined: the helper's tables appear in the plan; no Function Scan, no per-row helper call.
    expect(plan).not.toMatch(/Function Scan|app_preferring_agencies|app_is_preferred_by/);
    expect(plan).toMatch(/preferred_agencies_preferred_idx|preferred_agencies_pkey/);
    expect(plan).not.toMatch(/Seq Scan on preferred_agencies/);
  });
});
