import {
  AGENCY_LOGO_MAX_BYTES,
  AGENCY_LOGO_TYPES,
  AgencyAiFeaturesDto,
  AgencyProfileDto,
  AgencySettingsDto,
  AiFeatureParams,
  SetAiFeatureBody,
  SignedUrlDto,
  UpdateAgencyProfileBody,
  UpdateAgencySettingsBody,
} from '@inmolink/contracts';
import * as agencies from '@inmolink/core/modules/agencies';
import { AppError } from '@inmolink/platform/errors';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'agencies.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'agencies.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'agencies.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'agencies.write.user', scope: 'user', limit: 30, windowSeconds: 60 },
];
const LOGO_LIMITS: readonly RateLimitRule[] = [
  { name: 'agencies.logo.ip', scope: 'ip', limit: 30, windowSeconds: 60 },
  { name: 'agencies.logo.user', scope: 'user', limit: 20, windowSeconds: 600 },
  { name: 'agencies.logo.tenant', scope: 'tenant', limit: 50, windowSeconds: 3_600 },
];

/** The caller's agency profile and settings (S1-06). */
export async function settingsRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/agency/profile',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.getAgencyProfile',
        summary: "The agency's profile: logo, brand colours, contact details and texts per locale",
        response: { 200: AgencyProfileDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => agencies.getAgencyProfile(ctx)),
  );

  app.put(
    '/v1/agency/profile',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.updateAgencyProfile',
        summary: 'Save the profile (optimistic `version`, 0 for the first save); the texts sent replace the others',
        body: UpdateAgencyProfileBody,
        response: { 200: AgencyProfileDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => agencies.updateAgencyProfile(ctx, req.body)),
  );

  app.get(
    '/v1/agency/profile/logo/url',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.getAgencyLogoUrl',
        summary: 'A 5-minute link to the current logo (dashboard preview)',
        response: { 200: SignedUrlDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      // The link is a bearer credential for the file: never cached on the way.
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => agencies.getAgencyLogoUrl(ctx));
    },
  );

  app.delete(
    '/v1/agency/profile/logo',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.removeAgencyLogo',
        summary: 'Remove the logo',
        response: { 200: AgencyProfileDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => agencies.removeAgencyLogo(app.ctxRunner(req)),
  );

  await app.register(logoUploadRoute);

  app.get(
    '/v1/agency/settings',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.getAgencySettings',
        summary: "The agency's settings: commission, split, PIN policy (members; refused in Client Mode)",
        response: { 200: AgencySettingsDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    // Commission, split and PIN policy: never kept by a browser or proxy cache.
    (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => agencies.getMyAgencySettings(ctx));
    },
  );

  app.put(
    '/v1/agency/settings',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.updateAgencySettings',
        summary: 'Save the settings: commission, registration and viewing days, locales, white-label, Client Mode',
        body: UpdateAgencySettingsBody,
        response: { 200: AgencySettingsDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => agencies.updateAgencySettings(ctx, req.body));
    },
  );

  app.get(
    '/v1/agency/ai-features',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.getAgencyAiFeatures',
        summary: 'Which AI features the agency switched on (members; refused in Client Mode)',
        response: { 200: AgencyAiFeaturesDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => agencies.getAgencyAiFeatures(ctx));
    },
  );

  app.put(
    '/v1/agency/ai-features/:feature',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.setAgencyAiFeature',
        summary: 'Switch one AI feature on or off (admins; every change audited)',
        params: AiFeatureParams,
        body: SetAiFeatureBody,
        response: { 200: AgencyAiFeaturesDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req, reply) => {
      reply.header('cache-control', 'no-store');
      return agencies.setAgencyAiFeature(app.ctxRunner(req), req.params.feature, req.body.enabled);
    },
  );
}

/**
 * The logo upload, in its own plugin: its body is the raw image, and only this route (and the
 * verification upload) accepts binary bodies, up to 512 KB. The declared type only routes the body
 * here; the service checks the real type by magic bytes.
 */
async function logoUploadRoute(upload: FastifyZod): Promise<void> {
  upload.addContentTypeParser(
    [...AGENCY_LOGO_TYPES, 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: AGENCY_LOGO_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  upload.put(
    '/v1/agency/profile/logo',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.uploadAgencyLogo',
        summary: 'Replace the logo (raw PNG/JPEG/WebP body, max 512 KB)',
        response: { 200: AgencyProfileDto },
      },
      bodyLimit: AGENCY_LOGO_MAX_BYTES,
      onRequest: [upload.requireSession],
      config: { rateLimit: LOGO_LIMITS },
    },
    async (req) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
      const body = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
      return agencies.uploadAgencyLogo(upload.ctxRunner(req), { body });
    },
  );
}
