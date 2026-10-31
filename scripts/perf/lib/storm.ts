/**
 * Queue and worker storms (S16-01, PLAN §15): the import storm (500 feeds at once; no tenant's queue age > 15 min) and
 * the matching storm (10k listing changes in 5 min against 1M client profiles; processed < 10 min). Targets, profiles,
 * the tenant mix, the queue-age math, verdicts and the summary text — pure, so `tests/load/storm.test.ts` pins them;
 * `scripts/perf/storm.ts` drives the real stack and feeds this module what it measured.
 *
 * Why Node and not k6 (S16-01 decision): neither storm has an HTTP surface whose latency is the target. The import
 * storm must serve the feeds the workers fetch and read per-tenant queue ages from `feed_runs`; the matching storm
 * must apply listing changes through the properties service (so the outbox, read-model rebuild and
 * `search.listings.changed` → `matching.matchListings` run as in production) and read `matching_listing_states`. k6
 * can do neither, so these are Node drivers that report in the k6 runs' summary style, with their thresholds as code.
 */

/** PLAN §15: 500 feeds triggered at once; no tenant waits longer than 15 min for its run to start. */
export const IMPORT_STORM = { feeds: 500, maxQueueAgeMs: 15 * 60_000 } as const;
/** PLAN §15: 10k listing changes applied over 5 min, against 1M client profiles, all matched within 10 min. */
export const MATCHING_STORM = {
  changes: 10_000,
  windowMs: 5 * 60_000,
  maxProcessMs: 10 * 60_000,
  profiles: 1_000_000,
} as const;

export type StormProfileName = 'smoke' | 'staging';
/** The acceptance profile: its numbers are the check, so it takes no overrides. */
export const ACCEPTANCE_PROFILE: StormProfileName = 'staging';

export interface FeedSizes {
  /** Listings in most feeds (PLAN §4.1: 150 own listings per agency). */
  small: number;
  /** One feed in 25. */
  medium: number;
  /** One feed in 100 (a large developer's or portal-sized feed). */
  huge: number;
}

export interface ImportProfile {
  feeds: number;
  maxQueueAgeMs: number;
  sizes: FeedSizes;
  /** How often the driver samples `feed_runs`. */
  sampleMs: number;
  /** The driver gives up (and fails) after this long without every run ended. */
  timeoutMs: number;
}

export interface MatchingProfile {
  changes: number;
  windowMs: number;
  maxProcessMs: number;
  /** Active (not OFF) saved searches the run needs; the driver provisions the shortfall. */
  profiles: number;
  /** Agencies the changes are spread over. */
  agencies: number;
  /** Listing updates in flight at once (the pace is set by `windowMs`; this only bounds the driver). */
  concurrency: number;
  sampleMs: number;
  timeoutMs: number;
}

export const IMPORT_PROFILES: Record<StormProfileName, ImportProfile> = {
  // a local slice: the test stack, one worker process
  smoke: {
    feeds: 20,
    maxQueueAgeMs: IMPORT_STORM.maxQueueAgeMs,
    sizes: { small: 20, medium: 100, huge: 300 },
    sampleMs: 2_000,
    timeoutMs: 20 * 60_000,
  },
  staging: {
    feeds: IMPORT_STORM.feeds,
    maxQueueAgeMs: IMPORT_STORM.maxQueueAgeMs,
    sizes: { small: 150, medium: 1_000, huge: 5_000 },
    sampleMs: 5_000,
    timeoutMs: 60 * 60_000,
  },
};

export const MATCHING_PROFILES: Record<StormProfileName, MatchingProfile> = {
  smoke: {
    changes: 200,
    windowMs: 60_000,
    maxProcessMs: MATCHING_STORM.maxProcessMs,
    profiles: 10_000,
    agencies: 38, // the perf:smoke seed (40 agencies) indexes ~5 priced listings per agency; 200 changes need ~38
    concurrency: 4,
    sampleMs: 2_000,
    timeoutMs: 15 * 60_000,
  },
  staging: {
    changes: MATCHING_STORM.changes,
    windowMs: MATCHING_STORM.windowMs,
    maxProcessMs: MATCHING_STORM.maxProcessMs,
    profiles: MATCHING_STORM.profiles,
    agencies: 500,
    concurrency: 16,
    sampleMs: 5_000,
    timeoutMs: 30 * 60_000,
  },
};

