/** Per-route request duration (seconds), recorded by the server plumbing (platform/server `observeRequests`). */
export const HTTP_DURATION_METRIC = 'http.server.request.duration';

/**
 * S11 review: seconds a job waited in its pool's queue past its due time (enqueue + requested delay), recorded by the
 * worker when its first attempt starts running — over-cap bounces count as waiting, retries' backoff does not. By
 * `pool`. Prometheus: `inmolink_queue_wait_seconds` (alerts in infra/monitoring/rules/queues.yml).
 */
export const QUEUE_WAIT_METRIC = 'inmolink.queue.wait_seconds';

/** Its buckets (seconds): the delivery pools' 30 s target and the slower pools' minutes both resolve. */
export const QUEUE_WAIT_BUCKETS_S = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 900, 1800, 3600];
