import { randomBytes, randomUUID } from 'node:crypto';
import { cache, closeCache, configureCache } from '@inmolink/platform/cache';
import { hashPassword } from '@inmolink/platform/crypto/password';
import pg from 'pg';
import { testStackEnv } from './stack';

/** Every seeded login shares one password; the tests read it from here. */
export const SEED_PASSWORD = 'correct horse battery';

/** Rows written as the database owner: no sign-up flow, no emails. Names carry a random tag, so runs never collide. */
async function asOwner<T>(work: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: testStackEnv().DATABASE_URL_ADMIN });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

const INSERT_USER = `insert into users (id, email, password_hash, name, locale, email_verified_at) values ($1, $2, $3, $4, 'en', now())`;

/** A staff login (support unless told otherwise). Staff owe a second factor: `passTwoFactor` enrols them. */
export async function seedStaff(
  role: 'SUPER_ADMIN' | 'STAFF_SUPPORT' | 'STAFF_DATA_OPS' = 'STAFF_SUPPORT',
): Promise<string> {
  const email = `staff-${randomBytes(4).toString('hex')}@staff.inmolink.test`;
  await asOwner(async (admin) => {
    const id = randomUUID();
    await admin.query(INSERT_USER, [id, email, await hashPassword(SEED_PASSWORD), 'Support']);
    await admin.query(`insert into staff_users (user_id, role) values ($1, $2)`, [id, role]);
  });
  return email;
}

/**
 * A pending agency (the status every new agency starts with) with one agent. An AGENT owes no second
 * factor, so a test is signed in after one form.
 */
export async function seedAgent(): Promise<{ email: string; company: string; agencyId: string }> {
  const tag = randomBytes(4).toString('hex');
  const email = `agent-${tag}@example.com`;
  const company = `Agency ${tag} S.L.`;
  return asOwner(async (admin) => {
    const [userId, agencyId] = [randomUUID(), randomUUID()];
    await admin.query(INSERT_USER, [userId, email, await hashPassword(SEED_PASSWORD), 'Marta']);
    await admin.query(`insert into agencies (agency_id, kind, name) values ($1, 'AGENCY', $2)`, [agencyId, company]);
    await admin.query(`insert into agency_settings (agency_id, enabled_locales) values ($1, '{en}')`, [agencyId]);
    await admin.query(
      `insert into agency_members (agency_id, user_id, role, name, email) values ($1, $2, 'AGENT', 'Marta', $3)`,
      [agencyId, userId, email],
    );
    return { email, company, agencyId };
  });
}

/**
 * The small taxonomy the listing flows list in (S3-05): a country, a property type and a feature. Fixed ids
 * and names: `prepare.ts` writes it once per run, before the servers start, so no process holds a taxonomy
 * copy from before it. Written later, the api would keep serving its in-process copy for up to 60 s (the
 * cache's design for other processes), and a select would wait for an option that never comes.
 */
export const LISTING_TAXONOMY = { location: 'E2E Listland', propertyType: 'E2E Villa', feature: 'E2E Pool' } as const;

export const TAXONOMY_IDS = {
  location: 'e2e00000-0000-4000-8000-000000000001',
  typeGroup: 'e2e00000-0000-4000-8000-000000000002',
  type: 'e2e00000-0000-4000-8000-000000000003',
  featureGroup: 'e2e00000-0000-4000-8000-000000000004',
  feature: 'e2e00000-0000-4000-8000-000000000005',
} as const;

/** Writes `LISTING_TAXONOMY` (idempotent: the local test database outlives runs) and invalidates the cache. */
export async function seedListingTaxonomy(): Promise<void> {
  const ids = TAXONOMY_IDS;
  const names = LISTING_TAXONOMY;
  await asOwner(async (admin) => {
    const insert = (sql: string, params: unknown[]) => admin.query(`${sql} on conflict do nothing`, params);
    // A rename here must reach a database seeded by an earlier run: translations take the current name.
    const translate = (table: string, owner: string, id: string, name: string, slug: string, parent = '') =>
      admin.query(
        `insert into ${table} (${owner}, ${parent ? 'parent_id, ' : ''}locale, name, slug)
         values ($1, ${parent ? 'null, ' : ''}'en', $2, $3)
         on conflict (${owner}, locale) do update set name = excluded.name, slug = excluded.slug`,
        [id, name, slug],
      );
    await insert(
      `insert into locations (id, parent_id, level, depth, code) values ($1, null, 'COUNTRY', 1, 'e2e-listland')`,
      [ids.location],
    );
    await translate('location_translations', 'location_id', ids.location, names.location, 'e2e-listland', 'root');
    await insert(`insert into property_type_groups (id, key) values ($1, 'e2e-houses')`, [ids.typeGroup]);
    await translate('property_type_group_translations', 'group_id', ids.typeGroup, 'E2E Houses', 'e2e-houses');
    await insert(`insert into property_types (id, group_id, key) values ($1, $2, 'e2e-villa')`, [
      ids.type,
      ids.typeGroup,
    ]);
    await translate('property_type_translations', 'type_id', ids.type, names.propertyType, 'e2e-villa');
    await insert(`insert into feature_groups (id, key) values ($1, 'e2e-outdoor')`, [ids.featureGroup]);
    await translate('feature_group_translations', 'group_id', ids.featureGroup, 'E2E Outdoor', 'e2e-outdoor');
    await insert(`insert into features (id, group_id, key, icon) values ($1, $2, 'e2e-pool', 'waves')`, [
      ids.feature,
      ids.featureGroup,
    ]);
    await translate('feature_translations', 'feature_id', ids.feature, names.feature, 'e2e-pool');
  });
  // Redis outlives runs locally: drop the shared copies from before the rows existed.
  await configureCache({ url: testStackEnv().REDIS_CACHE_URL });
  try {
    await cache.invalidateTag('taxonomy');
  } finally {
    await closeCache();
  }
}

/** A verified agency (it may share listings) with one agent, and the names of `LISTING_TAXONOMY` to list in. */
export async function seedListingAgent(): Promise<{
  email: string;
  agencyId: string;
  location: string;
  propertyType: string;
  feature: string;
}> {
  const agent = await seedAgent();
  await asOwner((admin) =>
    admin.query(`update agencies set status = 'VERIFIED' where agency_id = $1`, [agent.agencyId]),
  );
  return { email: agent.email, agencyId: agent.agencyId, ...LISTING_TAXONOMY };
}

/**
 * A verified agency with its admin (S6-04): admins set up feed imports. An admin owes a second factor, so a test
 * signs in with `passTwoFactor` (enrolment the first time). Uses the names of `LISTING_TAXONOMY`.
 */
export async function seedImportAdmin(): Promise<{ email: string; agencyId: string; company: string }> {
  const tag = randomBytes(4).toString('hex');
  const email = `admin-${tag}@example.com`;
  const company = `Importers ${tag} S.L.`;
  return asOwner(async (admin) => {
    const [userId, agencyId] = [randomUUID(), randomUUID()];
    await admin.query(INSERT_USER, [userId, email, await hashPassword(SEED_PASSWORD), 'Elena']);
    await admin.query(`insert into agencies (agency_id, kind, name, status) values ($1, 'AGENCY', $2, 'VERIFIED')`, [
      agencyId,
      company,
    ]);
    await admin.query(`insert into agency_settings (agency_id, enabled_locales) values ($1, '{en}')`, [agencyId]);
    await admin.query(
      `insert into agency_members (agency_id, user_id, role, name, email) values ($1, $2, 'AGENCY_ADMIN', 'Elena', $3)`,
      [agencyId, userId, email],
    );
    return { email, agencyId, company };
  });
}