export type ImportOverrides = Partial<Pick<ImportProfile, 'feeds' | 'maxQueueAgeMs' | 'timeoutMs'>>;
export type MatchingOverrides = Partial<
  Pick<MatchingProfile, 'changes' | 'windowMs' | 'maxProcessMs' | 'profiles' | 'agencies' | 'timeoutMs'>
>;

function resolve<P extends object, O extends Partial<P>>(
  table: Record<StormProfileName, P>,
  name: string,
  overrides: O,
): P & { name: StormProfileName } {
  if (!(name in table)) throw new Error(`--profile must be one of ${Object.keys(table).join(', ')}`);
  const profileName = name as StormProfileName;
  const given = Object.entries(overrides).filter(([, v]) => v !== undefined);
  if (profileName === ACCEPTANCE_PROFILE && given.length > 0) {
    throw new Error(
      `--profile ${profileName} is the acceptance check: no ${given.map(([k]) => `--${kebab(k)}`).join(', ')} override`,
    );
  }
  for (const [k, v] of given) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
      throw new Error(`--${kebab(k)} must be a positive integer`);
  }
  return { ...table[profileName], ...Object.fromEntries(given), name: profileName };
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The import profile by name (default smoke), with overrides — except the acceptance profile, which refuses them. */
export function resolveImportProfile(name = 'smoke', overrides: ImportOverrides = {}) {
  return resolve(IMPORT_PROFILES, name, overrides);
}

/** The matching profile by name (default smoke), with overrides — except the acceptance profile. */
export function resolveMatchingProfile(name = 'smoke', overrides: MatchingOverrides = {}) {
  return resolve(MATCHING_PROFILES, name, overrides);
}

/* ------------------------------------------------------------------ import storm: the tenant mix */

export interface StormFeed {
  /** 0-based feed number (its URL path). */
  feed: number;
  /** 0-based index into the agencies the driver picked. */
  agency: number;
  listings: number;
  size: keyof FeedSizes;
}

/**
 * The storm's feeds over tenants, as the fair-share check's mix (`tests/perf/fair-share-queue.int.test.ts`): about
 * 12 % of the feeds in agencies with 8 feeds, 10 % in agencies with 2, the rest one each — so an agency's own backlog
 * (one run at a time per agency) and other agencies' huge feeds both weigh on the worst tenant. One feed in 100 is huge,
 * one in 25 medium (at least one of each from 20 feeds), spread evenly, never all in one agency.
 */
export function feedMix(feeds: number, sizes: FeedSizes): StormFeed[] {
  if (!Number.isInteger(feeds) || feeds < 1) throw new RangeError('feeds must be a positive integer');
  const multi8 = Math.floor((feeds * 0.12) / 8);
  const multi2 = Math.floor((feeds * 0.1) / 2);
  const owners: number[] = [];
  let agency = 0;
  for (let a = 0; a < multi8; a++, agency++) for (let i = 0; i < 8; i++) owners.push(agency);
  for (let a = 0; a < multi2; a++, agency++) for (let i = 0; i < 2; i++) owners.push(agency);
  while (owners.length < feeds) owners.push(agency++);
  const huge = feeds >= 20 ? Math.max(1, Math.floor(feeds / 100)) : 0;
  const medium = feeds >= 20 ? Math.max(1, Math.floor(feeds / 25)) : 0;
  // evenly spaced positions (a stride walk), huge ones first, so sizes do not cluster in the multi-feed agencies
  const size = new Array<keyof FeedSizes>(feeds).fill('small');
  const stride = (n: number, offset: number, as: keyof FeedSizes) => {
    for (let k = 0; k < n; k++) {
      let at = Math.floor(((k + offset) * feeds) / n) % feeds;
      while (size[at] !== 'small') at = (at + 1) % feeds;
      size[at] = as;
    }
  };
  stride(huge, 0.5, 'huge');
  stride(medium, 0.25, 'medium');
  return owners.map((owner, feed) => {
    const s = size[feed] ?? 'small';
    return { feed, agency: owner, listings: sizes[s], size: s };
  });
}

