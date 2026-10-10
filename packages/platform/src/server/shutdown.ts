import type { Logger } from '../logger';

export interface ShutdownStep {
  name: string;
  run: () => Promise<void>;
}

export interface ShutdownOptions {
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /**
   * In order: stop intake (drain HTTP / close workers, which wait for in-flight work), then close
   * clients (queue, cache, db). A failing step is logged and the rest still run.
   */
  steps: readonly ShutdownStep[];
  /** Hard deadline (default 30 s, PLAN §5.3): after it the process exits 1 and stalled jobs are retried. */
  timeoutMs?: number;
  /** Signals to handle (default SIGTERM, SIGINT). Pass `[]` in tests and call `shutdown()` directly. */
  signals?: readonly NodeJS.Signals[];
  exit?: (code: number) => void;
}

export interface Shutdown {
  /** Idempotent: a second signal waits for the same run. */
  shutdown(reason: string): Promise<void>;
  /** Removes the signal handlers (tests). */
  dispose(): void;
}

/** Graceful shutdown for every Node app: drain within the deadline, then exit. */
export function gracefulShutdown(options: ShutdownOptions): Shutdown {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.logger;
  let running: Promise<void> | undefined;

  const shutdown = (reason: string): Promise<void> => {
    running ??= (async () => {
      const started = Date.now();
      log.info({ reason, timeoutMs }, 'shutting down');
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        log.error({ reason, timeoutMs }, 'shutdown deadline passed; exiting');
        exit(1);
      }, timeoutMs);
      let failed = false;
      for (const step of options.steps) {
        if (timedOut) return;
        try {
          await step.run();
        } catch (err) {
          failed = true;
          log.warn({ err, step: step.name }, 'shutdown step failed');
        }
      }
      clearTimeout(deadline);
      if (timedOut) return;
      log.info({ ms: Date.now() - started }, 'shutdown complete');
      exit(failed ? 1 : 0);
    })();
    return running;
  };

  const handlers = (options.signals ?? ['SIGTERM', 'SIGINT']).map((signal) => {
    const handler = () => void shutdown(signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });

  return {
    shutdown,
    dispose: () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}
