import { withSystem, withSystemClient } from '@inmolink/db';
import { staffUsers, users } from '@inmolink/db/schema/identity';
import { DEFAULT_UI_LOCALE, UI_LOCALES } from '@inmolink/i18n';
import { hashPassword } from '@inmolink/platform/crypto/password';
import { sql } from 'drizzle-orm';
import { agenciesPerChunk, type CopyValue, copyNewRows, forEachChunk } from './copy';
import { PER_AGENCY } from './profile';
import { createRng, seededId } from './rng';
import type { Login, Seeder } from './seeders';

/**
 * Login identities (S0-09 `users`). The agencies seeder (S1-01, runs next) adds each user's agency and
 * membership for these same deterministic IDs.
 */
export const DEMO_DOMAIN = 'demo.inmolink.test';
export const DEMO_AGENCIES = ['Costa Homes', 'Sierra Nevada Realty', 'Marbella Prime', 'Levante Estates', 'Nova Obra'];
export const DEMO_ROLES = ['admin', 'agent1', 'agent2', 'agent3', 'assistant'] as const;
export const DEV_SEED = 0;
/** Dev staff login (S1-03): no agency, `STAFF_SUPPORT` — opens the verification queue. */
export const DEMO_STAFF_EMAIL = 'support@staff.inmolink.test';

/** Fixed timestamps keep re-runs and different machines byte-identical. */
export const SEEDED_AT = new Date(Date.UTC(2026, 0, 1));

const FIRST = ['Lucía', 'Hugo', 'Martina', 'Mateo', 'Sofía', 'Leo', 'Emma', 'Daniel', 'Julia', 'Pablo', 'Anna', 'Lars'];
const LAST = ['García', 'Martínez', 'López', 'Sánchez', 'Romero', 'Navarro', 'Smith', 'de Vries', 'Johansson'];

const slug = (name: string) => name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-');

export function demoEmail(agencyIndex: number, role: string): string {
  return `${role}@${slug(DEMO_AGENCIES[agencyIndex] ?? `agency-${agencyIndex}`)}.${DEMO_DOMAIN}`;
}

export function demoUserName(agencyIndex: number, role: (typeof DEMO_ROLES)[number]): string {
  const label = role === 'admin' ? 'Admin' : role === 'assistant' ? 'Assistant' : `Agent ${role.slice(-1)}`;
  return `${label} · ${DEMO_AGENCIES[agencyIndex] ?? `Agency ${agencyIndex}`}`;
}

/**
 * Name and locale of each synthetic user of agency `a`. One RNG per agency, so the output depends on
 * neither the chunk size nor the caller: the agencies seeder copies the names into `agency_members`.
 */
export function scaleUserProfiles(seed: number, a: number): { name: string; locale: string }[] {
  const rng = createRng(seed, `identity.users:${a}`);
  return Array.from({ length: PER_AGENCY.users }, () => ({
    name: `${rng.pick(FIRST)} ${rng.pick(LAST)}`,
    locale: rng.pick(UI_LOCALES),
  }));
}

/** `a<agency>-u<user>@s<seed>.scale.inmolink.test`: the seed is in the domain, so two seeds never collide. */
export function scaleEmail(seed: number, agency: number, user: number): string {
  return `a${agency}-u${user}@s${seed}.scale.inmolink.test`;
}

async function countLike(pattern: string): Promise<number> {
  const rows = await withSystem('seed.identity.users.count', (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from ${users} where ${users.email} like ${pattern}`),
  );
  return rows.rows[0]?.n ?? 0;
}

export const identityUsers: Seeder = {
  name: 'identity.users',

  async dev({ demoPassword }) {
    const passwordHash = await hashPassword(demoPassword);
    const logins: Login[] = [];
    const values = DEMO_AGENCIES.flatMap((agency, a) =>
      DEMO_ROLES.map((role, r) => {
        const email = demoEmail(a, role);
        logins.push({ agency, role, email });
        return {
          id: seededId(DEV_SEED, 'identity.users.dev', a * DEMO_ROLES.length + r),
          email,
          passwordHash,
          name: demoUserName(a, role),
          locale: UI_LOCALES[a % UI_LOCALES.length] ?? DEFAULT_UI_LOCALE,
          emailVerifiedAt: SEEDED_AT,
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
        };
      }),
    );
    // `do nothing`: a re-run writes nothing. To reset a changed demo password, delete the user and re-seed.
    const inserted = await withSystem('seed.identity.users.dev', (tx) =>
      tx.insert(users).values(values).onConflictDoNothing({ target: users.email }).returning({ id: users.id }),
    );
    // A staff member has no agency: the agencies seeder never sees this user.
    const staffId = seededId(DEV_SEED, 'identity.users.dev.staff', 0);
    await withSystem('seed.identity.staff.dev', async (tx) => {
      await tx
        .insert(users)
        .values({
          id: staffId,
          email: DEMO_STAFF_EMAIL,
          passwordHash,
          name: 'Inmolink Support',
          locale: DEFAULT_UI_LOCALE,
          emailVerifiedAt: SEEDED_AT,
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
        })
        .onConflictDoNothing({ target: users.email });
      await tx.insert(staffUsers).values({ userId: staffId, role: 'STAFF_SUPPORT' }).onConflictDoNothing();
    });
    logins.push({ agency: 'Inmolink staff', role: 'staff', email: DEMO_STAFF_EMAIL });
    return { inserted: inserted.length, total: await countLike(`%.${DEMO_DOMAIN}`), logins };
  },

  async scale({ agencies, seed, chunk, scalePassword, onProgress }) {
    // One hash for every synthetic user: 25k Argon2 runs would take minutes and prove nothing.
    const passwordHash = await hashPassword(scalePassword);
    const columns = [
      'id',
      'email',
      'password_hash',
      'name',
      'locale',
      'status',
      'email_verified_at',
      'session_version',
      'created_at',
      'updated_at',
    ];
    const write = async (start: number, end: number) => {
      const rows: CopyValue[][] = [];
      for (let a = start; a < end; a++) {
        scaleUserProfiles(seed, a).forEach(({ name, locale }, u) => {
          rows.push([
            // Index within the agency: changing the users ratio never shifts existing IDs.
            seededId(seed, `identity.users:${a}`, u),
            scaleEmail(seed, a, u),
            passwordHash,
            name,
            locale,
            'ACTIVE',
            SEEDED_AT,
            1,
            SEEDED_AT,
            SEEDED_AT,
          ]);
        });
      }
      return withSystemClient('seed.identity.users.scale', (client) => copyNewRows(client, 'users', columns, rows));
    };
    const step = agenciesPerChunk(chunk, PER_AGENCY.users);
    const inserted = await forEachChunk(agencies, step, write, onProgress);
    return { inserted, total: await countLike(`%@s${seed}.scale.inmolink.test`) };
  },
};
