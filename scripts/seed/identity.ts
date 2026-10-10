import { withSystem, withSystemClient } from '@inmolink/db';
import { users } from '@inmolink/db/schema/identity';
import { DEFAULT_UI_LOCALE, UI_LOCALES } from '@inmolink/i18n';
import { hashPassword } from '@inmolink/platform/crypto/password';
import { sql } from 'drizzle-orm';
import { type CopyValue, copyNewRows } from './copy';
import { PER_AGENCY } from './profile';
import { createRng, seededId } from './rng';
import type { Login, Seeder } from './seeders';

/**
 * Login identities (S0-09 `users`). Until agencies land (S1-01) a user carries its agency only in
 * its email domain; S1-01's seeder adds the agencies and memberships for these same deterministic IDs.
 */
export const DEMO_DOMAIN = 'demo.inmolink.test';
export const DEMO_AGENCIES = ['Costa Homes', 'Sierra Nevada Realty', 'Marbella Prime', 'Levante Estates', 'Nova Obra'];
const DEMO_ROLES = ['admin', 'agent1', 'agent2', 'agent3', 'assistant'] as const;
const DEV_SEED = 0;

/** Fixed timestamps keep re-runs and different machines byte-identical. */
const SEEDED_AT = new Date(Date.UTC(2026, 0, 1));

const FIRST = ['Lucía', 'Hugo', 'Martina', 'Mateo', 'Sofía', 'Leo', 'Emma', 'Daniel', 'Julia', 'Pablo', 'Anna', 'Lars'];
const LAST = ['García', 'Martínez', 'López', 'Sánchez', 'Romero', 'Navarro', 'Smith', 'de Vries', 'Johansson'];

const slug = (name: string) => name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-');

export function demoEmail(agencyIndex: number, role: string): string {
  return `${role}@${slug(DEMO_AGENCIES[agencyIndex] ?? `agency-${agencyIndex}`)}.${DEMO_DOMAIN}`;
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
          name: `${role === 'admin' ? 'Admin' : role === 'assistant' ? 'Assistant' : `Agent ${role.slice(-1)}`} · ${agency}`,
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
    let inserted = 0;
    for (let start = 0; start < agencies; start += chunk) {
      const end = Math.min(agencies, start + chunk);
      const rows: CopyValue[][] = [];
      for (let a = start; a < end; a++) {
        // One RNG per agency: output does not depend on the chunk size.
        const rng = createRng(seed, `identity.users:${a}`);
        for (let u = 0; u < PER_AGENCY.users; u++) {
          rows.push([
            // Index within the agency: changing the users ratio never shifts existing IDs.
            seededId(seed, `identity.users:${a}`, u),
            scaleEmail(seed, a, u),
            passwordHash,
            `${rng.pick(FIRST)} ${rng.pick(LAST)}`,
            rng.pick(UI_LOCALES),
            'ACTIVE',
            SEEDED_AT,
            1,
            SEEDED_AT,
            SEEDED_AT,
          ]);
        }
      }
      inserted += await withSystemClient('seed.identity.users.scale', (client) =>
        copyNewRows(client, 'users', columns, rows),
      );
      onProgress?.(end, agencies);
    }
    return { inserted, total: await countLike(`%@s${seed}.scale.inmolink.test`) };
  },
};
