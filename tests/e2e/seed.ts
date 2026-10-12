import { randomBytes, randomUUID } from 'node:crypto';
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
