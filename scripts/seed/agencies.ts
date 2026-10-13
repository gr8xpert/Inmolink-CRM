import { parseSpanishTaxId, type SPANISH_REGIONS } from '@inmolink/contracts';
import { withSystem, withSystemClient } from '@inmolink/db';
import { CONTENT_LOCALES, DEFAULT_CONTENT_LOCALE } from '@inmolink/i18n';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { agenciesPerChunk, type CopyValue, copyNewRows, forEachChunk } from './copy';
import {
  DEMO_AGENCIES,
  DEMO_ROLES,
  DEV_SEED,
  demoEmail,
  demoUserName,
  SEEDED_AT,
  scaleEmail,
  scaleUserProfiles,
} from './identity';
import { PER_AGENCY } from './profile';
import { createRng, type Rng, seededId } from './rng';
import type { Seeder } from './seeders';

/**
 * Agencies, their settings and memberships (S1-01) for the users the identity seeder created (same
 * deterministic IDs: user `u` of agency `a`; user 0 is the admin). Runs after `identity.users`.
 */

const AGENCY_COLUMNS = [
  'agency_id',
  'kind',
  'status',
  'name',
  'tax_id',
  'address_line',
  'city',
  'postal_code',
  'region',
  'languages',
  'onboarded_at',
  'created_at',
  'updated_at',
];
/** S1-06: seeded agencies share 3 % (300 bp, VAT excluded) as their default commission; other settings keep the column defaults. */
const SETTINGS_COLUMNS = [
  'agency_id',
  'enabled_locales',
  'default_commission_type',
  'default_commission_bp',
  'updated_at',
];
const SEED_COMMISSION_BP = 300;
const MEMBER_COLUMNS = ['user_id', 'agency_id', 'role', 'name', 'email', 'created_at', 'updated_at'];

const CITIES: readonly [string, string, (typeof SPANISH_REGIONS)[number]][] = [
  ['Marbella', '29601', 'ES-AN'],
  ['Málaga', '29001', 'ES-AN'],
  ['Alicante', '03001', 'ES-VC'],
  ['Valencia', '46001', 'ES-VC'],
  ['Barcelona', '08001', 'ES-CT'],
  ['Madrid', '28001', 'ES-MD'],
  ['Palma', '07001', 'ES-IB'],
  ['Santa Cruz de Tenerife', '38001', 'ES-CN'],
];

/** A valid company CIF (`B` + 7 digits + control digit) for agency `n`. */
export function seedCif(n: number): string {
  const digits = String(n % 10_000_000).padStart(7, '0');
  for (let c = 0; c <= 9; c++) {
    const parsed = parseSpanishTaxId(`B${digits}${c}`);
    if (parsed.ok) return parsed.value;
  }
  throw new Error(`no CIF control digit for ${digits}`);
}

const pgArray = (values: readonly string[]) => `{${values.join(',')}}`;

function agencyRow(
  id: string,
  a: number,
  name: string,
  kind: 'AGENCY' | 'DEVELOPER',
  status: 'PENDING' | 'VERIFIED',
  rng: Rng,
): CopyValue[] {
  const [city, postalCode, region] = rng.pick(CITIES);
  const languages = [DEFAULT_CONTENT_LOCALE, ...CONTENT_LOCALES.filter(() => rng.next() < 0.3)];
  return [
    id,
    kind,
    status,
    name,
    seedCif(a + 1),
    `Calle Mayor ${rng.int(1, 200)}`,
    city,
    postalCode,
    region,
    pgArray([...new Set(languages)]),
    SEEDED_AT,
    SEEDED_AT,
    SEEDED_AT,
  ];
}

