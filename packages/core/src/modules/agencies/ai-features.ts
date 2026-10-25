import { type AgencyAiFeaturesDto, AI_FEATURES, type AiFeature } from '@inmolink/contracts';
import { type Tx, withPublicRead } from '@inmolink/db';
import { cache, cacheKey } from '@inmolink/platform/cache';
import { AppError } from '@inmolink/platform/errors';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx, CtxRunner } from '../../context';
import * as compliance from '../compliance';
import { agenciesEvents } from './events';
import { assertCan } from './policy';
import { agencySettingsCacheTag, invalidateAgencySettings, markSettingsWritten, settingsWritten } from './settings';
import * as repo from './settings-repo';

/**
 * AI features switched on and off per agency, one toggle per feature (S13-F17, PLAN §8; Shahzaib 2026-10-25). Every
 * toggle is off until an admin switches it on (the service, and guard trigger 0158 for any other tenant write); each
 * change is audited (`agencies.aiFeatures.changed`, one row) and emits `agencies.settings.changed`
 * (`changed: ['aiFeatures']`) in the same transaction.
 *
 * Each feature's call site asks `aiFeatureEnabled` before any model call: one cached read (redis-cache, tagged with the
 * agency's settings tag, plus a 15-second in-process copy in the process LRU — the feed-api's AI search pays no
 * statement on a warm process). A miss is one primary-key read: on the caller's transaction (`ctx`, RLS) or, without
 * one (feed-api, workers), through the SECURITY DEFINER `agency_ai_features(uuid)` under `withPublicRead` (its own
 * read-only transaction: the platform has no non-transactional read).
 *
 * Propagation of a change: after the commit, `setAgencyAiFeature` bumps the agency's settings tag itself, so this
 * process (its in-process copy included) and every Redis reader see the change at once; the event's subscriber bumps it
 * again as the backstop (a failed bump after commit). Other processes' in-process copies follow within their 15 s, so
 * a toggle switched off stops their calls within outbox delivery (if the direct bump failed) + 15 s.
 */

export const AI_FEATURES_CACHE = { TTL_SECONDS: 300, LOCAL_TTL_SECONDS: 15 } as const;

export const aiFeaturesCacheKey = (agencyId: string) =>
  cacheKey({ v: 1, module: 'agencies', entity: 'ai-features', scope: { agencyId } });

const known = (features: readonly string[]): AiFeature[] =>
  features.filter((f): f is AiFeature => (AI_FEATURES as readonly string[]).includes(f));

/** The agency's switched-on AI features (cached). `ctx` (that agency's) reads on its transaction on a miss. */
export async function enabledAiFeatures(agencyId: string, ctx?: Ctx): Promise<AiFeature[]> {
  const own = ctx && ctx.tenant.agencyId === agencyId ? ctx : undefined;
  const fromDb = async (): Promise<string[]> =>
    own
      ? ((await repo.aiFeaturesOf(own.tx, agencyId)) ?? [])
      : withPublicRead((tx) => repo.publicAiFeaturesOf(tx, agencyId));
  // A transaction that switched a toggle reads its own write, and never caches it (it may still roll back).
  if (own && settingsWritten(own.tx)) return known(await fromDb());
  const features = await cache.get(
    aiFeaturesCacheKey(agencyId),
    {
      ttlSeconds: AI_FEATURES_CACHE.TTL_SECONDS,
      localTtlSeconds: AI_FEATURES_CACHE.LOCAL_TTL_SECONDS,
      local: true,
      tags: [agencySettingsCacheTag(agencyId)],
    },
    fromDb,
  );
  return known(features ?? []);
}

/** Whether the agency switched this AI feature on: every call site asks it before any model call. */
export async function aiFeatureEnabled(agencyId: string, feature: AiFeature, ctx?: Ctx): Promise<boolean> {
  return (await enabledAiFeatures(agencyId, ctx)).includes(feature);
}

