import { ErrorBody, PluginPackageParams, PluginUpdateInfo } from '@inmolink/contracts';
import * as pluginUpdates from '@inmolink/core/modules/plugin-updates';
import { cacheControl, etagFor } from '@inmolink/platform/http';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';
import { edgePublic, publicCacheControl, ruleOf } from '../../plugins/edge-cache';
import { sendConditional } from '../../plugins/site-response';

/** Every WordPress site checks about twice a day; one IP serves many sites on shared hosting. */
const UPDATE_LIMITS: readonly RateLimitRule[] = [
  { name: 'plugin.update.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
];
const PACKAGE_LIMITS: readonly RateLimitRule[] = [
  { name: 'plugin.package.ip', scope: 'ip', limit: 30, windowSeconds: 60 },
];

/**
 * WordPress plugin update server (S8-05, PLAN §9.4): the latest release's metadata and its signed package. Public (no
 * API key: the package is the GPL plugin anyway; integrity comes from the Ed25519 signature the plugin verifies, not
 * from this channel). Thin: one core call each.
 */
export async function pluginUpdateRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v2/plugin/update',
    {
      schema: {
        tags: ['wp-plugin'],
        operationId: 'websiteV2.getPluginUpdate',
        summary: 'The latest WordPress plugin release: version, requirements, package path, SHA-256 and signature',
        response: {
          200: PluginUpdateInfo,
          304: z.null().describe('Not modified (`If-None-Match`)'),
          404: ErrorBody.describe('PLUGIN_RELEASE_NOT_FOUND: nothing published yet'),
        },
      },
      config: { rateLimit: UPDATE_LIMITS },
    },
    async (req, reply) => {
      const info = await pluginUpdates.latestPluginRelease();
      const etag = etagFor(`${info.version}:${info.sha256}`);
      const notModified = sendConditional(req, reply, {
        etag,
        // Public (`EDGE_CACHE_RULES`) unless the URL carries a query string (another CDN entry for the same answer).
        cacheControl: edgePublic(req) ? publicCacheControl(ruleOf(req)) : cacheControl.private(0),
        vary: 'Accept-Encoding',
      });
      if (notModified) return reply;
      return info;
    },
  );

  app.get(
    '/v2/plugin/package/:version',
    {
      schema: {
        tags: ['wp-plugin'],
        operationId: 'websiteV2.getPluginPackage',
        summary: 'A WordPress plugin release zip (immutable; verify its signature from `/v2/plugin/update`)',
        params: PluginPackageParams,
        response: {
          200: z.string().describe('application/zip'),
          304: z.null().describe('Not modified (`If-None-Match`)'),
          404: ErrorBody.describe('PLUGIN_RELEASE_NOT_FOUND: no such version'),
        },
      },
      config: { rateLimit: PACKAGE_LIMITS },
    },
    async (req, reply) => {
      const { manifest, body } = await pluginUpdates.pluginPackage(req.params.version);
      const etag = `"${manifest.sha256}"`;
      reply
        .header('Content-Disposition', `attachment; filename="inmolink-${manifest.version}.zip"`)
        .header('X-Content-Type-Options', 'nosniff');
      const notModified = sendConditional(req, reply, {
        etag,
        cacheControl: edgePublic(req) ? publicCacheControl(ruleOf(req)) : cacheControl.private(0),
      });
      if (notModified) {
        body.destroy();
        return reply;
      }
      // Streams are sent as they are (the response schema documents the zip; it never serializes a stream).
      return reply
        .type('application/zip')
        .header('Content-Length', manifest.sizeBytes)
        .send(body as unknown as string);
    },
  );
}
