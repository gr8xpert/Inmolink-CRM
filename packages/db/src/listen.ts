import pg from 'pg';
import { assertSystemAllowed, dbConfig, dbLogger } from './client';

const CHANNEL = /^[a-z_][a-z0-9_]{0,62}$/;

export interface Listener {
  close(): Promise<void>;
}

export interface ListenOptions {
  /** Direct (non-PgBouncer) URL. Defaults to `DATABASE_URL_LISTEN`. */
  url?: string;
  /** First reconnect delay; doubles up to 30 s. */
  retryMs?: number;
}

/**
 * LISTEN on a dedicated session connection. PgBouncer in transaction mode cannot hold LISTEN,
 * so this connects straight to Postgres (`DATABASE_URL_LISTEN`, workers only). Reconnects with
 * backoff and calls `onNotify` after every (re)connect, because notifications sent while
 * disconnected are lost — callers treat a notification as "go look", never as the data itself.
 */
export async function listen(channel: string, onNotify: () => void, options: ListenOptions = {}): Promise<Listener> {
  assertSystemAllowed(); // the LISTEN URL is a worker credential, refused in request paths
  if (!CHANNEL.test(channel)) throw new TypeError(`listen: invalid channel name ${JSON.stringify(channel)}`);
  const url = options.url ?? dbConfig().DATABASE_URL_LISTEN;
  if (!url) throw new Error('DATABASE_URL_LISTEN is not set; LISTEN is unavailable in this process');
  const baseRetry = options.retryMs ?? 500;

  let client: pg.Client | undefined;
  let closed = false;
  let retry = baseRetry;
  let timer: NodeJS.Timeout | undefined;

  const connect = async (): Promise<void> => {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    c.on('notification', (msg) => {
      if (msg.channel === channel) onNotify();
    });
    c.on('error', (err) => {
      dbLogger().warn({ err, channel }, 'listen connection error');
      reconnect(c);
    });
    c.on('end', () => reconnect(c));
    await c.connect();
    await c.query(`listen ${channel}`); // channel is validated above; LISTEN takes no parameters
    client = c;
    retry = baseRetry;
    onNotify();
  };

  const reconnect = (dead: pg.Client): void => {
    if (closed || client !== dead || timer) return;
    client = undefined;
    dead.end().catch(() => {});
    const attempt = (): void => {
      timer = setTimeout(() => {
        timer = undefined;
        if (closed) return;
        connect().catch((err) => {
          dbLogger().warn({ err, channel, retryMs: retry }, 'listen reconnect failed');
          retry = Math.min(retry * 2, 30_000);
          attempt();
        });
      }, retry);
      timer.unref();
    };
    attempt();
  };

  await connect();
  return {
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      const c = client;
      client = undefined;
      await c?.end().catch(() => {});
    },
  };
}
