import type { Ctx } from '../../context';

/**
 * billing use cases (PATTERNS §7): `(ctx: Ctx, input) → DTO`. Authorize with `assertCan`, read and
 * write through `./repo`, emit outbox events in the same transaction, never call the network.
 */

/**
 * Seat check before a new member is added (S1-02). `used` counts active members plus open invites;
 * the caller counts them, since billing never reads another module's tables. A stub until plans and
 * seats exist (S13): every agency has unlimited seats. S13 makes it throw `PLAN_REQUIRED` when
 * `used + 1` exceeds the plan's seats.
 */
export async function assertSeat(_ctx: Ctx, _seats: { used: number }): Promise<void> {}
