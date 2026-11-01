import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as migration from '@inmolink/core/modules/migration';
import * as search from '@inmolink/core/modules/search';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { countQueries } from '@inmolink/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FeedApp, type Fixture, loadWorld, startWorld, stopWorld, type World } from './world';

/**
 * S16-F9 (security review M-4, decision pending): the v1 shim on a site that shows network listings. Agency A (an
 * OWN_ONLY site) shares its listings with everyone; agency B's OWN_PLUS_NETWORK site shows them beside its own. Off
 * (the default), the frozen legacy output: a network listing carries its owner's legacy id. On
 * (`legacyV1HideNetworkOwner`), no network item names its owner, and A's legacy ids on B's site are the same 404 as a
 * legacy id of a listing a site does not show. The golden files are replayed with the flag off
 * (`legacy-v1.golden.int.test.ts`, unchanged).
 */

const synthetic = JSON.parse(readFileSync(join(import.meta.dirname, 'synthetic', 'fixture.json'), 'utf8')) as Fixture;

/** The fixture under its own target ids, public codes and legacy property ids (the taxonomy maps: A's load only). */
function copyOf(f: Fixture, space: string, codeLetter: string, legacyPrefix: string, taxonomy = false): Fixture {
  const text = JSON.stringify(f)
    .replaceAll('0195f0a5-0801-', `0195f0a5-${space}-`)
    .replaceAll('"G00000', `"${codeLetter}00000`)
    .replaceAll('"9100', `"${legacyPrefix}`);
  const copy = JSON.parse(text) as Fixture;
  return taxonomy ? { ...copy, legacyIds: f.legacyIds } : { ...copy, legacyIds: [] };
}

const settings = { mediaBaseUrl: 'https://media.example', cursorKey: 'test-cursor-key-0123456789abcdef0123' };
const hideOwners = (on: boolean) => websiteApi.configureWebsiteApi({ ...settings, legacyV1HideNetworkOwner: on });

let app: FeedApp;
let a: World;
let b: World;
const aLegacy = ['930001', '930002', '930004'];
const bLegacy = ['940001', '940002', '940004'];

beforeAll(async () => {
  app = await startWorld('legacy-v1-net');
  search.configureNetworkSearch({ giveToGetMinShared: 0, giveToGetGraceDays: 0 });
  a = await loadWorld(copyOf(synthetic, '0821', 'J', '9300', true));
  b = await loadWorld(copyOf(synthetic, '0831', 'K', '9400'), { inventoryPolicy: 'OWN_PLUS_NETWORK' });
  migration.resetLegacyIdCache();
}, 180_000);

afterEach(() => {
  hideOwners(false);
  websiteApi.resetWebsiteApiCaches();
  migration.resetLegacyIdCache();
});

afterAll(async () => {
  search.configureNetworkSearch({});
  await stopWorld(app);
});

const get = (url: string, key: string) =>
  app.inject({ method: 'GET', url: `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}` });
type Item = { id: string; ref: string };
/**
 * The fixture's listings by their location (`gl-0`, every one of them; the shared test database holds other suites'
 * network listings too): on B's site its own (references `GH-…`) and A's (`GS-J…`).
 */
const listOf = async (key: string) =>
  ((await get('/v1/properties?location=gl-0&limit=50', key)).json() as { properties: Item[] }).properties;
const ownOf = (items: Item[]) => items.filter((p) => p.ref.startsWith('GH-'));
const fromA = (items: Item[]) => items.filter((p) => p.ref.startsWith('GS-J'));

describe('[S16-F9] legacy /v1 hides network owners (flag)', () => {
  it('[S16-F9] flag off (default): the frozen output — a network item carries its owner legacy id, which resolves', async () => {
    const items = await listOf(b.key);
    // B's own four and A's four (shared with everyone).
    expect(ownOf(items)).toHaveLength(4);
    expect(fromA(items)).toHaveLength(4);
    const ids = items.map((p) => p.id);
    for (const id of [...aLegacy, ...bLegacy]) expect(ids).toContain(id);
    const owner = await get('/v1/properties/930001', b.key);
    expect(owner.statusCode).toBe(200);
    expect((owner.json() as { property: Item }).property.id).toBe('930001');
  });

  it('[S16-F9] flag on: no network item on /v1 names its owner; own items keep their legacy ids', async () => {
    hideOwners(true);
    const items = await listOf(b.key);
    expect(ownOf(items)).toHaveLength(4);
    const ids = items.map((p) => p.id);
    for (const id of aLegacy) expect(ids).not.toContain(id);
    for (const id of bLegacy) expect(ids).toContain(id);
    // Every network item (A's and any other agency's) is named by the site's reference, never a legacy id.
    for (const p of items.filter((x) => !x.ref.startsWith('GH-'))) expect(p.id).toBe(p.ref);
    // That reference opens it on this site, and names no owner either.
    const network = fromA(items);
    expect(network).toHaveLength(4);
    for (const p of network) {
      const detail = await get(`/v1/properties/${p.id}`, b.key);
      expect(detail.statusCode).toBe(200);
      const shown = (detail.json() as { property: Item }).property;
      expect(shown.id).toBe(p.ref);
      expect(aLegacy).not.toContain(shown.id);
    }
    // A's own site is unchanged: its listings are its own.
    expect((await listOf(a.key)).map((p) => p.id)).toEqual(expect.arrayContaining(aLegacy));
    expect((await get('/v1/properties/930001', a.key)).statusCode).toBe(200);
  });

  it('[S16-F9] flag on: an owner legacy id on another agency site is refused like an unknown one (no oracle)', async () => {
    hideOwners(true);
    const unknown = await get('/v1/properties/949999', b.key);
    expect(unknown.statusCode).toBe(404);
    for (const id of aLegacy) {
      const owner = await get(`/v1/properties/${id}`, b.key);
      expect(owner.statusCode, id).toBe(404);
      expect(owner.body, id).toBe(unknown.body);
      expect(owner.headers['cache-control'], id).toBe(unknown.headers['cache-control']);
    }
    // Whether B shows A's listing changes nothing: A's id on B's site costs the same statements, warm and cold, as B's
    // id on A's OWN_ONLY site (a listing that site does not show), within the feed-api budget.
    for (const cold of [false, true]) {
      if (!cold) {
        await get('/v1/properties/930002', b.key);
        await get('/v1/properties/940002', a.key);
      }
      const reset = () => {
        if (cold) migration.resetLegacyIdCache();
      };
      reset();
      const network = await countQueries(() => get('/v1/properties/930002', b.key));
      reset();
      const notShown = await countQueries(() => get('/v1/properties/940002', a.key));
      expect(network, `cold=${cold}`).toBe(notShown);
      expect(network, `cold=${cold}`).toBeLessThanOrEqual(3);
    }
  });
});