export const agenciesIn = (mix: readonly StormFeed[]): number => new Set(mix.map((f) => f.agency)).size;

/* ------------------------------------------------------------------ import storm: queue ages */

export interface RunSample {
  runId: string;
  agencyId: string;
  /** The run row was written (the scheduler queued it): the start of its queue age, as `ImportQueueWaitHigh` counts. */
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  state: string;
}

/** A run's queue age at `nowMs`: until it started, or until now while it still waits. */
export const queueAgeOf = (r: RunSample, nowMs: number): number =>
  Math.max(0, (r.startedAtMs ?? nowMs) - r.createdAtMs);

/**
 * Per-tenant queue age over a run (S16-01): each sample (the DB's `now()` and every storm run's row) raises a tenant's
 * worst age to the largest age of its runs so far — a run still waiting counts with its age so far, so a tenant that
 * starves until the timeout shows up even though its run never started. Also keeps the oldest waiting job per sample
 * (the queue-age curve the alert sees).
 */
export class QueueAgeTracker {
  readonly worstByTenant = new Map<string, number>();
  readonly runs = new Map<string, RunSample>();
  /** [sample time, oldest waiting age] per sample. */
  readonly curve: [number, number][] = [];

  observe(nowMs: number, samples: readonly RunSample[]): void {
    let oldestWaiting = 0;
    for (const r of samples) {
      this.runs.set(r.runId, r);
      const age = queueAgeOf(r, nowMs);
      if (r.startedAtMs === null) oldestWaiting = Math.max(oldestWaiting, age);
      if (age > (this.worstByTenant.get(r.agencyId) ?? -1)) this.worstByTenant.set(r.agencyId, age);
    }
    this.curve.push([nowMs, oldestWaiting]);
  }
}

/** `q` quantile (nearest rank) of `xs`; 0 for none. */
export function percentile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] as number;
}

export const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED']);

export interface ImportMeasured {
  /** DB time the connections were made due. */
  triggeredAtMs: number;
  /** DB time of the last sample. */
  endedAtMs: number;
  /** Storm connections (one run each expected). */
  connections: number;
  timedOut: boolean;
  /** Feed requests the fixture server answered. */
  feedRequests: number;
}

export interface ImportReport {
  profile: StormProfileName;
  target: { feeds: number; maxQueueAgeMs: number };
  feeds: number;
  tenants: number;
  runs: { seen: number; succeeded: number; failed: number; unfinished: number; missing: number };
  queueAgeMs: { worst: number; worstTenant: string | null; p95Tenant: number; p50Tenant: number };
  /** Trigger → every run ended (or the timeout). */
  drainMs: number;
  /** Trigger → the last run row written: how long the scheduler took to queue the storm. */
  scheduledMs: number;
  /** Trigger → start of each run (scheduler lag + queue age), worst. */
  worstTriggerToStartMs: number;
  listingsPerSecond: number | null;
  feedRequests: number;
  failedThresholds: string[];
  pass: boolean;
}

/**
 * The import storm's numbers and verdict: every run ended, none failed, the worst tenant's queue age and the worst
 * trigger → started (scheduler lag included) in budget.
 */
