import {
  MEMBER_PHOTO_MAX_BYTES,
  MEMBER_PHOTO_TYPES,
  MemberPublicProfileDto,
  UpdateMemberPublicProfileBody,
} from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import { AppError } from '@inmolink/platform/errors';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'identity.public-profile.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'identity.public-profile.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'identity.public-profile.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'identity.public-profile.write.user', scope: 'user', limit: 30, windowSeconds: 60 },
];
const PHOTO_LIMITS: readonly RateLimitRule[] = [
  { name: 'identity.public-profile.photo.ip', scope: 'ip', limit: 30, windowSeconds: 60 },
  { name: 'identity.public-profile.photo.user', scope: 'user', limit: 20, windowSeconds: 600 },
  { name: 'identity.public-profile.photo.tenant', scope: 'tenant', limit: 100, windowSeconds: 3_600 },
];

/** S15-F10: the signed-in member's own published portal profile. */
export async function publicProfileRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/me/public-profile',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.getMyPublicProfile',
        summary: 'Your portal profile (what you publish on inmolink.es); unpublished until you choose to publish it',
        response: { 200: MemberPublicProfileDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => identity.getMyPublicProfile(ctx)),
  );

  app.put(
    '/v1/me/public-profile',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.updateMyPublicProfile',
        summary:
          'Save your portal profile (optimistic `version`, 0 for the first save) and choose to publish it or not',
        body: UpdateMemberPublicProfileBody,
        response: { 200: MemberPublicProfileDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => identity.updateMyPublicProfile(ctx, req.body)),
  );

  app.delete(
    '/v1/me/public-profile/photo',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.removeMyPublicProfilePhoto',
        summary: 'Remove your portal profile photo',
        response: { 200: MemberPublicProfileDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => identity.removeMyPublicProfilePhoto(app.ctxRunner(req)),
  );

  await app.register(photoUploadRoute);
}

/**
 * The photo upload, in its own plugin: its body is the raw image (up to 900 KB). The declared type only routes the body
 * here; the service checks the real type by magic bytes.
 */
async function photoUploadRoute(upload: FastifyZod): Promise<void> {
  upload.addContentTypeParser(
    [...MEMBER_PHOTO_TYPES, 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MEMBER_PHOTO_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  upload.put(
    '/v1/me/public-profile/photo',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.uploadMyPublicProfilePhoto',
        summary: 'Replace your portal profile photo (raw PNG/JPEG/WebP body, max 900 KB); save the profile first',
        response: { 200: MemberPublicProfileDto },
      },
      bodyLimit: MEMBER_PHOTO_MAX_BYTES,
      onRequest: [upload.requireSession],
      config: { rateLimit: PHOTO_LIMITS },
    },
    async (req) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
      const body = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
      return identity.uploadMyPublicProfilePhoto(upload.ctxRunner(req), { body });
    },
  );
}
