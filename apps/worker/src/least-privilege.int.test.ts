import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadStackEnv } from '@inmolink/db/testing';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue, defineJob, queueFor, registerPool } from '@inmolink/platform/queue';
import { createS3Store, type ObjectStore, storageConfigFromEnv } from '@inmolink/platform/storage';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * S3-F7: the media container decodes untrusted uploads, so a decoder exploit there must stay there. It runs on
 * redis-queue as the `media` ACL user (Ansible `redis_media_acl`) and on object storage as its own user
 * (`infra/storage/media-worker-policy.json`, created by the test stack's minio-init).
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const logger = createLogger({ level: 'silent' });
const prefix = `lp${Date.now().toString(36)}`;
const user = `media-${Date.now().toString(36)}`;
const password = `pw-${Math.random().toString(36).slice(2)}`;
const MEDIA_S3 = { accessKeyId: 'inmolink-media-worker', secretAccessKey: 'inmolink-media-worker-secret' };
const text = async (read: Promise<Uint8Array | null>) => Buffer.from((await read) ?? []).toString();
let admin: Redis;
let queueUrl: URL;

/** Production's ACL for redis-queue's `media` user, moved onto this file's key prefix. */
function mediaAcl(): string[] {
  const vars = readFileSync(join(ROOT, 'infra', 'ansible', 'group_vars', 'all.yml'), 'utf8');
  const acl = vars.match(/^redis_media_acl: "([^"]+)"$/m)?.[1];
  if (!acl) throw new Error('redis_media_acl missing from infra/ansible/group_vars/all.yml');
  expect(acl).toContain('~inl:media:*');
  return acl.replaceAll('~inl:', `~${prefix}:`).split(' ');
}

const asUser = (name: string, pw: string) => {
  const url = new URL(queueUrl);
  url.username = name;
  url.password = pw;
  return url.toString();
};

beforeAll(async () => {
  loadStackEnv('test');
  queueUrl = new URL(process.env.REDIS_QUEUE_URL as string);
  admin = new Redis(queueUrl.toString(), { protocol: 2, maxRetriesPerRequest: 1 });
  await admin.call('ACL', 'SETUSER', user, 'on', `>${password}`, ...mediaAcl());
});

afterAll(async () => {
  await configureQueue({ url: queueUrl.toString(), prefix, logger });
  for (const name of ['media', 'media.dead', 'imports']) await queueFor(name).obliterate({ force: true });
  await closeQueues();
  const keys = await admin.keys(`${prefix}:*`);
  if (keys.length > 0) await admin.del(...keys);
  await admin.call('ACL', 'DELUSER', user);
  await admin.quit();
});

describe('media container on redis-queue', () => {
  it('[S3-F7] the media user runs its own pool — jobs, fair share, retries, dead letters, schedulers', async () => {
    await configureQueue({ url: asUser(user, password), prefix, logger });
    const ran: string[] = [];
    let scheduled = 0;
    const work = defineJob({
      name: 'test.mediaWork',
      pool: 'media',
      payload: z.object({ id: z.string(), agencyId: z.string() }),
      jobId: (p) => `work:${p.id}`,
      group: (p) => p.agencyId,
      concurrencyPerGroup: 2,
      async run(p) {
        ran.push(p.id);
      },
    });
    const broken = defineJob({
      name: 'test.mediaBroken',
      pool: 'media',
      payload: z.object({ id: z.string() }),
      attempts: 1,
      async run() {
        throw new Error('decoder blew up');
      },
    });
    const tick = defineJob({
      name: 'test.mediaTick',
      pool: 'media',
      payload: z.object({}),
      every: 60_000,
      async run() {
        scheduled++;
      },
    });
    const handle = registerPool('media', [work, broken, tick], { concurrency: 2 });
    try {
      await handle.scheduled;
      await work.enqueue({ id: 'a', agencyId: 'agency-1' });
      await work.enqueue({ id: 'b', agencyId: 'agency-2' });
      await broken.enqueue({ id: 'x' });
      await expect.poll(() => ran.sort(), { timeout: 10_000 }).toEqual(['a', 'b']);
      await expect.poll(() => queueFor('media.dead').count(), { timeout: 10_000 }).toBe(1);
      await expect.poll(() => scheduled, { timeout: 10_000 }).toBeGreaterThan(0);
    } finally {
      await handle.close();
      await closeQueues();
    }
  });

  it('[S3-F7] the media container cannot add a job to another pool or reach other keys', async () => {
    await configureQueue({ url: asUser(user, password), prefix, logger });
    const foreign = defineJob({
      name: 'test.systemWork',
      pool: 'imports', // runs as app_system in the other container
      payload: z.object({ id: z.string() }),
      async run() {},
    });
    try {
      await expect(foreign.enqueue({ id: 'evil' })).rejects.toThrow(/NOPERM/);
    } finally {
      await closeQueues();
    }
    expect(await admin.exists(`${prefix}:imports:meta`)).toBe(0);

    const scoped = new Redis(asUser(user, password), { protocol: 2, maxRetriesPerRequest: 1 });
    try {
      await expect(scoped.set(`${prefix}:imports:wait`, '1')).rejects.toThrow(/NOPERM/);
      await expect(scoped.get('inl:rl:anything')).rejects.toThrow(/NOPERM/);
      await expect(scoped.keys('*')).rejects.toThrow(/NOPERM/);
      await expect(scoped.call('SCAN', '0')).rejects.toThrow(/NOPERM/);
      await expect(scoped.call('FLUSHALL')).rejects.toThrow(/NOPERM/);
      await expect(scoped.config('GET', 'maxmemory')).rejects.toThrow(/NOPERM/);
      await expect(scoped.call('ACL', 'LIST')).rejects.toThrow(/NOPERM/);
      await expect(scoped.call('SCRIPT', 'FLUSH')).rejects.toThrow(/NOPERM/);
      // A script cannot reach other keys either: ACL checks every command it runs.
      await expect(scoped.eval(`return redis.call('GET', KEYS[1])`, 1, `${prefix}:imports:meta`)).rejects.toThrow(
        /NOPERM|No permissions/,
      );
    } finally {
      scoped.disconnect();
    }
  });

  it('[S3-F7] the media user does not exist on the cache Redis', async () => {
    const cache = new Redis(process.env.REDIS_CACHE_URL as string, { protocol: 2, maxRetriesPerRequest: 1 });
    try {
      await expect(cache.call('AUTH', user, password)).rejects.toThrow(/WRONGPASS/);
    } finally {
      cache.disconnect();
    }
  });
});

