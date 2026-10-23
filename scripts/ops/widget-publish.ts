// pnpm ops:widget-publish [--local [--test]]
//
// Publishes the JS widget (S8-06, S8-F8) at a versioned, immutable CDN URL: builds `inmolink-widget.iife.js` and puts
// it in the public media bucket under `vwidget/<first 32 hex of its SHA-256>/inmolink-widget.iife.js` with
// `Cache-Control: public, max-age=31536000, immutable` (ADR 0013: hashed JS is immutable for a year). That exact key
// shape is public on the media host (MinIO: infra/storage/media-public-policy.json; R2: the WAF rule of
// docs/runbooks/media-public-host.md); the media bucket is never swept by prefix. Prints the URL for the sites'
// `<script>` tag and the commit it was built from. Same bytes, same URL: publishing twice rewrites the same object.
// Old versions stay, so pages that pin one keep it. Refuses a working tree with uncommitted changes (the URL must stand
// for a commit).
//
// Env: the storage section (S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET_*) with a token
// that may write the media bucket, and MEDIA_CDN_URL (the media bucket's public host); missing credentials fail.
// `--local` reads the local stack's env file instead (dev, or `--test`).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfigOrExit, mediaCdnEnv, storageEnv } from '@inmolink/platform/config';
import { createS3Store, type ObjectStore, storageConfigFromEnv } from '@inmolink/platform/storage';
import { buildWidget } from '../../packages/sdk/widget-build';
import { readStackEnv } from './stack-env';

export const WIDGET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const WIDGET_CONTENT_TYPE = 'text/javascript; charset=utf-8';

/** `vwidget/<32 hex of SHA-256>/inmolink-widget.iife.js`: one key per build output. */
export function widgetObjectKey(script: Uint8Array): string {
  const hash = createHash('sha256').update(script).digest('hex').slice(0, 32);
  return `vwidget/${hash}/inmolink-widget.iife.js`;
}

/** Puts the script in the media bucket; returns its public URL. */
export async function publishWidget(store: ObjectStore, script: Uint8Array, cdnBaseUrl: string): Promise<string> {
  const key = widgetObjectKey(script);
  await store.put('media', key, script, { contentType: WIDGET_CONTENT_TYPE, cacheControl: WIDGET_CACHE_CONTROL });
  return `${cdnBaseUrl.replace(/\/+$/, '')}/${key}`;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({
    options: { local: { type: 'boolean', default: false }, test: { type: 'boolean', default: false } },
  });
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  if (git('status', '--porcelain', '--untracked-files=no') !== '') {
    process.stderr.write('ops:widget-publish: the working tree has uncommitted changes; commit or stash them first\n');
    process.exit(1);
  }
  const commit = git('rev-parse', 'HEAD');
  if (values.local) {
    for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
  }
  const config = loadConfigOrExit({ ...storageEnv, ...mediaCdnEnv });
  const out = mkdtempSync(join(tmpdir(), 'inmolink-widget-publish-'));
  try {
    const script = readFileSync(await buildWidget(out));
    const url = await publishWidget(createS3Store(storageConfigFromEnv(config)), script, config.MEDIA_CDN_URL);
    process.stdout.write(`${url}\ncommit ${commit}\n`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
