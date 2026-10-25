import { type Tx, withSystem } from '@inmolink/db';
import { type EmailMessage, mailer } from '@inmolink/platform/email';
import { emit, type OutboxMessage } from '@inmolink/platform/outbox';
import { wasNotSent } from '../../email-text';
import * as agencies from '../agencies';
import * as identity from '../identity';

/**
 * The reminder machinery tasks (S10-05) and calendar events (S10-06) share (S11-F11): one sweep loop and one send flow,
 * so the at-most-once guarantee is written once. A caller supplies the table-specific statements (its repo's claim and
 * send-claim SQL) and the rendering; the helper owns the loop, the batching limits and the failure policy.
 *
 * - **Sweep.** Batches of `batch` rows, at most `perAgency` of one agency per batch (a backlog in one agency never takes
 *   the whole batch), up to `maxBatches` per pass. Each batch is one system transaction: the repo's claim
 *   (`for update skip locked`, so concurrent sweeps take different rows) and the outbox events commit together.
 * - **Send.** Claims the send in the database first (the "sent-for" marker, written as the system role with the agency
 *   named), looks the recipient up, sends outside any transaction with the provider's idempotency key, and gives the
 *   claim back only after a failure known to precede the send (a refused message, a 4xx refusal, a failed lookup).
 *   After a timeout, a 5xx or a dropped connection it is unknown whether the mail went, so the claim stays: that
 *   reminder may be lost (at most once), never doubled.
 */

export const REMINDER_SWEEP = { batch: 200, perAgency: 50, maxBatches: 25 } as const;

/** Failures known to precede the send: a message the adapter refused, a provider 4xx refusal. */

/** The sweep loop: returns every row claimed. `claim` runs inside the batch transaction and gets the batch limits. */
export async function sweepReminders<R extends { agencyId: string }>(opts: {
  /** Audit reason of the system transactions (`crm.sweepTaskReminders`). */
  job: string;
  now?: Date;
  signal?: AbortSignal;
  claim: (tx: Tx, now: Date, limits: { batch: number; perAgency: number }) => Promise<R[]>;
  events: (row: R) => OutboxMessage;
}): Promise<R[]> {
  const now = opts.now ?? new Date();
  const claimed: R[] = [];
  for (let i = 0; i < REMINDER_SWEEP.maxBatches; i++) {
    if (opts.signal?.aborted) break;
    const batch = await withSystem(opts.job, async (tx) => {
      const rows = await opts.claim(tx, now, REMINDER_SWEEP);
      await emit(tx, rows.map(opts.events));
      return rows;
    });
    claimed.push(...batch);
    // a batch can be short because of the per-agency share: stop only when nothing is left
    if (batch.length === 0) break;
  }
  return claimed;
}

/** The send flow: see the header. `claim` returns what to send, or null when there is nothing to send. */
export async function sendReminder<T>(opts: {
  /** Audit reason prefix of the system transactions (`crm.sendTaskReminder`). */
  job: string;
  agencyId: string;
  claim: (tx: Tx) => Promise<T | null>;
  recipientUserId: (claimed: T) => string;
  /** `timeZone`: the agency's (S11-F11), for the times in the message. */
  render: (claimed: T, to: { email: string; name: string; locale: string }, timeZone: string) => EmailMessage;
  idempotencyKey: string;
  release: (tx: Tx) => Promise<unknown>;
}): Promise<{ sent: boolean }> {
  const claimed = await withSystem(`${opts.job} claim`, opts.claim);
  if (!claimed) return { sent: false };
  let beforeSend = true;
  try {
    const { to, timeZone } = await withSystem(`${opts.job} recipient`, async (tx) => ({
      to: await identity.memberRecipient(tx, opts.agencyId, opts.recipientUserId(claimed)),
      timeZone: await agencies.agencyTimeZone(tx, opts.agencyId),
    }));
    if (!to) return { sent: false };
    // rendered before the point of no return: a rendering failure gives the claim back
    const message = opts.render(claimed, to, timeZone);
    beforeSend = false;
    await mailer().send({ ...message, idempotencyKey: opts.idempotencyKey });
    return { sent: true };
  } catch (err) {
    if (beforeSend || wasNotSent(err)) await withSystem(`${opts.job} release`, opts.release);
    throw err;
  }
}