export function importReport(
  p: ImportProfile & { name: StormProfileName },
  mix: readonly StormFeed[],
  tracker: QueueAgeTracker,
  m: ImportMeasured,
): ImportReport {
  const runs = [...tracker.runs.values()];
  const ended = runs.filter((r) => TERMINAL_RUN_STATES.has(r.state));
  const succeeded = runs.filter((r) => r.state === 'SUCCEEDED').length;
  const failed = runs.filter((r) => r.state === 'FAILED').length;
  const ages = [...tracker.worstByTenant.values()];
  let worst = 0;
  let worstTenant: string | null = null;
  for (const [tenant, age] of tracker.worstByTenant) {
    if (age > worst || worstTenant === null) {
      worst = age;
      worstTenant = tenant;
    }
  }
  const lastFinished = Math.max(m.triggeredAtMs, ...ended.map((r) => r.finishedAtMs ?? m.endedAtMs));
  const allEnded = ended.length === m.connections && !m.timedOut;
  const drainMs = (allEnded ? lastFinished : m.endedAtMs) - m.triggeredAtMs;
  const scheduledMs = runs.length === 0 ? 0 : Math.max(...runs.map((r) => r.createdAtMs)) - m.triggeredAtMs;
  const worstTriggerToStartMs =
    runs.length === 0 ? 0 : Math.max(...runs.map((r) => (r.startedAtMs ?? m.endedAtMs) - m.triggeredAtMs));
  const listings = mix.reduce((n, f) => n + f.listings, 0);
  const missing = Math.max(0, m.connections - runs.length);
  const unfinished = runs.length - ended.length;

  const failedThresholds: string[] = [];
  if (worst > p.maxQueueAgeMs)
    failedThresholds.push(`worst tenant queue age ${fmtMs(worst)} > ${fmtMs(p.maxQueueAgeMs)}`);
  // A scheduler that takes its time queueing the storm hides the wait from the run rows' queue age: a tenant waits
  // from the trigger, so trigger → started is judged against the same budget.
  if (worstTriggerToStartMs > p.maxQueueAgeMs)
    failedThresholds.push(`worst trigger → started ${fmtMs(worstTriggerToStartMs)} > ${fmtMs(p.maxQueueAgeMs)}`);
  if (m.timedOut) failedThresholds.push(`not drained within ${fmtMs(p.timeoutMs)}`);
  if (missing > 0) failedThresholds.push(`${missing} connections never got a run`);
  if (unfinished > 0) failedThresholds.push(`${unfinished} runs not finished`);
  if (failed > 0) failedThresholds.push(`${failed} runs FAILED`);
  return {
    profile: p.name,
    target: { feeds: p.feeds, maxQueueAgeMs: p.maxQueueAgeMs },
    feeds: mix.length,
    tenants: agenciesIn(mix),
    runs: { seen: runs.length, succeeded, failed, unfinished, missing },
    queueAgeMs: { worst, worstTenant, p95Tenant: percentile(ages, 0.95), p50Tenant: percentile(ages, 0.5) },
    drainMs,
    scheduledMs,
    worstTriggerToStartMs,
    listingsPerSecond: allEnded && drainMs > 0 ? Math.round((listings / drainMs) * 1000 * 10) / 10 : null,
    feedRequests: m.feedRequests,
    failedThresholds,
    pass: failedThresholds.length === 0,
  };
}

const profileLabel = (name: StormProfileName, sameAsAcceptance: boolean) =>
  name === ACCEPTANCE_PROFILE && sameAsAcceptance ? ' (the acceptance profile)' : ' — NOT the acceptance profile';

