import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryStore, type ObjectStore, type PutOptions } from '@inmolink/platform/storage';
import { describe, expect, it } from 'vitest';
import { publishWidget, WIDGET_CACHE_CONTROL, widgetObjectKey } from '../../scripts/ops/widget-publish';

describe('widget CDN publish (S8-F8)', () => {
  it('[S8-F8] the widget goes to a versioned, immutable URL the media host serves publicly', async () => {
    const memory = createMemoryStore();
    const puts: { bucket: string; key: string; options: PutOptions }[] = [];
    const store: ObjectStore = {
      ...memory,
      put: async (bucket, key, body, options) => {
        puts.push({ bucket, key, options });
        await memory.put(bucket, key, body, options);
      },
    };
    const script = new TextEncoder().encode('(()=>{})();');
    const url = await publishWidget(store, script, 'https://media.example/');
    const hash = createHash('sha256').update(script).digest('hex').slice(0, 32);
    expect(url).toBe(`https://media.example/vwidget/${hash}/inmolink-widget.iife.js`);
    expect(puts).toEqual([
      {
        bucket: 'media',
        key: `vwidget/${hash}/inmolink-widget.iife.js`,
        options: { contentType: 'text/javascript; charset=utf-8', cacheControl: WIDGET_CACHE_CONTROL },
      },
    ]);
    expect(WIDGET_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
    // The media bucket's public-read patterns (infra/storage/media-public-policy.json).
    const policy = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'infra', 'storage', 'media-public-policy.json'), 'utf8'),
    ) as { Statement: { Resource: string[] }[] };
    // S3 resource globs: `*` any run of characters, `?` one character, everything else literal.
    const globs = policy.Statement.flatMap((st) => st.Resource).map((r) => {
      const glob = r.replace(/^arn:aws:s3:::[^/]+\//, '');
      const parts = [...glob].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/\W/, (x) => `\\${x}`)));
      return new RegExp(`^${parts.join('')}$`);
    });
    expect(globs.some((g) => g.test(widgetObjectKey(script)))).toBe(true);
    // Another build, another URL: a page that pins a version keeps it.
    expect(widgetObjectKey(new TextEncoder().encode('(()=>{1})();'))).not.toBe(widgetObjectKey(script));
  });

  it('[S8-F8] the production media host rule lets the widget key through and nothing else under vwidget/', () => {
    const runbook = readFileSync(
      join(import.meta.dirname, '..', '..', 'docs', 'runbooks', 'media-public-host.md'),
      'utf8',
    );
    const rule = runbook.split('\n').find((l) => l.includes('http.host eq "media.inmolink.es"')) ?? '';
    // The WAF rule's allowed paths, as written in the runbook.
    const allowed = [...rule.matchAll(/matches "([^"]+)"/g)].map((m) => new RegExp(m[1] ?? '$^'));
    expect(allowed).toHaveLength(2);
    const script = new TextEncoder().encode('(()=>{})();');
    const ok = (path: string) => allowed.some((r) => r.test(path));
    expect(ok(`/${widgetObjectKey(script)}`)).toBe(true);
    expect(ok(`/v1/${'a'.repeat(32)}/card.webp`)).toBe(true);
    expect(ok(`/vwidget/${'a'.repeat(32)}/other.js`)).toBe(false);
    expect(ok(`/vwidget/${'a'.repeat(31)}/inmolink-widget.iife.js`)).toBe(false);
    expect(ok(`/v1/${'a'.repeat(32)}/inmolink-widget.iife.js`)).toBe(false);
    expect(runbook).toContain('X-Content-Type-Options: nosniff');
  });
});
