import { randomInt } from 'node:crypto';
import type { RegisterInput } from '@inmolink/contracts';
import { UpdateAgencyDetailsBody } from '@inmolink/contracts';
import { closeDb, getPgClient, type Tx, withAuth, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newToken } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import {
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from '@inmolink/platform/jwt';
import { getTableName, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthCtx, authCtx } from '../../../context';
import { withMemberCtx } from '../../../member';
import * as identity from '../../identity';
import * as agencies from '../index';

/** Sign-up → agency-of-one → onboarding, on the real test database (S1-01). */

const pair = generateAccessKeyPair();
const verifier = createAccessTokenVerifier({ publicKeys: parsePublicKeys(`t1:${pair.publicKey}`) });
const ctx = () => authCtx(newId());
/** Staff-side writes and reads (app_system: BYPASSRLS, allowed by the guard triggers). */
let admin: Awaited<ReturnType<typeof getPgClient>>;

beforeAll(async () => {
  await setupTestDb('worker');
  admin = await getPgClient('app_system');
  identity.configureIdentity({
    hmacKey: 'test-hmac-key-0123456789abcdef0123456789',
    webUrl: 'http://web.test',
    signer: createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' }),
  });
}, 120_000); // setupTestDb under a full parallel verify (S1-F1)

afterAll(async () => {
  admin?.release();
  await closeDb();
});

const signup = (over: Partial<RegisterInput> = {}): RegisterInput => ({
  email: `founder-${newToken(6).toLowerCase()}@example.com`,
  password: 'correct horse battery',
  name: 'Ana',
  locale: 'es',
  accountKind: 'AGENCY',
  companyName: 'Costa Homes S.L.',
  ...over,
});

interface Founded {
  userId: string;
  agencyId: string;
  role: string;
  kind: string;
  status: string;
  name: string;
  enabledLocales: string[];
}

/** What sign-up left in the database for `email` (as app_system). */
async function foundedBy(email: string): Promise<Founded[]> {
  return withSystem('agencies test: read sign-up', async (tx) => {
    const r = await tx.execute(sql`
      select u.id as "userId", m.agency_id as "agencyId", m.role, a.kind, a.status, a.name,
             s.enabled_locales as "enabledLocales"
        from users u
        join agency_members m on m.user_id = u.id
        join agencies a on a.agency_id = m.agency_id
        join agency_settings s on s.agency_id = a.agency_id
       where u.email = ${email}`);
    return r.rows as unknown as Founded[];
  });
}

/** Agencies with this name. Names are unique per test: files run in parallel against one database. */
const agencyCount = async (name: string) =>
  Number((await admin.query('select count(*) as n from agencies where name = $1', [name])).rows[0].n);
const uniqueName = (base: string) => `${base} ${randomInt(1e9)}`;

async function verifiedFounder(over: Partial<RegisterInput> = {}) {
  const input = signup(over);
  await identity.register(ctx(), input);
  const [founded] = await foundedBy(input.email);
  if (!founded) throw new Error('sign-up created no agency');
  await admin.query('update users set email_verified_at = now() where id = $1', [founded.userId]);
  return founded;
}

const memberCtx = (f: Founded) => ({ userId: f.userId, agencyId: f.agencyId, requestId: newId() });

describe('S1-01 sign-up creates the agency-of-one', () => {
  it('[S1-01] signup creates exactly one agency + admin user in one transaction', async () => {
    const input = signup({ locale: 'nl', companyName: uniqueName('Costa Homes S.L.') });
    await identity.register(ctx(), input);

    const rows = await foundedBy(input.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'AGENCY_ADMIN',
      kind: 'AGENCY',
      status: 'PENDING',
      name: input.companyName,
    });
    expect(rows[0]?.enabledLocales).toEqual(agencies.initialLocales('nl'));
    expect(await agencyCount(input.companyName)).toBe(1);
    // The confirmation-email event stays a platform event although the scope named the new agency.
    const events = await admin.query(
      `select agency_id from outbox_events where type = 'identity.user.registered' and payload->>'userId' = $1`,
      [rows[0]?.userId],
    );
    expect(events.rows).toEqual([{ agency_id: '00000000-0000-0000-0000-000000000000' }]);
  });

  it('[S1-01] signup creates exactly one agency + admin user in one transaction — a failure leaves neither', async () => {
    // The last write (the membership) fails after the user, agency and settings rows were written in
    // the same transaction. Planted in the transaction object, not as DDL (PATTERNS §20).
    const failing: AuthCtx = {
      requestId: newId(),
      transaction: (fn) =>
        withAuth((tx) =>
          fn(
            new Proxy(tx, {
              get(target, prop, receiver) {
                if (prop !== 'insert') return Reflect.get(target, prop, receiver);
                return (table: Parameters<Tx['insert']>[0]) => {
                  if (getTableName(table) === 'agency_members') throw new Error('planted failure');
                  return target.insert(table);
                };
              },
            }),
          ),
        ),
    };
    const input = signup({ companyName: uniqueName('Doomed Homes') });
    await expect(identity.register(failing, input)).rejects.toThrow(/planted failure/);
    const users = await admin.query('select 1 from users where email = $1', [input.email]);
    expect(users.rowCount).toBe(0);
    expect(await agencyCount(input.companyName)).toBe(0);
  });

  it('[S1-01] a developer sign-up creates a DEVELOPER agency administered by a DEVELOPER_ADMIN', async () => {
    const input = signup({ accountKind: 'DEVELOPER', companyName: 'Nova Obra Promociones' });
    await identity.register(ctx(), input);
    expect(await foundedBy(input.email)).toMatchObject([
      { role: 'DEVELOPER_ADMIN', kind: 'DEVELOPER', status: 'PENDING', name: 'Nova Obra Promociones' },
    ]);
  });

  it('[S1-01] signing up again with an unconfirmed email replaces the pending agency, never adds one', async () => {
    const input = signup({ companyName: uniqueName('Mallory Fake Homes') });
    await identity.register(ctx(), input);
    const [first] = await foundedBy(input.email);

    const owner = uniqueName('Real Owner Obra Nueva');
    await identity.register(ctx(), { ...input, accountKind: 'DEVELOPER', companyName: owner });
    const rows = await foundedBy(input.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agencyId: first?.agencyId,
      kind: 'DEVELOPER',
      role: 'DEVELOPER_ADMIN',
      name: owner,
    });
    expect(await agencyCount(input.companyName)).toBe(0);
    expect(await agencyCount(owner)).toBe(1);
  });

  it('[S1-01] a sign-up for a confirmed email creates no agency', async () => {
    const founded = await verifiedFounder();
    const email = (await admin.query('select email from users where id = $1', [founded.userId])).rows[0].email;
    const hijack = uniqueName('Hijack Homes');
    await identity.register(ctx(), signup({ email, companyName: hijack }));
    expect(await agencyCount(hijack)).toBe(0);
    expect(await foundedBy(email)).toMatchObject([{ agencyId: founded.agencyId, name: 'Costa Homes S.L.' }]);
  });

  it('[S1-01] access tokens carry the agency; the member ctx reads role and status from the database', async () => {
    const founded = await verifiedFounder();
    const { token } = await identity.issueAccessToken(ctx(), {
      userId: founded.userId,
      sessionVersion: 1,
      audience: 'api',
    });
    const claims = await verifier.verify(token, 'api');
    expect(claims.agency).toBe(founded.agencyId);

    const seen = await withMemberCtx(memberCtx(founded), async (c) => ({ actor: c.actor, tenant: c.tenant }));
    expect(seen.actor).toMatchObject({ kind: 'user', userId: founded.userId, role: 'AGENCY_ADMIN' });
    expect(seen.tenant).toMatchObject({ agencyId: founded.agencyId, verified: false });
  });

  it('[S1-01] a user who is not a member of the agency in the token is refused', async () => {
    const a = await verifiedFounder();
    const b = await verifiedFounder();
    await expect(
      withMemberCtx({ userId: a.userId, agencyId: b.agencyId, requestId: newId() }, async () => 'reached'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('S1-01 verification gate', () => {
  it('[S1-01] new agency is PENDING and cannot set SHARED/PUBLIC or create API keys (VERIFICATION_REQUIRED)', async () => {
    const founded = await verifiedFounder();
    expect(founded.status).toBe('PENDING');
    await withMemberCtx(memberCtx(founded), async (c) => {
      for (const action of ['listing.share', 'listing.publish', 'apiKey.create'] as const) {
        expect(() => agencies.assertVerified(c, action)).toThrowError(
          expect.objectContaining({ code: 'VERIFICATION_REQUIRED', details: { action } }),
        );
      }
    });

    // Staff verification (S1-03) flips the status; the next request sees it.
    await admin.query(`update agencies set status = 'VERIFIED' where agency_id = $1`, [founded.agencyId]);
    await withMemberCtx(memberCtx(founded), async (c) => {
      expect(c.tenant.verified).toBe(true);
      expect(() => agencies.assertVerified(c, 'apiKey.create')).not.toThrow();
    });
  });

  it('[S1-01] a suspended agency cannot reach tenant routes', async () => {
    const founded = await verifiedFounder();
    await admin.query(`update agencies set status = 'SUSPENDED' where agency_id = $1`, [founded.agencyId]);
    await expect(withMemberCtx(memberCtx(founded), async () => 'reached')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'agency_suspended' },
    });
  });
});

describe('S1-01 onboarding', () => {
  const details = (version: number, over: Record<string, unknown> = {}) =>
    UpdateAgencyDetailsBody.parse({
      version,
      name: 'Costa Homes S.L.',
      taxId: 'b-12.345.674',
      addressLine: 'Calle Mayor 1',
      city: 'Marbella',
      postalCode: '29601',
      region: 'ES-AN',
      languages: ['es', 'en'],
      ...over,
    });

  it('[S1-01] onboarding stores the company details with a normalized CIF and emits agencies.details.updated', async () => {
    const founded = await verifiedFounder();
    const before = await withMemberCtx(memberCtx(founded), (c) => agencies.getMyAgency(c));
    expect(before).toMatchObject({ status: 'PENDING', onboarded: false, taxId: null });

    const after = await withMemberCtx(memberCtx(founded), (c) =>
      agencies.updateAgencyDetails(c, details(before.version)),
    );
    expect(after).toMatchObject({
      taxId: 'B12345674',
      region: 'ES-AN',
      postalCode: '29601',
      languages: ['es', 'en'],
      onboarded: true,
      status: 'PENDING',
      version: before.version + 1,
    });

    const events = await admin.query(
      `select agency_id, payload from outbox_events where type = 'agencies.details.updated' and agency_id = $1`,
      [founded.agencyId],
    );
    expect(events.rows).toEqual([
      {
        agency_id: founded.agencyId,
        payload: { agencyId: founded.agencyId, version: after.version, firstOnboarding: true },
      },
    ]);
  });

  it('[S1-01] onboarding with a stale version is a VERSION_CONFLICT', async () => {
    const founded = await verifiedFounder();
    const { version } = await withMemberCtx(memberCtx(founded), (c) => agencies.getMyAgency(c));
    await withMemberCtx(memberCtx(founded), (c) => agencies.updateAgencyDetails(c, details(version)));
    await expect(
      withMemberCtx(memberCtx(founded), (c) => agencies.updateAgencyDetails(c, details(version))),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('[S1-01] onboarding rejects languages that are not content locales', async () => {
    const founded = await verifiedFounder();
    const { version } = await withMemberCtx(memberCtx(founded), (c) => agencies.getMyAgency(c));
    await expect(
      withMemberCtx(memberCtx(founded), (c) =>
        agencies.updateAgencyDetails(c, details(version, { languages: ['xx'] })),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'languages', unsupported: ['xx'] } });
  });

  it('[S1-01] an agent cannot change the company details', async () => {
    const founded = await verifiedFounder();
    await admin.query(`update agency_members set role = 'AGENT' where user_id = $1`, [founded.userId]);
    await expect(
      withMemberCtx(memberCtx(founded), (c) => agencies.updateAgencyDetails(c, details(1))),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('[S1-01] after onboarding, sign-up flows can no longer touch the agency (app_auth predicate)', async () => {
    const founded = await verifiedFounder();
    const { version } = await withMemberCtx(memberCtx(founded), (c) => agencies.getMyAgency(c));
    await withMemberCtx(memberCtx(founded), (c) => agencies.updateAgencyDetails(c, details(version)));
    await admin.query('update users set email_verified_at = null where id = $1', [founded.userId]);
    const email = (await admin.query('select email from users where id = $1', [founded.userId])).rows[0].email;

    await identity.register(ctx(), signup({ email, companyName: 'Takeover Homes' }));
    expect(await foundedBy(email)).toMatchObject([{ agencyId: founded.agencyId, name: 'Costa Homes S.L.' }]);
  });
});

describe('S1-01 tenant writes stop at what staff own', () => {
  const asTenant = (f: Founded, statement: ReturnType<typeof sql>) =>
    withMemberCtx(memberCtx(f), (c) => c.tx.execute(statement));

  it('[S1-01] new agency is PENDING and cannot set SHARED/PUBLIC or create API keys (VERIFICATION_REQUIRED) — not even by writing its own status', async () => {
    const f = await verifiedFounder();
    for (const statement of [
      sql`update agencies set status = 'VERIFIED' where agency_id = ${f.agencyId}`,
      sql`update agencies set kind = 'DEVELOPER' where agency_id = ${f.agencyId}`,
      sql`delete from agencies where agency_id = ${f.agencyId}`,
      sql`update agency_members set role = 'AGENT' where user_id = ${f.userId}`,
    ]) {
      await expect(asTenant(f, statement)).rejects.toMatchObject({ cause: { code: '42501' } });
    }
    expect(
      await foundedBy((await admin.query('select email from users where id = $1', [f.userId])).rows[0].email),
    ).toMatchObject([{ status: 'PENDING', kind: 'AGENCY', role: 'AGENCY_ADMIN' }]);
  });

  it('[S1-01] a verified agency cannot change its name or tax id (AGENCY_DETAILS_LOCKED); address stays editable', async () => {
    const f = await verifiedFounder();
    const body = (version: number, over: Record<string, unknown> = {}) =>
      UpdateAgencyDetailsBody.parse({
        version,
        name: 'Costa Homes S.L.',
        taxId: 'B12345674',
        addressLine: 'Calle Mayor 1',
        city: 'Marbella',
        postalCode: '29601',
        region: 'ES-AN',
        languages: ['es'],
        ...over,
      });
    const saved = await withMemberCtx(memberCtx(f), (c) => agencies.updateAgencyDetails(c, body(1)));
    await admin.query(`update agencies set status = 'VERIFIED' where agency_id = $1`, [f.agencyId]);

    await expect(
      withMemberCtx(memberCtx(f), (c) =>
        agencies.updateAgencyDetails(c, body(saved.version, { taxId: 'Q2826000H', name: 'Other Firm S.A.' })),
      ),
    ).rejects.toMatchObject({ code: 'AGENCY_DETAILS_LOCKED', details: { fields: ['name', 'taxId'] } });

    const moved = await withMemberCtx(memberCtx(f), (c) =>
      agencies.updateAgencyDetails(c, body(saved.version, { addressLine: 'Avenida del Mar 9' })),
    );
    expect(moved).toMatchObject({ addressLine: 'Avenida del Mar 9', taxId: 'B12345674', status: 'VERIFIED' });
  });
});
