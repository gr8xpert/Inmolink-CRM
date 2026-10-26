import { AI_FEATURES } from '@inmolink/contracts';
import { closeDb, withPublicRead, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, CtxRunner } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as agencies from '../index';

/** AI feature toggles per agency (S13-F17): default off, admin-only, audited, one cached read per call site. */

const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('agencies.ai-features.test', fn);
let admin: Founder;
let agent: { userId: string; agencyId: string };

const as = <T>(
  m: { userId: string; agencyId: string },
  fn: (ctx: Ctx) => Promise<T>,
  over: { clientMode?: boolean; impersonatedBy?: string } = {},
) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, async (ctx) => {
    const base = over.impersonatedBy ? await impersonatedCtx(ctx, over.impersonatedBy) : ctx;
    return fn({ ...base, clientMode: over.clientMode ?? false });
  });

const runAs =
  (m: { userId: string; agencyId: string }, over: { clientMode?: boolean; impersonatedBy?: string } = {}): CtxRunner =>
  (fn) =>
    as(m, fn, over);

async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

const auditRows = (agencyId: string) =>
  system(async (tx) => {
    const r = await tx.execute<{ metadata: { feature: string; enabled: boolean }; actor_user_id: string }>(
      sql`select metadata, actor_user_id from audit_logs
           where agency_id = ${agencyId} and type = 'agencies.aiFeatures.changed' order by occurred_at, id`,
    );
    return r.rows;
  });

/** A website site of the agency (S14-F7: the public lookup answers only for an agency with a live one). */
const addSite = (agencyId: string, userId: string, planEndsAt: Date | null = null) =>
  system((tx) =>
    tx.execute(sql`insert into website_sites (id, agency_id, name, mode, locales, default_locale, created_by, plan_ends_at)
      values (${newId()}, ${agencyId}, 'Site', 'WIDGET', '{en}', 'en', ${userId}, ${planEndsAt?.toISOString() ?? null})`),
  );

