import { describe, expect, it } from 'vitest';
import { MATCH_GLOBAL_CONCURRENCY, networkJobs } from '../jobs';

/** Job definitions of the network board (no queue, no DB): their caps and keys. */
describe('network jobs', () => {
  it('[S12-F5] buyer-request matching is capped pool-wide (4 at once) so it cannot crowd out website search', () => {
    expect(MATCH_GLOBAL_CONCURRENCY).toBe(4);
    expect(networkJobs.matchBuyerRequest.spec.globalConcurrency).toBe(MATCH_GLOBAL_CONCURRENCY);
    // the per-agency cap stays: one agency's burst does not take the four slots
    expect(networkJobs.matchBuyerRequest.spec.concurrencyPerGroup).toBe(2);
    expect(networkJobs.matchBuyerRequest.pool).toBe('matching');
  });

  it('[S12-F12] the close-threads job runs once more a minute later under its own job ID', () => {
    const p = { postId: '0195f0a5-0000-7000-8000-000000000001', agencyId: '0195f0a5-0000-7000-8000-000000000002' };
    const jobId = networkJobs.closePostThreads.spec.jobId;
    expect(jobId?.(p)).toBe(`network.closeThreads:${p.postId}`);
    expect(jobId?.({ ...p, recheck: true })).toBe(`network.closeThreads:${p.postId}:recheck`);
  });
});
