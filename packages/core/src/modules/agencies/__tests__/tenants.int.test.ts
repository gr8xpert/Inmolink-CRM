import { closeDb } from '@inmolink/db';
import { adminQuery, createStaffUser, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffCtx } from '../../../context';
import { withStaffCtx } from '../../../staff';
import { createFounder } from '../../../testing/factories';
import * as identity from '../../identity';
import * as agencies from '../index';

/** Staff console tenants (S1-09) on the real test database, as `app_staff`. */

beforeAll(async () => {
  await setupTestDb('http');
}, 120_000); // setupTestDb under a full parallel verify (S1-F1)

afterAll(async () => {
  await closeDb();
});

const asStaff = <T>(userId: string, fn: (ctx: StaffCtx) => Promise<T>) =>
  withStaffCtx({ userId, requestId: newId(), reason: 'tenants test' }, fn);

describe('staff tenants', () => {
  it('[S1-09] tenants list: newest first in keyset pages, filtered by status, searched by name (literal) or tax id', async () => {
    const tag = newId().slice(-8);
    const a = await createFounder({ companyName: `Tenants_${tag} Alpha S.L.` });
    const b = await createFounder({ companyName: `Tenants_${tag} Beta S.L.` });
    const c = await createFounder({ companyName: `Tenants%${tag} Gamma S.L.` });
    await setAgencyStatus(b.agencyId, 'VERIFIED');
    const staff = await createStaffUser('STAFF_DATA_OPS');

    const page1 = await asStaff(staff.userId, (ctx) => agencies.listTenants(ctx, { q: `tenants_${tag}`, limit: 1 }));
    expect(page1.items.map((t) => t.id)).toEqual([b.agencyId]);
    const page2 = await asStaff(staff.userId, (ctx) =>
      agencies.listTenants(ctx, { q: `tenants_${tag}`, limit: 10, cursor: page1.nextCursor ?? undefined }),
    );
    // `_` is literal: "Tenants%…" does not match "tenants_…".
    expect(page2.items.map((t) => t.id)).toEqual([a.agencyId]);
    expect(page2.nextCursor).toBeNull();

    const verified = await asStaff(staff.userId, (ctx) =>
      agencies.listTenants(ctx, { q: tag, status: 'VERIFIED', limit: 10 }),
    );
    expect(verified.items.map((t) => [t.id, t.status])).toEqual([[b.agencyId, 'VERIFIED']]);
    const percent = await asStaff(staff.userId, (ctx) => agencies.listTenants(ctx, { q: `%${tag}`, limit: 10 }));
    expect(percent.items.map((t) => t.id)).toEqual([c.agencyId]);

    const detail = await asStaff(staff.userId, (ctx) => agencies.getTenant(ctx, { agencyId: a.agencyId }));
    expect(detail).toMatchObject({
      id: a.agencyId,
      kind: 'AGENCY',
      status: 'PENDING',
      onboarded: false,
      verification: null,
    });
    await expect(asStaff(staff.userId, (ctx) => agencies.getTenant(ctx, { agencyId: newId() }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // Not staff: refused before any query.
    await expect(asStaff(a.userId, (ctx) => agencies.listTenants(ctx, { limit: 10 }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('[S1-09] keyset pages neither skip nor repeat rows whose times share a millisecond (newest and oldest first)', async () => {
    const tag = newId().slice(-8);
    const founders = [];
    for (const n of [1, 2, 3]) founders.push(await createFounder({ companyName: `Samems_${tag} ${n} S.L.` }));
    // Same millisecond, different microseconds (Postgres keeps them; a JS cursor cannot).
    for (const [i, f] of founders.entries()) {
      await adminQuery(`update agencies set created_at = $2::timestamptz where agency_id = $1`, [
        f.agencyId,
        `2026-01-01T00:00:00.123${i}${i}${i}Z`,
      ]);
    }
    const staff = await createStaffUser('STAFF_SUPPORT');
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await asStaff(staff.userId, (ctx) =>
        agencies.listTenants(ctx, { q: `samems_${tag}`, limit: 1, cursor }),
      );
      seen.push(...page.items.map((t) => t.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.sort()).toEqual(founders.map((f) => f.agencyId).sort());

    // Oldest first: an agency's members.
    const owner = founders[0];
    if (!owner) throw new Error('no founder');
    const ids = [owner.userId];
    for (const n of [1, 2]) {
      const id = newId();
      ids.push(id);
      await adminQuery(
        `insert into users (id, email, password_hash, name, locale, email_verified_at) values ($1, $2, 'x', 'M', 'es', now())`,
        [id, `m${n}-${tag}@example.com`],
      );
      await adminQuery(
        `insert into agency_members (agency_id, user_id, role, name, email) values ($1, $2, 'AGENT', 'M', $3)`,
        [owner.agencyId, id, `m${n}-${tag}@example.com`],
      );
    }
    for (const [i, id] of ids.entries()) {
      await adminQuery(`update agency_members set created_at = $2::timestamptz where user_id = $1`, [
        id,
        `2026-01-01T00:00:00.456${i}${i}${i}Z`,
      ]);
    }
    const members: string[] = [];
    cursor = undefined;
    do {
      const page = await asStaff(staff.userId, (ctx) =>
        identity.listAgencyMembers(ctx, { agencyId: owner.agencyId, limit: 1, cursor }),
      );
      members.push(...page.items.map((m) => m.userId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(members.sort()).toEqual([...ids].sort());
  });
});
