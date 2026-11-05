import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb, withSystem } from '@inmolink/db';
import { adminQuery, ownerExec, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeReferenceFixtures } from '../../../testing/factories';
import * as taxonomy from '../index';

/** S17-F37: every property type has a Spanish name (the catalog falls back to English per row otherwise). */

const RUN = newId().slice(-8).toLowerCase();
const PREFIX = 'esl-';
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('taxonomy.es-labels.test', fn);
const MIGRATION = join(process.cwd(), '..', 'db', 'migrations', '0183_s17_f43_property_type_es_labels_rls.sql');

let plotId: string;
let semiId: string;

beforeAll(async () => {
  await setupTestDb('worker');
  await purgeReferenceFixtures(PREFIX);
  await system(async (tx) => {
    const groupId = await taxonomy.createPropertyTypeGroup(tx, {
      key: `${PREFIX}g-${RUN}`,
      sort: 0,
      translations: [{ locale: 'en', name: `Houses ${RUN}`, slug: `${PREFIX}g-${RUN}` }],
    });
    // English only, as the legacy import left them.
    plotId = await taxonomy.createPropertyType(tx, {
      groupId,
      key: `${PREFIX}plot-${RUN}`,
      sort: 0,
      translations: [{ locale: 'en', name: 'Plot', slug: `${PREFIX}plot-${RUN}` }],
    });
    semiId = await taxonomy.createPropertyType(tx, {
      groupId,
      key: `${PREFIX}semi-${RUN}`,
      sort: 0,
      translations: [{ locale: 'en', name: 'Semi-Detached House', slug: `${PREFIX}semi-${RUN}` }],
    });
  });
}, 120_000);

afterAll(async () => {
  await purgeReferenceFixtures(PREFIX);
  await closeDb();
});

const spanish = (id: string) =>
  system(async (tx) => {
    const r = await tx.execute<{ name: string }>(
      sql`select name from property_type_translations where type_id = ${id} and locale = 'es'`,
    );
    return r.rows[0]?.name ?? null;
  });

describe('[S17-F37] property types have a Spanish label', () => {
  it('[S17-F37] the data migration names Plot and Semi-Detached House in Spanish, once', async () => {
    expect(await spanish(plotId)).toBeNull();
    // As the role migrations run as: FORCE RLS hides the rows from it (S17-F43, 0182 changed nothing on staging).
    const run = () => ownerExec(readFileSync(MIGRATION, 'utf8'));
    await run();
    await run();
    expect(await spanish(plotId)).toBe('Parcela');
    expect(await spanish(semiId)).toBe('Casa pareada');
    const [row] = await adminQuery<{ forced: boolean }>(
      `select relforcerowsecurity as forced from pg_class where oid = 'public.property_type_translations'::regclass`,
    );
    expect(row?.forced, 'FORCE RLS is back on').toBe(true);
  });

  it('[S17-F37] no property type named Plot or Semi-Detached lacks a Spanish name', async () => {
    const missing = await system(async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`
        select t.type_id as id from property_type_translations t
         where t.locale = 'en' and lower(t.name) in ('plot', 'semi-detached house', 'semi-detached')
           and not exists (select 1 from property_type_translations x where x.type_id = t.type_id and x.locale = 'es')
           and t.type_id in (${plotId}, ${semiId})`);
      return r.rows;
    });
    expect(missing).toEqual([]);
  });
});
