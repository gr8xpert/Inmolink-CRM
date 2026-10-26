import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Fixture legacy databases (tests): the legacy adapter refuses any login that is not a plain SELECT-only role
 * (S15-F4), so a fixture is read through a dedicated role like the real H1 access will be.
 */
export interface FixtureReader {
  /** Connection string of the SELECT-only role on `database`. */
  url: string;
  role: string;
  /** Drops the role: call after the fixture database is dropped. */
  drop(): Promise<void>;
}

/** Creates a SELECT-only login on every table that exists now in `database`'s public schema. */
export async function createFixtureReader(adminUrl: string, database: string): Promise<FixtureReader> {
  const role = `legacy_reader_${process.pid}_${randomBytes(3).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  const withAdmin = async (url: string, fn: (c: pg.Client) => Promise<void>) => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await fn(c);
    } finally {
      await c.end();
    }
  };
  const ident = pg.escapeIdentifier(role);
  await withAdmin(adminUrl, async (c) => {
    await c.query(
      `CREATE ROLE ${ident} LOGIN PASSWORD ${pg.escapeLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    await c.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(database)} TO ${ident}`);
    await c.query(`GRANT USAGE ON SCHEMA public TO ${ident}`);
    await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ident}`);
  });
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  return {
    url: u.toString(),
    role,
    async drop() {
      const base = new URL(adminUrl);
      base.pathname = '/postgres';
      await withAdmin(base.toString(), async (c) => {
        await c.query(`DROP ROLE IF EXISTS ${ident}`);
      });
    },
  };
}
