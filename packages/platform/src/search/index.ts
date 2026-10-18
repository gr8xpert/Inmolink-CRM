/**
 * Search engine adapter (S5-02, ADR 0005, PLAN §3 #16). Modules describe an index (`IndexDefinition`) and query it
 * with an engine-neutral filter tree (`Filter`); the Meilisearch implementation compiles both to its REST API with
 * `fetch` (no client SDK). Swapping the engine means another `SearchEngine`, not module changes.
 *
 * Calls are network I/O: never inside a DB transaction (CLAUDE.md rule 6). Writes are asynchronous in the engine:
 * they answer a `SearchTask` to wait for when the caller needs the write visible.
 *
 * Filter values are always quoted or validated numbers and field names must be declared filterable by the index
 * definition, so caller input can never change a filter's structure.
 */

/** A scalar a document field holds and a filter compares with. */
export type FieldValue = string | number | boolean;

/** Engine-neutral filter tree. Fields must be in the index definition's `filterable` list. */
export type Filter =
  | { op: 'and' | 'or'; filters: Filter[] }
  | { op: 'not'; filter: Filter }
  | { op: 'eq'; field: string; value: FieldValue }
  | { op: 'in'; field: string; values: FieldValue[] }
  /** Numeric bounds, inclusive. The field must be filterable with `comparison: true`. */
  | { op: 'range'; field: string; gte?: number; lte?: number }
  /** Within `meters` of a point (the document's `geo`). */
  | { op: 'geoRadius'; lat: number; lng: number; meters: number }
  /** Inside a box (map view). */
  | { op: 'geoBox'; north: number; west: number; south: number; east: number };

export type Sort = { field: string; dir: 'asc' | 'desc' } | { geoNear: { lat: number; lng: number } };

export interface IndexDefinition {
  uid: string;
  primaryKey: string;
  /** Full-text fields, most important first (the attribute ranking). */
  searchable: string[];
  /** Filterable fields; `comparison` enables `range`. Every filterable field can be faceted. */
  filterable: { field: string; comparison?: boolean }[];
  sortable: string[];
  /** Fields holding text of one content locale (`title_es`): tokenized for that language. */
  localized: { fields: string[]; locale: string }[];
  /** Fields a search answer may return. Results are ids: keep this to the primary key (and a version). */
  displayed: string[];
  /** Fields matched without typo tolerance (references). */
  exactOn: string[];
  /** Documents carry a `geo: { lat, lng } | null` field (geo filters and sort). */
  geo: boolean;
  /** Deepest `offset + limit` a query may reach. */
  maxTotalHits: number;
  /** Values returned per facet, most frequent first. */
  maxValuesPerFacet: number;
}

export interface SearchQuery {
  /** Full-text query; empty or absent: filters only (sorted by `sort`). */
  text?: string;
  /** Search only these searchable fields (e.g. the request locale's `title_<l>`). */
  searchOn?: string[];
  /** Content locale of `text` (tokenization). */
  locale?: string;
  filter?: Filter;
  /** Filterable fields to count values of, under `filter`. */
  facets?: string[];
  sort?: Sort[];
  limit: number;
  offset?: number;
  /** Per-request timeout; default the engine's. */
  timeoutMs?: number;
}

export interface SearchResult {
  ids: string[];
  /** Estimated (exact up to the engine's limits). */
  total: number;
  facets: Record<string, Record<string, number>>;
  /** Min/max of numeric faceted fields. */
  facetStats: Record<string, { min: number; max: number }>;
  /** Engine-side processing time. */
  tookMs: number;
}

/** An asynchronous write, to `waitForTask` when it must be visible. */
export interface SearchTask {
  uid: number;
}

export interface EnsureIndexResult {
  created: boolean;
  /** Settings changed by this call (none when they already matched: nothing was sent). */
  changed: string[];
}

