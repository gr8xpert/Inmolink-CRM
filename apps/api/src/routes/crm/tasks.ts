import {
  CreateContactHeaders,
  CreateTaskBody,
  ListTasksQuery,
  TaskDeletedDto,
  TaskDto,
  TaskPage,
  TaskParams,
  UpdateTaskBody,
} from '@inmolink/contracts';
import * as crm from '@inmolink/core/modules/crm';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.tasks.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'crm.tasks.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.tasks.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'crm.tasks.write.user', scope: 'user', limit: 120, windowSeconds: 60 },
  { name: 'crm.tasks.write.tenant', scope: 'tenant', limit: 5_000, windowSeconds: 3_600 },
];

const tags = ['crm'];

/** CRM tasks and reminders (S10-05). Registered inside `crmRoutes` (its `no-store` hook applies). */
export async function crmTaskRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/crm/tasks',
    {
      schema: {
        tags,
        operationId: 'crm.listTasks',
        summary:
          'Tasks soonest due first (undated last): the caller’s by default (assignee=me|any|<user id>), status OPEN|DONE, due range, subject filters',
        querystring: ListTasksQuery,
        response: { 200: TaskPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listTasks(ctx, req.query)),
  );

  app.get(
    '/v1/crm/tasks/:id',
    {
      schema: {
        tags,
        operationId: 'crm.getTask',
        summary: 'One task',
        params: TaskParams,
        response: { 200: TaskDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.getTask(ctx, req.params.id)),
  );

  app.post(
    '/v1/crm/tasks',
    {
      schema: {
        tags,
        operationId: 'crm.createTask',
        summary:
          'Create a task about a contact, lead or listing, with a due date, an assignee and an e-mail reminder (201). With an Idempotency-Key, a retry within 24 h answers the first task (200)',
        headers: CreateContactHeaders,
        body: CreateTaskBody,
        response: { 201: TaskDto, 200: TaskDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await app.withCtx(req, (ctx) =>
        crm.createTask(ctx, req.body, idempotencyKey ? { idempotencyKey } : {}),
      );
      return reply.code(result.replayed ? 200 : 201).send(result.task);
    },
  );

  app.patch(
    '/v1/crm/tasks/:id',
    {
      schema: {
        tags,
        operationId: 'crm.updateTask',
        summary: 'Change, complete or reopen a task (version); a new due date re-arms the reminder',
        params: TaskParams,
        body: UpdateTaskBody,
        response: { 200: TaskDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.updateTask(ctx, req.params.id, req.body)),
  );

  app.delete(
    '/v1/crm/tasks/:id',
    {
      schema: {
        tags,
        operationId: 'crm.deleteTask',
        summary: 'Delete a task (it no longer reminds)',
        params: TaskParams,
        response: { 200: TaskDeletedDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req) => {
      await app.withCtx(req, (ctx) => crm.deleteTask(ctx, req.params.id));
      return { deleted: true as const };
    },
  );
}