async function writeRows(
  client: pg.PoolClient,
  agencies: CopyValue[][],
  members: CopyValue[][],
): Promise<{ agencies: number }> {
  const inserted = await copyNewRows(client, 'agencies', AGENCY_COLUMNS, agencies);
  await copyNewRows(
    client,
    'agency_settings',
    SETTINGS_COLUMNS,
    agencies.map((r) => [r[0] as string, r[9] as string, 'PCT', SEED_COMMISSION_BP, SEEDED_AT]),
  );
  await copyNewRows(client, 'agency_members', MEMBER_COLUMNS, members);
  return { agencies: inserted };
}

async function countAgencies(ids: string[]): Promise<number> {
  const r = await withSystem('seed.agencies.count', (tx) =>
    tx.execute<{ n: number }>(
      sql`select count(*)::int as n from agencies where agency_id = any(${pgArray(ids)}::uuid[])`,
    ),
  );
  return r.rows[0]?.n ?? 0;
}

export const agenciesSeeder: Seeder = {
  name: 'agencies.agencies',

  async dev() {
    const agencies: CopyValue[][] = [];
    const members: CopyValue[][] = [];
    const ids: string[] = [];
    DEMO_AGENCIES.forEach((name, a) => {
      const id = seededId(DEV_SEED, 'agencies.dev', a);
      ids.push(id);
      // "Nova Obra" is a developer; "Levante Estates" is still waiting for verification.
      const kind = name === 'Nova Obra' ? 'DEVELOPER' : 'AGENCY';
      const status = name === 'Levante Estates' ? 'PENDING' : 'VERIFIED';
      agencies.push(agencyRow(id, a, name, kind, status, createRng(DEV_SEED, `agencies.dev:${a}`)));
      DEMO_ROLES.forEach((demoRole, r) => {
        const admin = r === 0;
        const role =
          kind === 'DEVELOPER' ? (admin ? 'DEVELOPER_ADMIN' : 'DEVELOPER_AGENT') : admin ? 'AGENCY_ADMIN' : 'AGENT';
        const userId = seededId(DEV_SEED, 'identity.users.dev', a * DEMO_ROLES.length + r);
        members.push([userId, id, role, demoUserName(a, demoRole), demoEmail(a, demoRole), SEEDED_AT, SEEDED_AT]);
      });
    });
    const { agencies: inserted } = await withSystemClient('seed.agencies.dev', (client) =>
      writeRows(client, agencies, members),
    );
    return { inserted, total: await countAgencies(ids) };
  },

  async scale({ agencies: count, seed, chunk, onProgress }) {
    const ids = Array.from({ length: count }, (_, a) => seededId(seed, 'agencies', a));
    const write = async (start: number, end: number) => {
      const agencies: CopyValue[][] = [];
      const members: CopyValue[][] = [];
      for (let a = start; a < end; a++) {
        const rng = createRng(seed, `agencies:${a}`);
        const id = ids[a] as string;
        const kind = rng.next() < 0.05 ? 'DEVELOPER' : 'AGENCY';
        const status = rng.next() < 0.9 ? 'VERIFIED' : 'PENDING';
        agencies.push(agencyRow(id, a, `Agency ${a}`, kind, status, rng));
        scaleUserProfiles(seed, a).forEach(({ name: userName }, u) => {
          const admin = u === 0;
          const role =
            kind === 'DEVELOPER' ? (admin ? 'DEVELOPER_ADMIN' : 'DEVELOPER_AGENT') : admin ? 'AGENCY_ADMIN' : 'AGENT';
          const userId = seededId(seed, `identity.users:${a}`, u);
          members.push([userId, id, role, userName, scaleEmail(seed, a, u), SEEDED_AT, SEEDED_AT]);
        });
      }
      const res = await withSystemClient('seed.agencies.scale', (client) => writeRows(client, agencies, members));
      return res.agencies;
    };
    // One agency row plus its members per agency.
    const step = agenciesPerChunk(chunk, 1 + PER_AGENCY.users);
    const inserted = await forEachChunk(count, step, write, onProgress);
    return { inserted, total: await countAgencies(ids) };
  },
};
