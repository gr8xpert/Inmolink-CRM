import { performance } from 'node:perf_hooks';
import { CreateDevelopmentBody, CreatePriceListBody, CreateUnitsBody } from '@inmolink/contracts';
import { withMemberCtx } from '@inmolink/core';
import * as developments from '@inmolink/core/modules/developments';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * S5-F3 budget, timed here (S12-F19: wall-clock budgets run in the perf project; the int run keeps the statement
 * count, the events and the histories in packages/core/src/modules/developments/__tests__/service.int.test.ts):
 * approving a 2,000-unit price list. Dashboard budget p95 < 300 ms is measured on staging (H4); on the local Docker
 * Desktop disk one approval takes 390–850 ms (the same statements vary 2–3× run to run), so this guards the shape at
 * < 2 s — the old path wrote 6,000 outbox rows.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
let owner: Founder;
let ids: { location: string; type: string };

const as = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: owner.userId, agencyId: owner.agencyId, requestId: newId(), locale: 'en' }, fn);

beforeAll(async () => {
  await setupTestDb('worker');
  owner = await createFounder();
  await setAgencyStatus(owner.agencyId, 'VERIFIED');
  ids = await withSystem('perf.developments.taxonomy', async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('pd'),
      translations: tr(`Devperf ${RUN}`, 'devperf'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('pd-flats'),
      sort: 0,
      translations: tr(`Flats ${RUN}`, 'pd-flats'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('pd-apartment'),
      sort: 0,
      translations: tr(`Apartment ${RUN}`, 'pd-apartment'),
    });
    return { location, type };
  });
}, 120_000);

afterAll(closeDb);

it('[S5-F3] approving a 2,000-unit price list stays within the dashboard budget', async () => {
  const dev = await as((ctx) =>
    developments.createDevelopment(
      ctx,
      CreateDevelopmentBody.parse({
        ref: code('D1'),
        name: 'Marbella Heights',
        locationId: ids.location,
        commission: { type: 'PCT', basisPoints: 500, includesVat: false },
      }),
    ),
  );
  const ref = (i: number) => `R${String(i).padStart(4, '0')}`;
  for (let b = 0; b < 4; b++) {
    const units = Array.from({ length: 500 }, (_, i) => ({
      ref: ref(b * 500 + i),
      propertyTypeId: ids.type,
      bedrooms: 2,
      priceCents: 20_000_000,
    }));
    await as((ctx) => developments.createUnits(ctx, dev.id, CreateUnitsBody.parse({ units })));
  }
  const list = await as((ctx) =>
    developments.createPriceList(
      ctx,
      dev.id,
      CreatePriceListBody.parse({
        effectiveFrom: '2026-11-01',
        entries: Array.from({ length: 2_000 }, (_, i) => ({
          ref: ref(i),
          priceCents: 21_000_000 + i,
          ...(i % 2 === 0 ? { status: 'RESERVED' as const } : {}),
        })),
      }),
    ),
  );
  const started = performance.now();
  const approved = await as((ctx) => developments.approvePriceList(ctx, dev.id, list.version));
  const ms = performance.now() - started;
  console.info(`[S5-F3] approving a 2,000-unit price list: ${ms.toFixed(0)} ms`);
  expect(approved.diff.changed).toHaveLength(2_000);
  expect(ms).toBeLessThan(2_000);
});