/** `AI_NOT_ENABLED` unless the caller's agency switched this feature on (request paths). */
export async function assertAiFeatureEnabled(ctx: Ctx, feature: AiFeature): Promise<void> {
  if (!(await aiFeatureEnabled(ctx.tenant.agencyId, feature, ctx))) {
    throw new AppError('AI_NOT_ENABLED', { feature });
  }
}

function toDto(features: readonly string[]): AgencyAiFeaturesDto {
  const on = new Set(features);
  return {
    features: {
      WEBSITE_SEARCH: on.has('WEBSITE_SEARCH'),
      WHITE_LABEL: on.has('WHITE_LABEL'),
      LISTING_STUDIO: on.has('LISTING_STUDIO'),
      SOCIAL_CAPTIONS: on.has('SOCIAL_CAPTIONS'),
      TRANSLATION_DRAFTS: on.has('TRANSLATION_DRAFTS'),
    },
  };
}

/** `GET /v1/agency/ai-features`: any member, not in Client Mode (the dashboard hides what is off). Database read. */
export async function getAgencyAiFeatures(ctx: Ctx): Promise<AgencyAiFeaturesDto> {
  assertCan(ctx, 'agencies.aiFeatures.read');
  const features = await repo.aiFeaturesOf(ctx.tx, ctx.tenant.agencyId);
  if (features === null) throw new AppError('NOT_FOUND');
  return toDto(features);
}

/**
 * `PUT /v1/agency/ai-features/:feature`: admins only, not in Client Mode, never while impersonated. Idempotent: a
 * switch that changes nothing writes no audit row and emits nothing; a change writes one audit row and emits
 * `agencies.settings.changed` in the same transaction, then — committed — invalidates the cached toggles at once.
 */
export async function setAgencyAiFeature(
  run: CtxRunner,
  feature: AiFeature,
  enabled: boolean,
): Promise<AgencyAiFeaturesDto> {
  const res = await run(async (ctx) => ({
    agencyId: ctx.tenant.agencyId,
    ...(await switchAiFeature(ctx, feature, enabled)),
  }));
  // After the commit: a bump inside the transaction could be undone by a concurrent miss reloading the old row.
  if (res.changed) {
    await invalidateAgencySettings(res.agencyId).catch(() => {
      // Redis down: this process's in-process copy is dropped already (before the Redis bump); the outbox
      // subscriber bumps the tag again for everyone else.
    });
  }
  return res.dto;
}

async function switchAiFeature(
  ctx: Ctx,
  feature: AiFeature,
  enabled: boolean,
): Promise<{ dto: AgencyAiFeaturesDto; changed: boolean }> {
  assertCan(ctx, 'agencies.aiFeatures.update');
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  const agencyId = ctx.tenant.agencyId;
  const res = await repo.setAiFeature(ctx.tx, agencyId, feature, enabled);
  if (!res) throw new AppError('NOT_FOUND');
  if (res.before.includes(feature) === enabled) return { dto: toDto(res.after), changed: false };
  markSettingsWritten(ctx.tx);
  await emit(
    ctx.tx,
    agenciesEvents.settingsChanged({
      agencyId,
      version: res.version,
      changed: ['aiFeatures'],
      actorUserId: ctx.actor.userId,
      impersonatedBy: ctx.actor.impersonatedBy ?? null,
    }),
  );
  await compliance.audit(ctx, 'agencies.aiFeatures.changed', { type: 'agency', id: agencyId }, { feature, enabled });
  return { dto: toDto(res.after), changed: true };
}

/** S13-F17: a page of the agencies that switched `feature` on (a worker sweep, `withSystem`). */
export function agencyIdsWithAiFeaturePage(
  tx: Tx,
  feature: AiFeature,
  after: string | null,
  limit: number,
): Promise<string[]> {
  return repo.agencyIdsWithAiFeaturePage(tx, feature, after, limit);
}