describe('media container on object storage', () => {
  let root: ObjectStore;
  let media: ObjectStore;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const sha = id.padEnd(64, '0');
  const exportKey = `exports/test-${id}.csv`;
  const documentKey = `documents/agency-${id}/listing-1/doc-1`;
  const verificationKey = `verification/agency-${id}/doc-1`;

  beforeAll(() => {
    const config = storageConfigFromEnv(process.env as Parameters<typeof storageConfigFromEnv>[0]);
    root = createS3Store(config);
    media = createS3Store({ ...config, ...MEDIA_S3 });
  });

  afterAll(async () => {
    await root.delete('exports', exportKey);
    await root.delete('private', documentKey);
    await root.delete('private', verificationKey);
    await root.delete('work', `originals/${sha}`);
    await root.delete('work', `masters/${sha}`);
    await root.delete('media', `v1/${id}/test.webp`);
  });

  it('[S3-F7] [S3-F9] its credentials read and write originals, masters (work bucket) and variants', async () => {
    const bytes = Buffer.from('media bytes');
    await media.put('work', `originals/${sha}`, bytes, { contentType: 'application/octet-stream' });
    await media.put('work', `masters/${sha}`, bytes, { contentType: 'image/webp' });
    await media.put('media', `v1/${id}/test.webp`, bytes, { contentType: 'image/webp' });
    expect(await text(media.get('work', `originals/${sha}`, { maxBytes: 1_000 }))).toBe('media bytes');
    expect(await text(media.get('work', `masters/${sha}`, { maxBytes: 1_000 }))).toBe('media bytes');
    const listed = await media.list('work', `originals/${sha}`, { limit: 10 });
    expect(listed.objects.map((o) => o.key)).toContain(`originals/${sha}`);
    await media.delete('work', `originals/${sha}`);
  });

  it('[S3-F9] its policy grants whole buckets — media and work — with no prefix conditions, never the private one', () => {
    const policy = JSON.parse(readFileSync(join(ROOT, 'infra', 'storage', 'media-worker-policy.json'), 'utf8')) as {
      Statement: { Resource: string[]; Condition?: unknown }[];
    };
    const resources = policy.Statement.flatMap((st) => st.Resource);
    expect(policy.Statement.every((st) => st.Condition === undefined)).toBe(true);
    expect(new Set(resources.map((r) => r.replace('arn:aws:s3:::', '').split('/')[0]))).toEqual(
      new Set(['inmolink-media', 'inmolink-media-work']),
    );
  });

  it('[S3-F7] its credentials cannot read an export or a private document', async () => {
    await root.put('exports', exportKey, Buffer.from('a,b'), { contentType: 'text/csv' });
    await root.put('private', documentKey, Buffer.from('%PDF-1.7'), { contentType: 'application/pdf' });
    await root.put('private', verificationKey, Buffer.from('%PDF-1.7'), { contentType: 'application/pdf' });

    await expect(media.get('exports', exportKey, { maxBytes: 1_000 })).rejects.toThrow();
    await expect(media.get('private', documentKey, { maxBytes: 1_000 })).rejects.toThrow();
    await expect(media.get('private', verificationKey, { maxBytes: 1_000 })).rejects.toThrow();
    await expect(media.list('private', 'documents/', { limit: 10 })).rejects.toThrow();
    // S3-F9: no prefix of the private bucket is granted any more, originals/ included.
    await expect(media.list('private', 'originals/', { limit: 10 })).rejects.toThrow();
    await expect(
      media.put('private', `originals/${sha}`, Buffer.from('x'), { contentType: 'application/octet-stream' }),
    ).rejects.toThrow();
    await expect(media.list('exports', 'exports/', { limit: 10 })).rejects.toThrow();
    await expect(
      media.put('private', documentKey, Buffer.from('overwritten'), { contentType: 'application/pdf' }),
    ).rejects.toThrow();
    await expect(media.delete('private', verificationKey)).rejects.toThrow();
    // Still there, untouched.
    expect(await text(root.get('private', documentKey, { maxBytes: 1_000 }))).toBe('%PDF-1.7');
    expect(await text(root.get('private', verificationKey, { maxBytes: 1_000 }))).toBe('%PDF-1.7');
  });
});
