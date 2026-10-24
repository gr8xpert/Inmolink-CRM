import {
  CalendarEventDto,
  CalendarEventPage,
  CalendarEventParams,
  CalendarFeedDto,
  CalendarFeedSecretDto,
  CreateCalendarEventBody,
  CreateContactHeaders,
  ListCalendarEventsQuery,
  UpdateCalendarEventBody,
} from '@inmolink/contracts';
import * as crm from '@inmolink/core/modules/crm';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.calendar.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'crm.calendar.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.calendar.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'crm.calendar.write.user', scope: 'user', limit: 120, windowSeconds: 60 },
  { name: 'crm.calendar.write.tenant', scope: 'tenant', limit: 5_000, windowSeconds: 3_600 },
];
/** A feed URL is a credential: few rotations per member. */
const FEED_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.calendar.feed.ip', scope: 'ip', limit: 30, windowSeconds: 60 },
  { name: 'crm.calendar.feed.user', scope: 'user', limit: 10, windowSeconds: 3_600 },
];

const tags = ['crm'];

/** CRM calendar and the member's ICS feed (S10-06). Registered inside `crmRoutes` (its `no-store` hook applies). */
export async function crmCalendarRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/crm/calendar/events',
    {
      schema: {
        tags,
        operationId: 'crm.listCalendarEvents',
        summary:
          'Events overlapping [from, to) (≤ 62 days), soonest first: the caller’s by default (attendee=me|any|<user id>), cancelled ones included',
        querystring: ListCalendarEventsQuery,
        response: { 200: CalendarEventPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listCalendarEvents(ctx, req.query)),
  );

  app.get(
    '/v1/crm/calendar/events/:id',
    {
      schema: {
        tags,
        operationId: 'crm.getCalendarEvent',
        summary: 'One calendar event with its attendees',
        params: CalendarEventParams,
        response: { 200: CalendarEventDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.getCalendarEvent(ctx, req.params.id)),
  );

  app.post(
    '/v1/crm/calendar/events',
    {
      schema: {
        tags,
        operationId: 'crm.createCalendarEvent',
        summary:
          'Schedule a viewing, meeting or call the caller organizes, with member and contact attendees and an e-mail reminder (201). With an Idempotency-Key, a retry within 24 h answers the first event (200)',
        headers: CreateContactHeaders,
        body: CreateCalendarEventBody,
        response: { 201: CalendarEventDto, 200: CalendarEventDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await app.withCtx(req, (ctx) =>
        crm.createCalendarEvent(ctx, req.body, idempotencyKey ? { idempotencyKey } : {}),
      );
      return reply.code(result.replayed ? 200 : 201).send(result.event);
    },
  );

  app.patch(
    '/v1/crm/calendar/events/:id',
    {
      schema: {
        tags,
        operationId: 'crm.updateCalendarEvent',
        summary:
          'Change, reschedule, cancel or restore an event (version); attendee lists replace the current ones; a new time re-arms the reminder',
        params: CalendarEventParams,
        body: UpdateCalendarEventBody,
        response: { 200: CalendarEventDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.updateCalendarEvent(ctx, req.params.id, req.body)),
  );

  app.get(
    '/v1/crm/calendar/feed',
    {
      schema: {
        tags,
        operationId: 'crm.getCalendarFeed',
        summary: 'Whether the caller’s ICS subscription URL is on (never the token, only its last characters)',
        response: { 200: CalendarFeedDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.getCalendarFeed(ctx)),
  );

  app.post(
    '/v1/crm/calendar/feed',
    {
      schema: {
        tags,
        operationId: 'crm.rotateCalendarFeed',
        summary: 'A new ICS subscription URL for the caller (shown once; the previous one stops working at once)',
        response: { 201: CalendarFeedSecretDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: FEED_LIMITS },
    },
    async (req, reply) => reply.code(201).send(await app.withCtx(req, (ctx) => crm.rotateCalendarFeed(ctx))),
  );

  app.delete(
    '/v1/crm/calendar/feed',
    {
      schema: {
        tags,
        operationId: 'crm.revokeCalendarFeed',
        summary: 'Turn the caller’s ICS subscription URL off (it stops working at once)',
        response: { 200: CalendarFeedDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: FEED_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.revokeCalendarFeed(ctx)),
  );
}
