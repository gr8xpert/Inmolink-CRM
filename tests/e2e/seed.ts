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
 * A verified agency (it may share listings) with one agent, and a small taxonomy to list in: a country, a
 * property type and a feature, named with a random tag (S3-05). The taxonomy cache is invalidated so the API
 * serves the new rows at once.
 */
export async function seedListingAgent(): Promise<{
  email: string;
  agencyId: string;
  location: string;
  propertyType: string;
  feature: string;
}> {
  const tag = randomBytes(4).toString('hex');
  const agent = await seedAgent();
  const names = { location: `Listland ${tag}`, propertyType: `Villa ${tag}`, feature: `Pool ${tag}` };
  await asOwner(async (admin) => {
    await admin.query(`update agencies set status = 'VERIFIED' where agency_id = $1`, [agent.agencyId]);
    const [location, typeGroup, type, featureGroup, feature] = Array.from({ length: 5 }, () => randomUUID());
    await admin.query(`insert into locations (id, parent_id, level, depth, code) values ($1, null, 'COUNTRY', 1, $2)`, [
      location,
      `e2e-${tag}`,
    ]);
    await admin.query(
      `insert into location_translations (location_id, parent_id, locale, name, slug) values ($1, null, 'en', $2, $3)`,
      [location, names.location, `listland-${tag}`],
    );
    await admin.query(`insert into property_type_groups (id, key) values ($1, $2)`, [typeGroup, `e2e-houses-${tag}`]);
    await admin.query(
      `insert into property_type_group_translations (group_id, locale, name, slug) values ($1, 'en', $2, $3)`,
      [typeGroup, `Houses ${tag}`, `houses-${tag}`],
    );
    await admin.query(`insert into property_types (id, group_id, key) values ($1, $2, $3)`, [
      type,
      typeGroup,
      `e2e-villa-${tag}`,
    ]);
    await admin.query(
      `insert into property_type_translations (type_id, locale, name, slug) values ($1, 'en', $2, $3)`,
      [type, names.propertyType, `villa-${tag}`],
    );
    await admin.query(`insert into feature_groups (id, key) values ($1, $2)`, [featureGroup, `e2e-outdoor-${tag}`]);
    await admin.query(
      `insert into feature_group_translations (group_id, locale, name, slug) values ($1, 'en', $2, $3)`,
      [featureGroup, `Outdoor ${tag}`, `outdoor-${tag}`],
    );
    await admin.query(`insert into features (id, group_id, key, icon) values ($1, $2, $3, 'waves')`, [
      feature,
      featureGroup,
      `e2e-pool-${tag}`,
    ]);
    await admin.query(`insert into feature_translations (feature_id, locale, name, slug) values ($1, 'en', $2, $3)`, [
      feature,
      names.feature,
      `pool-${tag}`,
    ]);
  });
  await configureCache({ url: testStackEnv().REDIS_CACHE_URL });
  try {
    await cache.invalidateTag('taxonomy');
  } finally {
    await closeCache();
  }
  return { email: agent.email, agencyId: agent.agencyId, ...names };
}
