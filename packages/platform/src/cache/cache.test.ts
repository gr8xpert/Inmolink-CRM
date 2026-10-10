import { describe, expect, it } from 'vitest';
import { createFakeClock } from '../clock';
import { assertCacheKey, cacheKey } from './key';
import { LocalLru } from './lru';

describe('LocalLru', () => {
  it('expires entries after their TTL', () => {
    const clock = createFakeClock(0);
    const lru = new LocalLru<number>(10, clock);
    lru.set('a', 1, 1_000);
    clock.advance(999);
    expect(lru.get('a')).toBe(1);
    clock.advance(1);
    expect(lru.get('a')).toBeUndefined();
  });

  it('evicts the least recently used entry', () => {
    const lru = new LocalLru<number>(2, createFakeClock(0));
    lru.set('a', 1, 1_000);
    lru.set('b', 2, 1_000);
    lru.get('a');
    lru.set('c', 3, 1_000);
    expect(lru.get('a')).toBe(1);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.size).toBe(2);
  });

  it('drops tagged entries', () => {
    const lru = new LocalLru<number>(10, createFakeClock(0));
    lru.set('a', 1, 1_000, ['x']);
    lru.set('b', 2, 1_000, ['y']);
    lru.deleteTagged('x');
    expect(lru.get('a')).toBeUndefined();
    expect(lru.get('b')).toBe(2);
  });
});

describe('cacheKey', () => {
  const agencyId = '01a12436-c0dd-7525-a20d-1eb9eec948f6';

  it('names the scope, tags each segment and encodes ids', () => {
    expect(cacheKey({ v: 1, module: 'taxonomy', entity: 'tree', scope: 'global', locale: 'es' })).toBe(
      'v1:taxonomy:tree:g:l.es',
    );
    expect(
      cacheKey({ v: 2, module: 'listings', entity: 'card', scope: { agencyId }, id: 'a:b c', view: 'client' }),
    ).toBe(`v2:listings:card:a.${agencyId}:i.a%3Ab%20c:client`);
  });

  it('keeps a user id from shifting into the locale segment', () => {
    const a = cacheKey({ v: 1, module: 'm', entity: 'e', scope: 'global', id: 'x:l.es' });
    const b = cacheKey({ v: 1, module: 'm', entity: 'e', scope: 'global', id: 'x', locale: 'es' });
    expect(a).not.toBe(b);
  });

  it('rejects bad parts', () => {
    expect(() => cacheKey({ v: 0, module: 'm', entity: 'e', scope: 'global' })).toThrow(TypeError);
    expect(() => cacheKey({ v: 1, module: 'M', entity: 'e', scope: 'global' })).toThrow(TypeError);
    expect(() => cacheKey({ v: 1, module: 'm', entity: 'e', scope: { agencyId: 'nope' } })).toThrow(TypeError);
    expect(() => cacheKey({ v: 1, module: 'm', entity: 'e', scope: 'global', locale: 'english' })).toThrow(TypeError);
  });

  it('builds keys assertCacheKey accepts', () => {
    const key = cacheKey({
      v: 1,
      module: 'm',
      entity: 'e',
      scope: { agencyId },
      id: 7,
      locale: 'pt-BR',
      view: 'agent',
    });
    expect(() => assertCacheKey(key)).not.toThrow();
  });
});

describe('assertCacheKey', () => {
  it.each(['taxonomy', 'v1:taxonomy', 'v1:taxonomy:tree', 'v1:m:e:global', 'v1:tax onomy:x:g'])('rejects %s', (key) => {
    expect(() => assertCacheKey(key)).toThrow(TypeError);
  });
});