export interface SearchEngine {
  /** Creates the index if missing and applies its settings when they differ. Idempotent; waits until applied. */
  ensureIndex(def: IndexDefinition, options?: { timeoutMs?: number }): Promise<EnsureIndexResult>;
  /** Adds or replaces whole documents (by primary key). Null: nothing to send. */
  upsert(uid: string, docs: readonly object[]): Promise<SearchTask | null>;
  /** Deletes documents by primary key; missing ones are ignored. Null: nothing to send. */
  delete(uid: string, ids: readonly string[]): Promise<SearchTask | null>;
  /**
   * Resolves when the task succeeded (at once for null); throws `SearchError` when it failed or did not finish in
   * time.
   */
  waitForTask(task: SearchTask | null, options?: { timeoutMs?: number }): Promise<void>;
  search(def: IndexDefinition, query: SearchQuery): Promise<SearchResult>;
  /** These documents' `fields` (drift checks). Missing ids are absent from the answer. */
  fetch(uid: string, ids: readonly string[], fields: readonly string[]): Promise<Record<string, unknown>[]>;
  /**
   * A page of the index's documents in the engine's order (repair walks; not for request paths). Writes between
   * pages can shift it: a walk may miss a document added or see one twice.
   */
  browse(
    uid: string,
    page: { offset: number; limit: number; fields: readonly string[] },
  ): Promise<{ results: Record<string, unknown>[]; total: number }>;
  /** Document count and whether writes are pending, or null when the index does not exist. */
  stats(uid: string): Promise<{ documents: number; indexing: boolean } | null>;
  /** Deletes the index (tests, reindex swaps). Missing: no-op. */
  dropIndex(uid: string): Promise<void>;
  health(): Promise<boolean>;
}

