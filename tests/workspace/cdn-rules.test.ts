import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  type CacheRule,
  checkApplied,
  feedApiHost,
  judgeVerify,
  mergeRules,
  overlappingRules,
  renderCacheRules,
} from '../../scripts/ops/cdn-rules';

const ROOT = join(import.meta.dirname, '..', '..');
const yaml = <T>(...p: string[]) => parse(readFileSync(join(ROOT, ...p), 'utf8')) as T;

interface VaryAction {
  action: string;
}

describe('website API edge cache rules as code (S7-06)', () => {
  it('[S7-06] the cache rule keys answers by API key and Authorization, bypasses any other Vary (Origin included), and caches only what the origin marks public', () => {
    for (const env of ['staging', 'production']) {
      const host = feedApiHost(env);
      const [rule, ...others] = renderCacheRules(host);
      expect(others).toEqual([]);
      expect(rule?.ref).toBe('inmolink_website_api_v2');
      // Only the feed-api host's /v2 GETs; nothing else of the zone.
      expect(rule?.expression).toBe(
        `(http.host eq "${host}" and starts_with(http.request.uri.path, "/v2/") and http.request.method eq "GET")`,
      );
      const p = rule?.action_parameters as {
        cache: boolean;
        edge_ttl: { mode: string };
        browser_ttl: { mode: string };
        respect_strong_etags: boolean;
        cache_key: Record<string, unknown>;
        vary: { default: VaryAction; headers: Record<string, VaryAction> };
      };
      expect(p.cache).toBe(true);
      // No Cache-Control from the origin (or private / no-store) → not cached; s-maxage decides the lifetime.
      expect(p.edge_ttl).toEqual({ mode: 'bypass_by_default' });
      expect(p.browser_ttl).toEqual({ mode: 'respect_origin' });
      expect(p.respect_strong_etags).toBe(true);
      expect(p.cache_key).toEqual({ cache_deception_armor: true, ignore_query_strings_order: true });
      // The site comes from the key: its exact value is part of the cache key. Anything else varying → no cache.
      expect(p.vary.default).toEqual({ action: 'bypass' });
      expect(p.vary.headers['x-api-key']).toEqual({ action: 'passthrough' });
      expect(p.vary.headers.authorization).toEqual({ action: 'passthrough' });
      // Origin is not a Vary passthrough header: public answers carry the origin in their URL (`_k`).
      expect(Object.keys(p.vary.headers).sort()).toEqual(['accept-encoding', 'authorization', 'x-api-key']);
    }
    expect(() => renderCacheRules('feed.example"; or true')).toThrow(TypeError);
  });

  it('[S7-06] applying the rules replaces only our rules, puts them last, warns of overlapping rules and checks the read-back', () => {
    const ours = renderCacheRules('feed.staging.inmolink.es');
    const foreign: CacheRule = {
      id: 'x1',
      version: '3',
      ref: 'media_images',
      expression: 'true',
      action: 'set_cache_settings',
    };
    const stale: CacheRule = {
      id: 'x2',
      ref: 'inmolink_website_api_v2',
      expression: 'old',
      action: 'set_cache_settings',
    };
    const retired: CacheRule = { id: 'x3', ref: 'inmolink_retired', expression: 'old', action: 'set_cache_settings' };
    const merged = mergeRules([foreign, stale, retired], ours);
    expect(merged.map((r) => r.ref)).toEqual(['media_images', 'inmolink_website_api_v2']);
    expect(merged[0]).toEqual({ ref: 'media_images', expression: 'true', action: 'set_cache_settings' });
    expect(merged[1]).toEqual(ours[0]);
    expect(mergeRules([], ours)).toEqual(ours);
    // Ours go last even when the zone had them first (later rules override earlier ones).
    const later: CacheRule = {
      ref: 'assets',
      expression: '(http.host eq "media.inmolink.es")',
      action: 'set_cache_settings',
    };
    expect(mergeRules([stale, later], ours).map((r) => r.ref)).toEqual(['assets', 'inmolink_website_api_v2']);
    // A rule without a host test (zone-wide) or naming /v2 or the host may match the API: a warning.
    expect(overlappingRules([foreign, later, ...ours], 'feed.staging.inmolink.es')).toEqual(['media_images: true']);
    // The read-back must hold our rule last with its vary block.
    expect(checkApplied(mergeRules([foreign], ours), ours)).toEqual([]);
    expect(checkApplied([...ours, foreign], ours)).toEqual([
      'inmolink_website_api_v2: not among the last rules of the zone',
    ]);
    const noVary = { ...(ours[0] as CacheRule), action_parameters: { cache: true } };
    expect(checkApplied([noVary], ours)).toEqual([
      'inmolink_website_api_v2: vary.default is not bypass',
      'inmolink_website_api_v2: vary x-api-key is not passthrough',
      'inmolink_website_api_v2: vary authorization is not passthrough',
    ]);
  });

  it('[S7-06] feed-api ships with the edge cache off; the worker gets the zone and a purge-only token as secrets', () => {
    const feed = yaml<{ env: { clear: Record<string, string> } }>('infra', 'kamal', 'feed-api.yml');
    expect(feed.env.clear.WEBSITE_EDGE_CACHE).toBe('false');
    const worker = yaml<{ servers: { workers: { env: { clear: Record<string, string>; secret: string[] } } } }>(
      'infra',
      'kamal',
      'worker.yml',
    );
    expect(worker.servers.workers.env.secret).toEqual(
      expect.arrayContaining(['CLOUDFLARE_ZONE_ID', 'CLOUDFLARE_PURGE_TOKEN']),
    );
    expect(worker.servers.workers.env.clear.WORKER_POOLS).toContain('indexing');
  });

  it('[S7-06] --verify passes only when key A hits and key B, another origin and a token-less request never do', () => {
    const ok = [
      { name: 'a-first', status: 200, cacheStatus: 'MISS' },
      { name: 'a-again', status: 200, cacheStatus: 'HIT' },
      { name: 'b-same-url', status: 200, cacheStatus: 'MISS' },
      { name: 'a-other-origin', status: 200, cacheStatus: 'MISS' },
      { name: 'a-no-token', status: 200, cacheStatus: 'DYNAMIC' },
    ] as const;
    expect(judgeVerify(ok)).toEqual([]);
    expect(judgeVerify(ok.map((p) => (p.name === 'b-same-url' ? { ...p, cacheStatus: 'HIT' } : p)))).toEqual([
      'b-same-url: a HIT — a cached answer crossed keys or origins',
    ]);
    expect(judgeVerify(ok.map((p) => (p.name === 'a-again' ? { ...p, cacheStatus: 'MISS' } : p)))).toEqual([
      'a-again: not a HIT (is the rule live, the edge cache on?)',
    ]);
  });
});