const publicLookup = async (agencyId: string) =>
  (
    (await withPublicRead((tx) => tx.execute(sql`select agency_ai_features(${agencyId}::uuid) as f`))).rows[0] as {
      f: string[];
    }
  ).f;

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:agai:${newId().slice(-12)}` });
  admin = await createFounder();
  const agentId = newId();
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agentId}, ${`agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${admin.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`agent-${agentId}@example.com`})`);
  });
  agent = { userId: agentId, agencyId: admin.agencyId };
}, 120_000);

afterAll(async () => {
  await closeCache();
  await closeDb();
});

describe('AI feature toggles (S13-F17)', () => {
  it('[S13-F17] every toggle is off by default, for members and for the cached call-site read', async () => {
    const dto = await as(agent, (ctx) => agencies.getAgencyAiFeatures(ctx));
    expect(dto.features).toEqual(Object.fromEntries(AI_FEATURES.map((f) => [f, false])));
    for (const f of AI_FEATURES) expect(await agencies.aiFeatureEnabled(admin.agencyId, f)).toBe(false);
    // the public lookup (feed-api) answers the same, and nothing for an unknown agency
    expect(
      await withPublicRead((tx) => tx.execute(sql`select agency_ai_features(${admin.agencyId}::uuid) as f`)),
    ).toMatchObject({ rows: [{ f: [] }] });
    expect(await agencies.enabledAiFeatures(newId())).toEqual([]);
  });

  it('[S13-F17] only an admin switches a feature, never an agent, Client Mode or impersonating staff', async () => {
    const other = await createFounder();
    expect(await refusal(agencies.setAgencyAiFeature(runAs(agent), 'LISTING_STUDIO', true))).toBe('FORBIDDEN');
    expect(await refusal(agencies.setAgencyAiFeature(runAs(admin, { clientMode: true }), 'LISTING_STUDIO', true))).toBe(
      'FORBIDDEN',
    );
    expect(
      await refusal(
        agencies.setAgencyAiFeature(runAs(admin, { impersonatedBy: other.userId }), 'LISTING_STUDIO', true),
      ),
    ).toBe('FORBIDDEN');
    // Client Mode cannot even read them
    expect(await refusal(as(agent, (ctx) => agencies.getAgencyAiFeatures(ctx), { clientMode: true }))).toBe(
      'FORBIDDEN',
    );
    expect(await auditRows(admin.agencyId)).toEqual([]);
    expect(await agencies.aiFeatureEnabled(admin.agencyId, 'LISTING_STUDIO')).toBe(false);
  });

  it('[S13-F17] a member cannot write ai_features directly: only an active admin, never impersonated (guard trigger)', async () => {
    const other = await createFounder();
    const write = (m: { userId: string; agencyId: string }, over: { impersonatedBy?: string } = {}) =>
      sqlState(
        as(
          m,
          (ctx) =>
            ctx.tx.execute(
              sql`update agency_settings set ai_features = '{LISTING_STUDIO}' where agency_id = ${m.agencyId}`,
            ),
          over,
        ),
      );
    expect(await write(agent)).toBe('42501');
    expect(await write(admin, { impersonatedBy: other.userId })).toBe('42501');
    // an update leaving the toggles as they are passes (other settings stay the service's business)
    expect(
      await sqlState(
        as(agent, (ctx) =>
          ctx.tx.execute(sql`update agency_settings set ai_features = ai_features where agency_id = ${admin.agencyId}`),
        ),
      ),
    ).toBeUndefined();
    expect(await agencies.enabledAiFeatures(admin.agencyId)).toEqual([]);
  });

  it('[S13-F17] each change has one audit row; a switch that changes nothing writes none', async () => {
    const f = await createFounder();
    const on = await agencies.setAgencyAiFeature(runAs(f), 'WHITE_LABEL', true);
    expect(on.features).toMatchObject({ WHITE_LABEL: true, LISTING_STUDIO: false });
    await agencies.setAgencyAiFeature(runAs(f), 'WHITE_LABEL', true); // no change
    await agencies.setAgencyAiFeature(runAs(f), 'LISTING_STUDIO', true);
    await agencies.setAgencyAiFeature(runAs(f), 'WHITE_LABEL', false);
    const rows = await auditRows(f.agencyId);
    expect(rows.map((r) => r.metadata)).toEqual([
      { feature: 'WHITE_LABEL', enabled: true },
      { feature: 'LISTING_STUDIO', enabled: true },
      { feature: 'WHITE_LABEL', enabled: false },
    ]);
    expect(rows.every((r) => r.actor_user_id === f.userId)).toBe(true);
    // each change also emits agencies.settings.changed (the cross-process backstop of the invalidation)
    const events = await system(async (tx) =>
      tx.execute<{ changed: string[] }>(
        sql`select payload->'changed' as changed from outbox_events
             where agency_id = ${f.agencyId} and type = 'agencies.settings.changed'`,
      ),
    );
    expect(events.rows.map((r) => r.changed)).toEqual([['aiFeatures'], ['aiFeatures'], ['aiFeatures']]);
    // the settings form's optimistic version is untouched
    expect((await as(f, (ctx) => agencies.getMyAgencySettings(ctx))).version).toBe(1);
    expect(await agencies.enabledAiFeatures(f.agencyId)).toEqual(['LISTING_STUDIO']);
    // other agencies unaffected
    expect(await agencies.enabledAiFeatures(admin.agencyId)).toEqual([]);
  });

  it('[S13-F17] switched off in this process, the very next call-site read says off (no subscriber run, no wait)', async () => {
    const f = await createFounder();
    await addSite(f.agencyId, f.userId); // S14-F7: website search answers only for an agency with a live site
    await agencies.setAgencyAiFeature(runAs(f), 'WEBSITE_SEARCH', true);
    // warm: the cached read (Redis and the in-process copy) says on
    expect(await agencies.aiFeatureEnabled(f.agencyId, 'WEBSITE_SEARCH')).toBe(true);
    expect(await agencies.aiFeatureEnabled(f.agencyId, 'WEBSITE_SEARCH')).toBe(true);
    await agencies.setAgencyAiFeature(runAs(f), 'WEBSITE_SEARCH', false);
    expect(await agencies.aiFeatureEnabled(f.agencyId, 'WEBSITE_SEARCH')).toBe(false);
    // and on again, at once
    await agencies.setAgencyAiFeature(runAs(f), 'WEBSITE_SEARCH', true);
    expect(await agencies.aiFeatureEnabled(f.agencyId, 'WEBSITE_SEARCH')).toBe(true);
  });

  it('[S13-F17] the call-site read is cached: a warm read runs no statement', async () => {
    const { countQueries } = await import('@inmolink/db');
    // both entries warm: the public website-search answer and the full toggles (S14-F7)
    await agencies.aiFeatureEnabled(admin.agencyId, 'WEBSITE_SEARCH');
    await agencies.aiFeatureEnabled(admin.agencyId, 'LISTING_STUDIO');
    const n = await countQueries(async () => {
      for (const f of AI_FEATURES) await agencies.aiFeatureEnabled(admin.agencyId, f);
    });
    expect(n).toBe(0);
  });

  it('[S14-F7] the public lookup answers only the website-search toggle, only for an agency with a live site', async () => {
    const f = await createFounder();
    await agencies.setAgencyAiFeature(runAs(f), 'WEBSITE_SEARCH', true);
    await agencies.setAgencyAiFeature(runAs(f), 'WHITE_LABEL', true);
    // an agency without a site gets nothing — not its website-search toggle, not any other
    expect(await publicLookup(f.agencyId)).toEqual([]);
    expect(await agencies.aiFeatureEnabled(f.agencyId, 'WEBSITE_SEARCH')).toBe(false);
    // workers still read every toggle (system transaction), site or not
    expect(await agencies.aiFeatureEnabled(f.agencyId, 'WHITE_LABEL')).toBe(true);
    // a site whose plan ended is not live
    await addSite(f.agencyId, f.userId, new Date(Date.now() - 60_000));
    expect(await publicLookup(f.agencyId)).toEqual([]);
    // a live site: the website-search toggle only, never the others
    await addSite(f.agencyId, f.userId);
    expect(await publicLookup(f.agencyId)).toEqual(['WEBSITE_SEARCH']);
    await agencies.setAgencyAiFeature(runAs(f), 'WEBSITE_SEARCH', false);
    expect(await publicLookup(f.agencyId)).toEqual([]);
    await agencies.setAgencyAiFeature(runAs(f), 'WEBSITE_SEARCH', true);
    // a suspended agency gets nothing
    await setAgencyStatus(f.agencyId, 'SUSPENDED');
    expect(await publicLookup(f.agencyId)).toEqual([]);
    await setAgencyStatus(f.agencyId, 'VERIFIED');
    expect(await publicLookup(f.agencyId)).toEqual(['WEBSITE_SEARCH']);
  });
});
