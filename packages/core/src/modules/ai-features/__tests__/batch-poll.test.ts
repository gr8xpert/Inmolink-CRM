import { describe, expect, it, vi } from 'vitest';
import { pollBatch } from '../batch-poll';

const run = (poll: number, status: string) => {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const collect = vi.fn().mockResolvedValue({ status });
  return { enqueue, collect, p: pollBatch({ payload: { id: 'x', poll }, maxPolls: 3, delayMs: 5, collect, enqueue }) };
};

describe('pollBatch', () => {
  it('[S14-F4] re-enqueues the next poll with the delay while the batch is running', async () => {
    const r = run(2, 'IN_PROGRESS');
    expect(await r.p).toEqual({ status: 'IN_PROGRESS' });
    expect(r.collect).toHaveBeenCalledWith(false);
    expect(r.enqueue).toHaveBeenCalledWith({ id: 'x', poll: 3 }, { delayMs: 5 });
  });
  it('[S14-F4] tells the collector to give up past the poll limit', async () => {
    const r = run(4, 'DONE');
    await r.p;
    expect(r.collect).toHaveBeenCalledWith(true);
    expect(r.enqueue).not.toHaveBeenCalled();
  });
});
