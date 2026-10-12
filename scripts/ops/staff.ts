// pnpm staff:grant --email <email> --role <SUPER_ADMIN|STAFF_SUPPORT|STAFF_DATA_OPS> --reason <text> [--test]
// pnpm staff:revoke --email <email> --reason <text> [--test]
//
// Grants or withdraws Inmolink staff access (S1-03, ADR 0015). The account must exist, be confirmed
// and belong to no agency (staff have none). Staff sign in like anyone else; their access token has no
// agency, and the staff API checks `staff_users` on every request, so a revoke applies at once.
import { parseArgs } from 'node:util';
import * as identity from '@inmolink/core/modules/identity';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { readStackEnv } from './stack-env';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    test: { type: 'boolean', default: false },
    email: { type: 'string' },
    role: { type: 'string' },
    reason: { type: 'string' },
  },
});

// Locally, read the stack's env file (dev or --test) unless real credentials are already set.
if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
}
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'ops:staff', level: process.env.LOG_LEVEL });

try {
  const command = positionals[0];
  if (command !== 'grant' && command !== 'revoke')
    throw new TypeError('usage: staff.ts grant|revoke --email … --reason …');
  if (!values.email) throw new TypeError('--email is required');
  // The grant or revocation is an audit_logs row (S1-08, same transaction; it records that a reason was
  // given). Who asked and why goes to the withSystem log line.
  if (!values.reason || values.reason.trim().length < 3) throw new TypeError('--reason is required');
  await configureDb(loadConfigOrExit(dbEnv));
  const reason = `ops.staff.${command}: ${values.reason.trim()}`;
  if (command === 'grant') {
    const role = values.role as identity.StaffRole | undefined;
    if (!role || !identity.STAFF_ROLES.includes(role)) {
      throw new TypeError(`--role must be one of ${identity.STAFF_ROLES.join(', ')}`);
    }
    const { userId } = await withSystem(reason, (tx) => identity.grantStaff(tx, { email: values.email ?? '', role }));
    log.info({ userId, role }, 'staff access granted');
  } else {
    const revoked = await withSystem(reason, (tx) => identity.revokeStaff(tx, { email: values.email ?? '' }));
    log.info({ revoked }, revoked ? 'staff access withdrawn' : 'no active staff access for that email');
  }
} catch (err) {
  // AppError details say why (NOT_FOUND user, FORBIDDEN agency_member) without echoing the email.
  log.error({ err }, 'staff command failed');
  process.exitCode = 1;
} finally {
  await closeDb();
}
