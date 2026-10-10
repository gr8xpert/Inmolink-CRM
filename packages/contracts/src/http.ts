import { z } from 'zod';
import { type ErrorCode, ErrorCodes } from './errors';

const codes = Object.keys(ErrorCodes) as [ErrorCode, ...ErrorCode[]];

/** Every non-2xx JSON response: `{ error: { code, message, details? } }` (api.md). Clients branch on `code`. */
export const ErrorBody = z.object({
  error: z.object({
    code: z.enum(codes),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** `/healthz` and `/readyz`. Check results only — failure reasons are logged, never returned. */
export const HealthBody = z.object({
  status: z.enum(['ok', 'fail', 'draining']),
  checks: z.record(z.string(), z.enum(['ok', 'fail'])).optional(),
});
export type HealthBody = z.infer<typeof HealthBody>;