/** The import storm's summary (stdout, the STATUS entry and the runbook). */
export function importSummaryText(r: ImportReport): string {
  const lines = [
    `import storm — ${r.feeds} feeds over ${r.tenants} tenants triggered at once, queue age ≤ ${fmtMs(r.target.maxQueueAgeMs)}` +
      profileLabel(r.profile, r.feeds === IMPORT_STORM.feeds && r.target.maxQueueAgeMs === IMPORT_STORM.maxQueueAgeMs),
    `  runs ${r.runs.seen}: succeeded ${r.runs.succeeded}, failed ${r.runs.failed}, unfinished ${r.runs.unfinished}, never queued ${r.runs.missing}; feed requests ${r.feedRequests}`,
    `  queued by the scheduler in ${fmtMs(r.scheduledMs)}; drained in ${fmtMs(r.drainMs)}` +
      (r.listingsPerSecond === null ? '' : ` (${r.listingsPerSecond} listings/s)`),
    '  queue age per tenant      p50       p95     worst',
    `  created → started    ${fmtMs(r.queueAgeMs.p50Tenant).padStart(9)} ${fmtMs(r.queueAgeMs.p95Tenant).padStart(9)} ${fmtMs(r.queueAgeMs.worst).padStart(9)}` +
      (r.queueAgeMs.worstTenant ? `  (worst: agency ${r.queueAgeMs.worstTenant})` : ''),
    `  trigger → started (worst run, incl. scheduler lag) ${fmtMs(r.worstTriggerToStartMs)}`,
    r.pass ? '  PASS: every threshold held' : `  FAIL: ${r.failedThresholds.join('; ')}`,
  ];
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ import storm: the feeds */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TYPES = ['Villa', 'Apartment', 'Townhouse', 'Penthouse', 'Finca'] as const;
const TOWNS = [
  ['Marbella', 'Málaga'],
  ['Estepona', 'Málaga'],
  ['Alicante', 'Alicante'],
  ['Torrevieja', 'Alicante'],
  ['Jávea', 'Alicante'],
  ['Nerja', 'Málaga'],
] as const;

/** Reference of listing `i` of a storm feed: stable across runs, so a re-run updates rather than piles up listings. */
export const stormRef = (feed: number, i: number) => `STORM-${feed}-${i}`;

/**
 * A Kyero v3 feed (the format every deployed worker reads: no test connector on staging) of `listings` listings, no
 * images (the media pool is not under test), its text carrying `tag` so each run changes every listing.
 */
export function kyeroFeedXml(feed: number, listings: number, tag: string): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n<root><kyero><feed_version>3</feed_version></kyero>\n',
  ];
  for (let i = 0; i < listings; i++) {
    const n = feed * 7_919 + i;
    const [town, province] = TOWNS[n % TOWNS.length] as (typeof TOWNS)[number];
    out.push(
      `<property><id>${stormRef(feed, i)}</id><date>2026-10-01 10:00:00</date><ref>${stormRef(feed, i)}</ref>` +
        `<price>${150_000 + (n % 400) * 2_500}</price><currency>EUR</currency><price_freq>sale</price_freq>` +
        `<new_build>0</new_build><type>${TYPES[n % TYPES.length]}</type><town>${town}</town>` +
        `<province>${province}</province><country>Spain</country>` +
        `<location><latitude>${(36.4 + (n % 900) / 1_000).toFixed(4)}</latitude><longitude>${(-5.1 + (n % 600) / 1_000).toFixed(4)}</longitude></location>` +
        `<beds>${1 + (n % 5)}</beds><baths>${1 + (n % 3)}</baths><pool>${n % 2}</pool>` +
        `<surface_area><built>${60 + (n % 240)}</built></surface_area>` +
        `<energy_rating><consumption>${'ABCDEFG'[n % 7]}</consumption></energy_rating>` +
        `<desc><en>${esc(`Storm listing ${i} of feed ${feed}, run ${tag}. Bright home close to the beach.`)}</en>` +
        `<es>${esc(`Anuncio ${i} del feed ${feed}, ejecución ${tag}.`)}</es></desc></property>\n`,
    );
  }
  out.push('</root>\n');
  return out.join('');
}

/* ------------------------------------------------------------------ matching storm */

/** When change `i` of `n` is due, `windowMs` spread evenly (the first at 0). */
export const changeDueMs = (i: number, n: number, windowMs: number): number => (n <= 1 ? 0 : (i * windowMs) / n);

/** The changed price: 1 % lower (a real price drop: saved searches alert on it), whole euros, at least 1 € lower. */
export const droppedPrice = (cents: number): number =>
  Math.max(0, Math.min(cents - 100, Math.floor((cents * 0.99) / 100) * 100));

export interface ChangeSample {
  listingId: string;
  /** DB time the change committed (the listing's `updatedAt`). */
  changedAtMs: number;
  /** DB time matching wrote the listing's new state (version ≥ the change's), or null while not yet. */
  matchedAtMs: number | null;
}

export interface MatchingMeasured {
  /** Changes the profile asked for. */
  planned: number;
  /** Profiles (active saved searches) present during the run, and how many of them the driver provisioned. */
  profiles: number;
  provisioned: number;
  agencies: number;
  /** Changes that failed to apply (version conflicts after a retry, errors). */
  applyErrors: number;
  timedOut: boolean;
  /** DB time of the last sample. */
  endedAtMs: number;
  /** Saved-search alerts raised by the storm's listings since the first change. */
  alerts: number;
}

export interface MatchingReport {
  profile: StormProfileName;
  target: { changes: number; windowMs: number; maxProcessMs: number; profiles: number };
  applied: number;
  applyErrors: number;
  /** First → last change committed. */
  applySpanMs: number;
  matched: number;
  /** First change → every applied change matched (the acceptance number). */
  processMs: number;
  /** Last change → every applied change matched. */
  tailMs: number;
  lagMs: { p50: number; p95: number; max: number };
  profiles: number;
  provisioned: number;
  agencies: number;
  alerts: number;
  failedThresholds: string[];
  pass: boolean;
}

