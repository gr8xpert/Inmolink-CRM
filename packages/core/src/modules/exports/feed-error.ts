/**
 * A portal feed run that failed for good (S9-03): no retry helps, so the job fails unrecoverably and the run is
 * recorded with the code. `TOO_LARGE`: the gzip file passed the 64 MiB cap. `WRITER_DROPPED`: the writer refused a
 * listing the validator passed (a bug, never a silent loss).
 */
export class PortalFeedError extends Error {
  constructor(readonly code: 'TOO_LARGE' | 'WRITER_DROPPED') {
    super(`portal feed: ${code}`);
    this.name = 'PortalFeedError';
  }
}
