import { type DashboardSection, MemberRole, type MyCapabilitiesDto } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { impersonatorOf } from '../../impersonation';
import * as agencies from '../agencies';
import * as developments from '../developments';
import * as identity from '../identity';
import * as imports from '../imports';
import * as properties from '../properties';
import * as search from '../search';
import * as websites from '../websites';

/**
 * Which dashboard areas each module's policy opens to the caller (S1-10). A section is listed when the
 * caller may at least read it — Client Mode and impersonation already narrow the answers inside `can`.
 */
const SECTION_RULES: ReadonlyArray<readonly [DashboardSection, (ctx: Ctx) => boolean]> = [
  ['listings', (ctx) => properties.can(ctx, 'listing.read')],
  // Network search (S5-05): agent side only (owner agencies, commission) — never Client Mode.
  ['network', (ctx) => search.can(ctx, 'search.network')],
  // The agency's own developments: the members who maintain them (not partners, not Client Mode).
  ['developments', (ctx) => developments.can(ctx, 'development.create')],
  // Feed imports (S6-01): the agency's members who follow them (not partners, not Client Mode).
  ['imports', (ctx) => imports.can(ctx, 'imports.read')],
  ['team', (ctx) => identity.can(ctx, 'identity.members.read')],
  // Website sites (S7-01): the agency's members (admins change them; not partners, not Client Mode).
  ['websites', (ctx) => websites.can(ctx, 'websites.read')],
  ['apiKeys', (ctx) => identity.can(ctx, 'identity.apiKeys.read')],
  ['profile', (ctx) => agencies.can(ctx, 'agencies.profile.update')],
  ['settings', (ctx) => agencies.can(ctx, 'agencies.settings.read')],
  ['verification', (ctx) => agencies.can(ctx, 'agencies.verification.read')],
  ['preferredAgencies', (ctx) => agencies.can(ctx, 'agencies.preferred.read')],
  ['staffAccess', (ctx) => identity.can(ctx, 'identity.staffAccess.read')],
];

/**
 * `GET /v1/me/capabilities` (S1-10): the caller's role and the dashboard sections they may open. Pure
 * policy over `ctx` (role, Client Mode and impersonation were read when `ctx` was built): no query.
 */
export function getMyCapabilities(ctx: Ctx): MyCapabilitiesDto {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  return {
    role: MemberRole.parse(ctx.actor.role),
    clientMode: ctx.clientMode,
    impersonating: impersonatorOf(ctx) !== null,
    sections: SECTION_RULES.filter(([, allowed]) => allowed(ctx)).map(([section]) => section),
  };
}
