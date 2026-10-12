/**
 * @inmolink/platform/tenancy — tenancy constants shared by the outbox, the RLS generator and the
 * tenant registry. A leaf module on purpose: `packages/db` reads it without pulling the dispatcher or
 * telemetry into the RLS CLI.
 */

/**
 * `agency_id` of platform-wide rows (no tenant): outbox events emitted outside any agency, platform audit
 * rows. Only `withSystem()` (and the narrow `app_auth` append policies) can write it; RLS rejects it
 * elsewhere. Defined once — `tests/workspace/platform-agency-id.test.ts` fails if the literal appears
 * anywhere else, so `emit()` and the policies can never disagree on it.
 */
export const PLATFORM_AGENCY_ID = '00000000-0000-0000-0000-000000000000';
