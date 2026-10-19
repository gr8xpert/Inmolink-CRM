'use server';

import {
  CreateMappingProfileBody,
  MapperDryRunBody,
  type MapperDryRunDto,
  MapperPreviewBody,
  type MapperPreviewDto,
  type MapperSampleDto,
  MapperSampleUrlBody,
  type MappingProfileDto,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import {
  createMappingProfile,
  dryRunMapperMapping,
  previewMapperMapping,
  sampleFromUrl,
  sessionRef,
} from '@/server/api';

/**
 * The visual mapper's calls (S6-04, transport only): validate with the contracts, call the API, answer with data or
 * an error code (i18n keys under `imports.mapper.errors`). Called from the mapper panel; the API authorizes (admins).
 */
export type MapperResult<T> = { ok: true; data: T } | { ok: false; error: string; reason?: string };

const KNOWN_ERRORS = new Set([
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'FEED_URL_NOT_ALLOWED',
  'FEED_SAMPLE_INVALID',
  'FEED_MAPPING_INVALID',
  'FEED_CONNECTION_NOT_FOUND',
  'RATE_LIMITED',
]);

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

function fail(error: { code?: string; details?: unknown } | null | undefined): MapperResult<never> {
  const code = error?.code;
  const reason = (error?.details as { reason?: unknown } | undefined)?.reason;
  return {
    ok: false,
    error: code && KNOWN_ERRORS.has(code) ? code : 'generic',
    ...(typeof reason === 'string' ? { reason: reason.slice(0, 40) } : {}),
  };
}

type Api<T> = Promise<
  'revoked' | { ok: true; data: T } | { ok: false; error: { code?: string; details?: unknown } | null }
>;

async function relay<T>(call: Api<T>): Promise<MapperResult<T>> {
  const res = await call;
  if (res === 'revoked') redirect('/session/expired');
  return res.ok ? { ok: true, data: res.data } : fail(res.error);
}

export async function sampleUrlAction(input: unknown): Promise<MapperResult<MapperSampleDto>> {
  const body = MapperSampleUrlBody.safeParse(input);
  if (!body.success) return { ok: false, error: 'VALIDATION_FAILED' };
  return relay(sampleFromUrl(await session(), body.data) as Api<MapperSampleDto>);
}

export async function previewAction(input: unknown): Promise<MapperResult<MapperPreviewDto>> {
  const body = MapperPreviewBody.safeParse(input);
  if (!body.success) return { ok: false, error: 'FEED_MAPPING_INVALID' };
  return relay(previewMapperMapping(await session(), body.data) as Api<MapperPreviewDto>);
}

export async function dryRunAction(input: unknown): Promise<MapperResult<MapperDryRunDto>> {
  const body = MapperDryRunBody.safeParse(input);
  if (!body.success) return { ok: false, error: 'FEED_MAPPING_INVALID' };
  return relay(dryRunMapperMapping(await session(), body.data) as Api<MapperDryRunDto>);
}

export async function saveProfileAction(input: unknown): Promise<MapperResult<MappingProfileDto>> {
  const body = CreateMappingProfileBody.safeParse(input);
  if (!body.success) return { ok: false, error: 'FEED_MAPPING_INVALID' };
  return relay(createMappingProfile(await session(), body.data) as Api<MappingProfileDto>);
}