/** The matching storm's numbers and verdict: every change applied in the window and matched within the budget. */
export function matchingReport(
  p: MatchingProfile & { name: StormProfileName },
  changes: readonly ChangeSample[],
  m: MatchingMeasured,
): MatchingReport {
  const applied = changes.length;
  const first = applied === 0 ? m.endedAtMs : Math.min(...changes.map((c) => c.changedAtMs));
  const last = applied === 0 ? m.endedAtMs : Math.max(...changes.map((c) => c.changedAtMs));
  const matched = changes.filter((c) => c.matchedAtMs !== null);
  const lags = changes.map((c) => Math.max(0, (c.matchedAtMs ?? m.endedAtMs) - c.changedAtMs));
  const doneAt =
    matched.length === applied && applied > 0 ? Math.max(...matched.map((c) => c.matchedAtMs as number)) : m.endedAtMs;
  const processMs = doneAt - first;
  const failedThresholds: string[] = [];
  if (applied < m.planned) failedThresholds.push(`${m.planned - applied} of ${m.planned} changes not applied`);
  // the driver must have kept the pace: a slow apply would spread the storm thinner than the target
  if (last - first > p.windowMs * 1.1)
    failedThresholds.push(`changes took ${fmtMs(last - first)} > ${fmtMs(p.windowMs)} (+10 %)`);
  if (matched.length < applied) failedThresholds.push(`${applied - matched.length} changes not matched`);
  if (processMs > p.maxProcessMs) failedThresholds.push(`processed in ${fmtMs(processMs)} > ${fmtMs(p.maxProcessMs)}`);
  if (m.profiles < p.profiles) failedThresholds.push(`${m.profiles} client profiles < ${p.profiles}`);
  if (m.timedOut) failedThresholds.push(`not matched within ${fmtMs(p.timeoutMs)}`);
  return {
    profile: p.name,
    target: { changes: p.changes, windowMs: p.windowMs, maxProcessMs: p.maxProcessMs, profiles: p.profiles },
    applied,
    applyErrors: m.applyErrors,
    applySpanMs: last - first,
    matched: matched.length,
    processMs,
    tailMs: doneAt - last,
    lagMs: { p50: percentile(lags, 0.5), p95: percentile(lags, 0.95), max: lags.length ? Math.max(...lags) : 0 },
    profiles: m.profiles,
    provisioned: m.provisioned,
    agencies: m.agencies,
    alerts: m.alerts,
    failedThresholds,
    pass: failedThresholds.length === 0,
  };
}

/** The matching storm's summary. */
export function matchingSummaryText(r: MatchingReport): string {
  const t = r.target;
  const acceptance =
    t.changes === MATCHING_STORM.changes &&
    t.windowMs === MATCHING_STORM.windowMs &&
    t.maxProcessMs === MATCHING_STORM.maxProcessMs &&
    t.profiles === MATCHING_STORM.profiles;
  const lines = [
    `matching storm — ${t.changes} listing changes over ${fmtMs(t.windowMs)} against ${t.profiles} client profiles, processed ≤ ${fmtMs(t.maxProcessMs)}` +
      profileLabel(r.profile, acceptance),
    `  applied ${r.applied} changes over ${r.agencies} agencies in ${fmtMs(r.applySpanMs)} (errors ${r.applyErrors}); profiles ${r.profiles} (${r.provisioned} provisioned for the run); alerts raised ${r.alerts}`,
    `  matched ${r.matched}/${r.applied}: processed in ${fmtMs(r.processMs)} from the first change, ${fmtMs(r.tailMs)} after the last`,
    '  change → matched          p50       p95       max',
    `  lag                  ${fmtMs(r.lagMs.p50).padStart(9)} ${fmtMs(r.lagMs.p95).padStart(9)} ${fmtMs(r.lagMs.max).padStart(9)}`,
    r.pass ? '  PASS: every threshold held' : `  FAIL: ${r.failedThresholds.join('; ')}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** `1.2 s`, `4 min 05 s`. */
export function fmtMs(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}
