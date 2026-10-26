import {
  AuditLogPage,
  CreateDataExportBody,
  CreateDataExportHeaders,
  DataExportDto,
  DataExportPage,
  DataExportParams,
  GetDataExportQuery,
  PageQuery,
  StaffAuditPage,
  StaffAuditQuery,
} from '@inmolink/contracts';
import { listStaffAuditLog, requestDataExport } from '@inmolink/core';
import * as compliance from '@inmolink/core/modules/compliance';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'compliance.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'compliance.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
/** S10-08: an export is a heavy job — a few per hour per user is plenty (and one runs per agency at a time). */
const EXPORT_CREATE_LIMITS: readonly RateLimitRule[] = [
  { name: 'compliance.export.ip', scope: 'ip', limit: 30, windowSeconds: 3_600 },
  { name: 'compliance.export.user', scope: 'user', limit: 10, windowSeconds: 3_600 },
];
/** S10-08: one export's status and download links (each link audited): tighter than the other reads. */
const EXPORT_GET_LIMITS: readonly RateLimitRule[] = [
  { name: 'compliance.export.get.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'compliance.export.get.user', scope: 'user', limit: 30, windowSeconds: 60 },
];
const STAFF_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.audit.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'staff.audit.user', scope: 'user', limit: 120, windowSeconds: 60 },
];

/**
 * compliance dashboard routes (PATTERNS §10): the agency's audit log (S1-08), the staff viewer (S1-09) and the data
 * export (S10-08: create, list, get with a short signed download link — admins only, `no-store`).
 */
export async function complianceRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/agency/audit-log',
    {
      schema: {
        tags: ['compliance'],
        operationId: 'compliance.listAuditLog',
        summary: 'The agency’s audit log — logins, 2FA, roles, API keys, verification — newest first (admins)',
        querystring: PageQuery,
        response: { 200: AuditLogPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => compliance.listAuditLog(ctx, req.query)),
  );

  app.post(
    '/v1/agency/data-exports',
    {
      schema: {
        tags: ['compliance'],
        operationId: 'compliance.createDataExport',
        summary:
          'Export contacts, leads or listings as CSV / Excel, or the whole account as a ZIP (admins; runs as a job). With an Idempotency-Key, a retry within 24 h answers the first export (200)',
        headers: CreateDataExportHeaders,
        body: CreateDataExportBody,
        response: { 201: DataExportDto, 200: DataExportDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: EXPORT_CREATE_LIMITS },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      // S11-F14: the second-factor step-up is part of the service (policy, replay, 409, then the code).
      const result = await app.withCtx(req, (ctx) =>
        requestDataExport(ctx, req.body, idempotencyKey ? { idempotencyKey } : {}),
      );
      return reply.code(result.replayed ? 200 : 201).send(result.export);
    },
  );

  app.get(
    '/v1/agency/data-exports',
    {
      schema: {
        tags: ['compliance'],
        operationId: 'compliance.listDataExports',
        summary: 'The agency’s data exports, newest first (admins)',
        querystring: PageQuery,
        response: { 200: DataExportPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => compliance.listDataExports(ctx, req.query)),
  );

  app.get(
    '/v1/agency/data-exports/:id',
    {
      schema: {
        tags: ['compliance'],
        operationId: 'compliance.getDataExport',
        summary:
          'One data export; with download=1, a short-lived signed download link while it is available (admins; audited)',
        params: DataExportParams,
        querystring: GetDataExportQuery,
        response: { 200: DataExportDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: EXPORT_GET_LIMITS },
    },
    async (req, _reply) => {
      return app.withCtx(req, (ctx) =>
        compliance.getDataExport(ctx, req.params.id, { download: req.query.download === '1' }),
      );
    },
  );

  app.get(
    '/v1/staff/audit-logs',
    {
      schema: {
        tags: ['staff'],
        operationId: 'compliance.listAuditLogForStaff',
        summary: 'Every agency’s audit log (or one), newest first, with both actors; the read is audited',
        querystring: StaffAuditQuery,
        response: { 200: StaffAuditPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    async (req, _reply) => {
      return app.withStaffCtx(req, 'compliance.listAuditLogForStaff', (ctx) => listStaffAuditLog(ctx, req.query));
    },
  );
}