export class SearchError extends Error {
  override readonly name = 'SearchError';
  constructor(
    message: string,
    readonly status?: number,
    /** The engine's error code (`index_not_found`, `invalid_search_filter`, …), or `timeout`. */
    readonly code?: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Meilisearch

export interface MeiliConfig {
  url: string;
  /** Master/admin key (worker, scripts) or a search-only key (request apps). */
  apiKey: string;
  /** Per request. Default 10 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Content locale (ISO 639-1, `packages/i18n/locales.json`) → Meilisearch language (ISO 639-3). A locale missing here
 * is indexed without a language hint (detected per document), never refused.
 */
export const MEILI_LANGUAGES: Readonly<Record<string, string>> = {
  ar: 'ara',
  ca: 'cat',
  cs: 'ces',
  da: 'dan',
  de: 'deu',
  el: 'ell',
  en: 'eng',
  es: 'spa',
  fi: 'fin',
  fr: 'fra',
  he: 'heb',
  hu: 'hun',
  it: 'ita',
  ja: 'jpn',
  ko: 'kor',
  nb: 'nob',
  nl: 'nld',
  pl: 'pol',
  pt: 'por',
  ro: 'ron',
  ru: 'rus',
  sv: 'swe',
  tr: 'tur',
  uk: 'ukr',
  zh: 'cmn',
};

const languageOf = (locale: string): string | undefined => MEILI_LANGUAGES[locale.split('-')[0] ?? ''];

const GEO = '_geo';

/** Index definition → Meilisearch settings (only the keys we own; everything else stays the engine default). */
export function meiliSettings(def: IndexDefinition): Record<string, unknown> {
  const plain = def.filterable.filter((f) => !f.comparison).map((f) => f.field);
  const numeric = def.filterable.filter((f) => f.comparison).map((f) => f.field);
  const rule = (patterns: string[], comparison: boolean) => ({
    attributePatterns: patterns,
    features: { facetSearch: false, filter: { equality: true, comparison } },
  });
  const filterableAttributes: unknown[] = [
    ...(plain.length > 0 ? [rule(plain, false)] : []),
    ...(numeric.length > 0 ? [rule(numeric, true)] : []),
    // Geo filters need the plain-string form (a granular rule for `_geo` does not enable them, v1.54).
    ...(def.geo ? [GEO] : []),
  ];
  const localizedAttributes = def.localized.flatMap((l) => {
    const language = languageOf(l.locale);
    return language ? [{ attributePatterns: l.fields, locales: [language] }] : [];
  });
  return {
    searchableAttributes: def.searchable,
    filterableAttributes,
    sortableAttributes: [...def.sortable, ...(def.geo ? [GEO] : [])],
    displayedAttributes: def.displayed,
    localizedAttributes,
    typoTolerance: { disableOnAttributes: def.exactOn },
    pagination: { maxTotalHits: def.maxTotalHits },
    faceting: { maxValuesPerFacet: def.maxValuesPerFacet, sortFacetValuesBy: { '*': 'count' } },
    // Proximity per attribute, not per word pair: much cheaper indexing, same results for short titles.
    proximityPrecision: 'byAttribute',
    // Facet search (typing into a facet) is unused: skip its index.
    facetSearch: false,
  };
}

/** Engine echoes sorted set-like lists; compare those as sets. */
const SET_LIKE = new Set(['sortableAttributes']);

/** `current` satisfies `desired`: equal scalars and arrays, and every key of a desired object (engine adds defaults). */
function satisfies(current: unknown, desired: unknown): boolean {
  if (Array.isArray(desired)) {
    return (
      Array.isArray(current) && current.length === desired.length && desired.every((d, i) => satisfies(current[i], d))
    );
  }
  if (desired !== null && typeof desired === 'object') {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return false;
    const c = current as Record<string, unknown>;
    return Object.entries(desired).every(([k, v]) => satisfies(c[k], v));
  }
  return current === desired;
}

/** The top-level settings of `desired` that `current` does not already have. */
export function settingsDiff(current: Record<string, unknown>, desired: Record<string, unknown>): string[] {
  return Object.keys(desired).filter((key) => {
    const c = current[key];
    const d = desired[key];
    if (SET_LIKE.has(key) && Array.isArray(c) && Array.isArray(d)) {
      return !satisfies([...c].sort(), [...d].sort());
    }
    return !satisfies(c, d);
  });
}

const quote = (v: FieldValue): string => {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new SearchError('filter value must be a finite number');
    return String(v);
  }
  if (typeof v === 'boolean') return String(v);
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

const finite = (...values: number[]) => {
  for (const v of values) if (!Number.isFinite(v)) throw new SearchError('filter value must be a finite number');
};

/**
 * Filter tree → Meilisearch filter expression. Throws `SearchError` for a field the definition does not declare
 * filterable (or comparable, for `range`), a non-finite number or an empty `in`.
 */
export function compileFilter(def: IndexDefinition, filter: Filter): string {
  const fields = new Map(def.filterable.map((f) => [f.field, f.comparison === true]));
  const field = (name: string, comparison = false): string => {
    const comparable = fields.get(name);
    if (comparable === undefined) throw new SearchError(`field is not filterable: ${name}`);
    if (comparison && !comparable) throw new SearchError(`field is not comparable: ${name}`);
    return name;
  };
  const geo = () => {
    if (!def.geo) throw new SearchError('index has no geo field');
  };
  const walk = (f: Filter): string => {
    switch (f.op) {
      case 'and':
      case 'or': {
        if (f.filters.length === 0) throw new SearchError(`empty ${f.op}`);
        return `(${f.filters.map(walk).join(f.op === 'and' ? ' AND ' : ' OR ')})`;
      }
      case 'not':
        return `(NOT ${walk(f.filter)})`;
      case 'eq':
        return `${field(f.field)} = ${quote(f.value)}`;
      case 'in':
        if (f.values.length === 0) throw new SearchError(`empty in: ${f.field}`);
        return `${field(f.field)} IN [${f.values.map(quote).join(', ')}]`;
      case 'range': {
        const name = field(f.field, true);
        const parts: string[] = [];
        if (f.gte !== undefined) parts.push(`${name} >= ${quote(f.gte)}`);
        if (f.lte !== undefined) parts.push(`${name} <= ${quote(f.lte)}`);
        if (parts.length === 0) throw new SearchError(`empty range: ${f.field}`);
        return `(${parts.join(' AND ')})`;
      }
      case 'geoRadius':
        geo();
        finite(f.lat, f.lng, f.meters);
        return `_geoRadius(${f.lat}, ${f.lng}, ${Math.round(f.meters)})`;
      case 'geoBox':
        geo();
        finite(f.north, f.west, f.south, f.east);
        // top-right, bottom-left
        return `_geoBoundingBox([${f.north}, ${f.east}], [${f.south}, ${f.west}])`;
    }
  };
  return walk(filter);
}

function compileSort(def: IndexDefinition, sort: readonly Sort[]): string[] {
  return sort.map((s) => {
    if ('geoNear' in s) {
      if (!def.geo) throw new SearchError('index has no geo field');
      finite(s.geoNear.lat, s.geoNear.lng);
      return `_geoPoint(${s.geoNear.lat}, ${s.geoNear.lng}):asc`;
    }
    if (!def.sortable.includes(s.field)) throw new SearchError(`field is not sortable: ${s.field}`);
    return `${s.field}:${s.dir}`;
  });
}

/** Neutral document → engine document (`geo` → `_geo`). */
function toEngineDoc(doc: object): object {
  if (!('geo' in doc)) return doc;
  const { geo, ...rest } = doc as { geo: unknown };
  return { ...rest, [GEO]: geo ?? null };
}

/**
 * Query → Meilisearch search request body (validated: declared fields only). Exported for measurements that send
 * the engine's own requests from elsewhere (the S5-02 perf test times them inside the Docker network).
 */
export function meiliSearchBody(def: IndexDefinition, q: SearchQuery): Record<string, unknown> {
  if (!Number.isInteger(q.limit) || q.limit < 0) throw new SearchError('limit must be a non-negative integer');
  const offset = q.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new SearchError('offset must be a non-negative integer');
  for (const f of q.searchOn ?? []) {
    if (!def.searchable.includes(f)) throw new SearchError(`field is not searchable: ${f}`);
  }
  const filterable = new Set(def.filterable.map((f) => f.field));
  for (const f of q.facets ?? []) {
    if (!filterable.has(f)) throw new SearchError(`field is not facetable: ${f}`);
  }
  const language = q.locale ? languageOf(q.locale) : undefined;
  return {
    q: q.text ?? '',
    limit: q.limit,
    offset,
    attributesToRetrieve: [def.primaryKey],
    ...(q.searchOn && q.searchOn.length > 0 ? { attributesToSearchOn: q.searchOn } : {}),
    ...(language && q.text ? { locales: [language] } : {}),
    ...(q.filter ? { filter: compileFilter(def, q.filter) } : {}),
    ...(q.facets && q.facets.length > 0 ? { facets: q.facets } : {}),
    ...(q.sort && q.sort.length > 0 ? { sort: compileSort(def, q.sort) } : {}),
  };
}

const UID = /^[A-Za-z0-9_-]{1,400}$/;
const assertUid = (uid: string) => {
  if (!UID.test(uid)) throw new SearchError(`invalid index uid: ${uid}`);
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMeiliEngine(config: MeiliConfig): SearchEngine {
  const base = config.url.replace(/\/+$/, '');
  const doFetch = config.fetch ?? fetch;
  const defaultTimeout = config.timeoutMs ?? 10_000;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { timeoutMs?: number; allow404?: boolean } = {},
  ): Promise<T | null> {
    const timeoutMs = options.timeoutMs ?? defaultTimeout;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new SearchError(
        timeout ? `search ${method} ${path} timed out after ${timeoutMs} ms` : `search ${method} ${path} failed`,
        undefined,
        timeout ? 'timeout' : 'unreachable',
      );
    }
    const text = await res.text();
    if (res.status === 404 && options.allow404) return null;
    if (!res.ok) {
      let code: string | undefined;
      let message = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string };
        code = parsed.code;
        message = parsed.message ?? message;
      } catch {
        // not JSON: keep the text
      }
      throw new SearchError(`search ${method} ${path}: ${res.status} ${message}`, res.status, code);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  const task = async (method: string, path: string, body?: unknown): Promise<SearchTask> => {
    const answer = await call<{ taskUid: number }>(method, path, body);
    if (!answer || typeof answer.taskUid !== 'number') throw new SearchError(`search ${method} ${path}: no task`);
    return { uid: answer.taskUid };
  };

  async function taskResult(t: SearchTask, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    let wait = 25;
    for (;;) {
      const state = await call<{ status: string; error: { code?: string; message?: string } | null }>(
        'GET',
        `/tasks/${t.uid}`,
      );
      if (state && ['succeeded', 'failed', 'canceled'].includes(state.status)) return state;
      if (Date.now() + wait > deadline) {
        throw new SearchError(`search task ${t.uid} not finished after ${timeoutMs} ms`, undefined, 'timeout');
      }
      await delay(wait);
      wait = Math.min(wait * 2, 500);
    }
  }

  const engine: SearchEngine = {
    async ensureIndex(def, options = {}) {
      assertUid(def.uid);
      const timeoutMs = options.timeoutMs ?? 120_000;
      let created = false;
      const existing = await call('GET', `/indexes/${def.uid}`, undefined, { allow404: true });
      if (existing === null) {
        const state = await taskResult(
          await task('POST', '/indexes', { uid: def.uid, primaryKey: def.primaryKey }),
          timeoutMs,
        );
        // Another process created it first: fine.
        if (state.status !== 'succeeded' && state.error?.code !== 'index_already_exists') {
          throw new SearchError(
            `create index ${def.uid}: ${state.error?.message ?? state.status}`,
            undefined,
            state.error?.code,
          );
        }
        created = state.status === 'succeeded';
      }
      // A settings change still running (an earlier call timed out waiting for a full reindex, or another worker is
      // booting): wait for it and diff against its result, never queue the same reindex again.
      const pending = await call<{ results: { uid: number }[] }>(
        'GET',
        `/tasks?indexUids=${def.uid}&types=settingsUpdate&statuses=enqueued,processing&limit=100`,
      );
      for (const t of pending?.results ?? []) await taskResult(t, timeoutMs);
      const desired = meiliSettings(def);
      const current = (await call<Record<string, unknown>>('GET', `/indexes/${def.uid}/settings`)) ?? {};
      const changed = settingsDiff(current, desired);
      if (changed.length > 0) {
        const patch = Object.fromEntries(changed.map((k) => [k, desired[k]]));
        await engine.waitForTask(await task('PATCH', `/indexes/${def.uid}/settings`, patch), { timeoutMs });
      }
      return { created, changed };
    },

    async upsert(uid, docs) {
      assertUid(uid);
      if (docs.length === 0) return null;
      return task('POST', `/indexes/${uid}/documents`, docs.map(toEngineDoc));
    },

    async delete(uid, ids) {
      assertUid(uid);
      if (ids.length === 0) return null;
      return task('POST', `/indexes/${uid}/documents/delete-batch`, ids);
    },

    async waitForTask(t, options = {}) {
      if (t === null) return;
      const state = await taskResult(t, options.timeoutMs ?? 60_000);
      if (state.status !== 'succeeded') {
        throw new SearchError(
          `search task ${t.uid} ${state.status}: ${state.error?.message ?? ''}`,
          undefined,
          state.error?.code,
        );
      }
    },

    async search(def, q) {
      assertUid(def.uid);
      const body = meiliSearchBody(def, q);
      const answer = await call<{
        hits: Record<string, unknown>[];
        estimatedTotalHits?: number;
        totalHits?: number;
        facetDistribution?: Record<string, Record<string, number>>;
        facetStats?: Record<string, { min: number; max: number }>;
        processingTimeMs: number;
      }>('POST', `/indexes/${def.uid}/search`, body, { timeoutMs: q.timeoutMs });
      if (!answer) throw new SearchError('empty search answer');
      return {
        ids: answer.hits.map((h) => String(h[def.primaryKey])),
        total: answer.totalHits ?? answer.estimatedTotalHits ?? answer.hits.length,
        facets: answer.facetDistribution ?? {},
        facetStats: answer.facetStats ?? {},
        tookMs: answer.processingTimeMs,
      };
    },

    async fetch(uid, ids, fields) {
      assertUid(uid);
      if (ids.length === 0) return [];
      const answer = await call<{ results: Record<string, unknown>[] }>('POST', `/indexes/${uid}/documents/fetch`, {
        ids,
        fields,
        limit: ids.length,
      });
      return answer?.results ?? [];
    },

    async browse(uid, page) {
      assertUid(uid);
      const answer = await call<{ results: Record<string, unknown>[]; total: number }>(
        'POST',
        `/indexes/${uid}/documents/fetch`,
        { offset: page.offset, limit: page.limit, fields: page.fields },
      );
      return { results: answer?.results ?? [], total: answer?.total ?? 0 };
    },

    async stats(uid) {
      assertUid(uid);
      const answer = await call<{ numberOfDocuments: number; isIndexing: boolean }>(
        'GET',
        `/indexes/${uid}/stats`,
        undefined,
        { allow404: true },
      );
      return answer ? { documents: answer.numberOfDocuments, indexing: answer.isIndexing } : null;
    },

    async dropIndex(uid) {
      assertUid(uid);
      const answer = await call<{ taskUid: number }>('DELETE', `/indexes/${uid}`, undefined, { allow404: true });
      if (answer) {
        const state = await taskResult({ uid: answer.taskUid }, 60_000);
        if (state.status !== 'succeeded' && state.error?.code !== 'index_not_found') {
          throw new SearchError(
            `drop index ${uid}: ${state.error?.message ?? state.status}`,
            undefined,
            state.error?.code,
          );
        }
      }
    },

    async health() {
      try {
        const answer = await call<{ status: string }>('GET', '/health', undefined, { timeoutMs: 2_000 });
        return answer?.status === 'available';
      } catch {
        return false;
      }
    },
  };
  return engine;
}

let current: SearchEngine | null = null;

export function configureSearch(next: MeiliConfig | SearchEngine): void {
  current = 'search' in next ? next : createMeiliEngine(next);
}

export function searchEngine(): SearchEngine {
  if (!current) throw new Error('search is not configured (call configureSearch at boot)');
  return current;
}

/** The `searchEnv` config section → engine config: the master key (workers, scripts) or the search-only key. */
export function searchConfigFromEnv(env: {
  MEILI_URL: string;
  MEILI_MASTER_KEY?: string;
  MEILI_SEARCH_KEY?: string;
}): MeiliConfig {
  const apiKey = env.MEILI_MASTER_KEY ?? env.MEILI_SEARCH_KEY;
  if (!apiKey) throw new Error('search needs MEILI_MASTER_KEY or MEILI_SEARCH_KEY');
  return { url: env.MEILI_URL, apiKey };
}
