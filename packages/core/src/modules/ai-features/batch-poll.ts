/**
 * S14-F4: the one poll step shared by the Listing Studio and white-label batch-collect jobs. The provider's batch
 * answers within a day, so each poll asks the collector once (telling it to give up after `maxPolls`) and, while
 * the batch is still running, re-enqueues the next poll with a delay.
 */
export async function pollBatch<P extends { poll: number }, R extends { status: string }>(opts: {
  payload: P;
  maxPolls: number;
  delayMs: number;
  /** Ask the provider; `giveUp` is true once this poll is past `maxPolls`. */
  collect: (giveUp: boolean) => Promise<R>;
  /** Queue the next poll (a delayed job with the poll number bumped). */
  enqueue: (next: P, opts: { delayMs: number }) => Promise<unknown>;
}): Promise<R> {
  const res = await opts.collect(opts.payload.poll > opts.maxPolls);
  if (res.status === 'IN_PROGRESS') {
    await opts.enqueue({ ...opts.payload, poll: opts.payload.poll + 1 }, { delayMs: opts.delayMs });
  }
  return res;
}
