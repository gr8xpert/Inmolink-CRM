import { createHash } from 'node:crypto';
import { CalendarFeedParams, ErrorBody } from '@inmolink/contracts';
import * as crm from '@inmolink/core/modules/crm';
import { cacheControl } from '@inmolink/platform/http';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { acceptsGzip, sendConditional } from '../../plugins/site-response';

export const CALENDAR_FEED_ROUTE = '/v2/calendars/:token/calendar.ics';

/**
 * Calendar apps poll (Google every few hours, Outlook at the feed's refresh hint): per IP, and per token (scope `key`:
 * `calendarTokenIdentity`) — a leaked URL cannot be used to load the origin.
 */
export const CALENDAR_FEED_LIMITS: readonly RateLimitRule[] = [
  { name: 'calendar.ics.ip', scope: 'ip', limit: 60, windowSeconds: 60 },
  { name: 'calendar.ics.token', scope: 'key', limit: 120, windowSeconds: 3_600 },
];

/** The rate-limit identity of a calendar feed request: a hash of its token (never the token). */
export function calendarTokenIdentity(req: FastifyRequest): string | undefined {
  if (req.routeOptions.url !== CALENDAR_FEED_ROUTE) return undefined;
  const token = (req.params as { token?: unknown } | undefined)?.token;
  if (typeof token !== 'string') return undefined;
  return `calendar:${createHash('sha256').update(token).digest('base64url').slice(0, 22)}`;
}

const CalendarFeedQuery = z.strictObject({
  /** The UI language of the type names and the attendees line (the dashboard adds the member's). */
  lang: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
});

export const CalendarIcs = z.string().describe('The member’s calendar, `text/calendar; charset=utf-8` (RFC 5545)');

/**
 * A member's ICS feed (S10-06): `GET /v2/calendars/{token}/calendar.ics` — the events the member attends, for Google
 * Calendar / Outlook subscriptions. The token is the credential (per member, stored as its keyed hash, redacted from logs
 * and traces): unknown, rotated and revoked tokens and deactivated members answer the same 404. Thin: one core call (one
 * statement, a SECURITY DEFINER lookup). Personal data, so never in a shared cache: `private, max-age=300` with a strong
 * ETag per encoding (`If-None-Match` → 304) — a change reaches the app at its next poll, a revoked URL stops at once.
 * Gzip when the client takes it. Never indexed.
 */
export async function calendarFeedRoutes(app: FastifyZod): Promise<void> {
  app.get(
    CALENDAR_FEED_ROUTE,
    {
      schema: {
        tags: ['calendar'],
        operationId: 'calendar.getFeed',
        summary: 'A member’s ICS calendar feed (subscription URL). The token URL is the credential',
        params: CalendarFeedParams,
        querystring: CalendarFeedQuery,
        response: {
          200: CalendarIcs,
          304: z.null().describe('Not modified (`If-None-Match`)'),
          404: ErrorBody.describe(
            'CALENDAR_FEED_NOT_FOUND: unknown, rotated or revoked token, or a deactivated member',
          ),
        },
      },
      config: { rateLimit: CALENDAR_FEED_LIMITS },
    },
    async (req, reply) =>
      sendIcs(req, reply, await crm.calendarFeed(req.params.token, req.query.lang ? { locale: req.query.lang } : {})),
  );
}

/** The ICS answer: never indexed, private to the client, a strong ETag per encoding, gzip when taken. */
function sendIcs(req: FastifyRequest, reply: FastifyReply, file: crm.CalendarFeedFile) {
  const gzip = acceptsGzip(req);
  reply
    .header('X-Robots-Tag', 'noindex, nofollow')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff');
  const etag = gzip ? `${file.etag.slice(0, -1)}.gz"` : file.etag;
  if (
    sendConditional(req, reply, {
      etag,
      cacheControl: cacheControl.private(crm.CALENDAR_FEED_MAX_AGE_S),
      vary: 'Accept-Encoding',
    })
  ) {
    return reply;
  }
  reply.type('text/calendar; charset=utf-8');
  // compressed by the core, off the event loop; a Buffer is sent as it is (never serialized)
  if (gzip) return reply.header('Content-Encoding', 'gzip').send(file.gzip);
  return reply.send(Buffer.from(file.body, 'utf8'));
}
