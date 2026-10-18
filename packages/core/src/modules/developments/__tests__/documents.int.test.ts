import { CreateDevelopmentBody, CreatePriceListBody, type DevelopmentDto } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import {
  configureDocumentScanner,
  configureStorage,
  createS3Store,
  storage,
  storageConfigFromEnv,
} from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as developments from '../index';

/** Development documents (S4-F4): private PDFs, shared ones readable where the development is. MinIO as R2. */

const RUN = newId().slice(-8).toLowerCase();
const code = (s: string) => `${s}-${RUN}`;

let owner: Founder;
let allowed: Founder;
let stranger: Founder;
let locationId: string;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>, clientMode = false) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, (ctx) =>
    fn(clientMode ? { ...ctx, clientMode: true } : ctx),
  );
/** The owner's member with the PARTNER role (the role is per request; the service reads it from `ctx`). */
const asPartner = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  as(m, (ctx) => fn({ ...ctx, actor: { ...ctx.actor, role: 'PARTNER' } as Ctx['actor'] }));
const runner =
  (m: Founder) =>
  <T>(fn: (ctx: Ctx) => Promise<T>) =>
    as(m, fn);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string }) => err.code ?? String(err),
  );
const rows = <T>(q: ReturnType<typeof sql>) =>
  withSystem('developments.documents.test', async (tx) => (await tx.execute(q)).rows as T[]);

/** A PDF-looking file unique to this run (magic bytes, then filler). */
const pdf = (label: string) => new TextEncoder().encode(`%PDF-1.7\n% ${RUN} ${label}\n%%EOF\n`);
const pngBytes = (label: string) => {
  const bytes = new Uint8Array(512);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set(new TextEncoder().encode(label), 16);
  return bytes;
};

const log = createLogger({ service: 'test', level: 'silent' });
const jobCtx = () => ({
  log,
  jobId: 'test',
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});
const keys: string[] = [];
const keyOf = (dev: { id: string }, docId: string) =>
  developments.developmentDocumentKey(owner.agencyId, dev.id, docId);

let seq = 0;
/** A development of the owner, shared with `allowed` only. */
async function sharedDev(): Promise<DevelopmentDto> {
  const dev = await as(owner, (ctx) =>
    developments.createDevelopment(
      ctx,
      CreateDevelopmentBody.parse({ ref: code(`DD${++seq}`), name: 'Docs Heights', locationId }),
    ),
  );
  return as(owner, (ctx) =>
    developments.setDevelopmentAccess(ctx, dev.id, {
      version: dev.version,
      kind: 'PRIVATE_NETWORK',
      allowedAgencyIds: [allowed.agencyId],
    }),
  );
}

const upload = (dev: { id: string }, label: string, over: { kind?: 'BROCHURE' | 'LEGAL'; shared?: boolean } = {}) =>
  developments
    .uploadDevelopmentDocument(runner(owner), {
      developmentId: dev.id,
      fileName: `${label}.pdf`,
      body: pdf(label),
      ...over,
    })
    .then((d) => {
      keys.push(keyOf(dev, d.id));
      return d;
    });

/** The dispatcher's part: the delete job for the document's `developments.document.deleted` event. */
async function runDeleteJob(documentId: string): Promise<void> {
  const [e] = await rows<{ id: string; agency_id: string; payload: { developmentId: string; documentId: string } }>(
    sql`select id, agency_id, payload from outbox_events
         where type = 'developments.document.deleted' and payload->>'documentId' = ${documentId}`,
  );
  if (!e) throw new Error('no developments.document.deleted event');
  await developments.developmentsJobs.deleteDocumentObject.spec.run(
    {
      eventId: e.id,
      agencyId: e.agency_id,
      developmentId: e.payload.developmentId,
      documentId: e.payload.documentId,
    },
    jobCtx(),
  );
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  [owner, allowed, stranger] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  for (const f of [owner, allowed, stranger]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  locationId = await withSystem('developments.documents.test', (tx) =>
    taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('dd'),
      translations: [{ locale: 'en', name: `Docland ${RUN}`, slug: code('docland') }],
    }),
  );
}, 120_000);

afterAll(async () => {
  for (const k of keys)
    await storage()
      .delete('private', k)
      .catch(() => {});
  await closeDb();
});

describe('development documents', () => {
  it('[S4-F4] a shared brochure is readable by an allowed agency and a non-shared contract is not', async () => {
    const dev = await sharedDev();
    const brochure = await upload(dev, 'brochure', { kind: 'BROCHURE', shared: true });
    const contract = await upload(dev, 'contract', { kind: 'LEGAL' });
    expect(brochure).toMatchObject({ kind: 'BROCHURE', shared: true, fileName: 'brochure.pdf' });
    expect(contract).toMatchObject({ kind: 'LEGAL', shared: false });

    // The owner sees both; the allowed agency the brochure only; another agency not the development at all.
    const ids = async (m: Founder) => (await as(m, (ctx) => developments.listDevelopmentDocuments(ctx, dev.id))).items;
    expect((await ids(owner)).map((d) => d.id)).toEqual([brochure.id, contract.id]);
    expect((await ids(allowed)).map((d) => d.id)).toEqual([brochure.id]);
    expect(await refusal(ids(stranger))).toBe('DEVELOPMENT_NOT_FOUND');

    const open = (m: Founder, documentId: string) =>
      as(m, (ctx) => developments.openDevelopmentDocument(ctx, { developmentId: dev.id, documentId }));
    const opened = await open(allowed, brochure.id);
    const res = await fetch(opened.url);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf('brochure'));
    expect(await refusal(open(allowed, contract.id))).toBe('DEVELOPMENT_DOCUMENT_NOT_FOUND');
    expect(await refusal(open(stranger, brochure.id))).toBe('DEVELOPMENT_NOT_FOUND');
    expect((await open(owner, contract.id)).url).toContain(contract.id);

    // Opening is audited in the opener's agency, naming the development.
    const audit = await rows<{ type: string; agency_id: string; metadata: { developmentId: string } }>(
      sql`select type, agency_id, metadata from audit_logs
           where target_type = 'developmentDocument' and target_id = ${brochure.id} order by id`,
    );
    expect(audit.map((a) => [a.type, a.agency_id])).toEqual([
      ['developments.document.uploaded', owner.agencyId],
      ['developments.document.opened', allowed.agencyId],
    ]);
    expect(audit[1]?.metadata.developmentId).toBe(dev.id);

    // Only the owner changes them; unsharing hides the brochure again. Client Mode never reads documents.
    expect(
      await refusal(
        as(allowed, (ctx) =>
          developments.updateDevelopmentDocument(ctx, {
            developmentId: dev.id,
            documentId: brochure.id,
            patch: { shared: false },
          }),
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await refusal(
        developments.uploadDevelopmentDocument(runner(allowed), {
          developmentId: dev.id,
          fileName: 'x.pdf',
          body: pdf('intruder'),
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(await refusal(as(owner, (ctx) => developments.listDevelopmentDocuments(ctx, dev.id), true))).toBe(
      'FORBIDDEN',
    );
    await as(owner, (ctx) =>
      developments.updateDevelopmentDocument(ctx, {
        developmentId: dev.id,
        documentId: brochure.id,
        patch: { shared: false },
      }),
    );
    expect(await ids(allowed)).toEqual([]);
  });

  it('[S5-F1] a PARTNER member of the owner cannot open a non-shared development document', async () => {
    const dev = await sharedDev();
    const brochure = await upload(dev, 'p-brochure', { kind: 'BROCHURE', shared: true });
    const contract = await upload(dev, 'p-contract', { kind: 'LEGAL' });
    const list = await asPartner(owner, (ctx) => developments.listDevelopmentDocuments(ctx, dev.id));
    expect(list.items.map((d) => d.id)).toEqual([brochure.id]);
    const open = (documentId: string) =>
      asPartner(owner, (ctx) => developments.openDevelopmentDocument(ctx, { developmentId: dev.id, documentId }));
    expect(await refusal(open(contract.id))).toBe('FORBIDDEN');
    expect((await open(brochure.id)).url).toContain(brochure.id);
    // The refused open leaves no "opened" entry.
    const opened = await rows<{ n: number }>(
      sql`select count(*)::int as n from audit_logs
           where type = 'developments.document.opened' and target_id = ${contract.id}`,
    );
    expect(opened[0]?.n).toBe(0);
  });

  it('[S5-F1] re-uploading the same file with another kind or sharing changes that document (share check applies)', async () => {
    const dev = await sharedDev();
    const doc = await upload(dev, 'again', { kind: 'BROCHURE' });
    // Another kind: the same document, re-classified.
    const reKinded = await upload(dev, 'again', { kind: 'LEGAL' });
    expect(reKinded).toMatchObject({ id: doc.id, kind: 'LEGAL', shared: false });
    // Sharing it through a re-upload needs the share right, like a PATCH: an agent is refused.
    const asAgent = <T>(fn: (ctx: Ctx) => Promise<T>) =>
      as(owner, (ctx) => fn({ ...ctx, actor: { ...ctx.actor, role: 'AGENT' } as Ctx['actor'] }));
    expect(
      await refusal(
        developments.uploadDevelopmentDocument(asAgent, {
          developmentId: dev.id,
          fileName: 'again.pdf',
          body: pdf('again'),
          shared: true,
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(await upload(dev, 'again', { shared: true })).toMatchObject({ id: doc.id, kind: 'LEGAL', shared: true });
    // Each change is in the log as `document.changed`, as a PATCH would be.
    const changes = await rows<{ metadata: Record<string, unknown> }>(
      sql`select metadata from audit_logs where type = 'developments.document.changed' and target_id = ${doc.id} order by id`,
    );
    expect(
      changes.map((c) => [c.metadata.kindBefore, c.metadata.kind, c.metadata.sharedBefore, c.metadata.shared]),
    ).toEqual([
      ['BROCHURE', 'LEGAL', false, false],
      ['LEGAL', 'LEGAL', false, true],
    ]);
    expect((await as(allowed, (ctx) => developments.listDevelopmentDocuments(ctx, dev.id))).items).toHaveLength(1);
    // An agent may re-upload with the same sharing (nothing to share): the row is answered as it is.
    expect(
      await developments.uploadDevelopmentDocument(asAgent, {
        developmentId: dev.id,
        fileName: 'again.pdf',
        body: pdf('again'),
        kind: 'LEGAL',
      }),
    ).toMatchObject({ id: doc.id, kind: 'LEGAL', shared: true });
  });

  it("[S4-F4] a renamed non-PDF is refused and a deleted document's object is removed by the worker", async () => {
    const dev = await sharedDev();
    // The real type decides: an image renamed to .pdf is refused; a configured scanner can refuse a PDF.
    expect(
      await refusal(
        developments.uploadDevelopmentDocument(runner(owner), {
          developmentId: dev.id,
          fileName: 'plan.pdf',
          body: pngBytes('plan'),
        }),
      ),
    ).toBe('DOCUMENT_TYPE_NOT_ALLOWED');
    configureDocumentScanner(async () => 'infected');
    try {
      expect(await refusal(upload(dev, 'virus'))).toBe('DOCUMENT_TYPE_NOT_ALLOWED');
    } finally {
      configureDocumentScanner(async () => 'clean');
    }
    expect((await as(owner, (ctx) => developments.listDevelopmentDocuments(ctx, dev.id))).items).toEqual([]);

    const doc = await upload(dev, 'pricelist');
    // A retried upload of the same file answers with the same document (and stores nothing new).
    expect((await upload(dev, 'pricelist')).id).toBe(doc.id);
    expect(await storage().head('private', keyOf(dev, doc.id))).not.toBeNull();

    // A price list names it as its source; another development's document is refused as a source.
    const other = await sharedDev();
    const foreign = await upload(other, 'foreign');
    const priceList = (sourceDocumentId: string) =>
      as(owner, (ctx) =>
        developments.createPriceList(
          ctx,
          dev.id,
          CreatePriceListBody.parse({
            effectiveFrom: '2026-11-01',
            sourceDocumentId,
            entries: [{ ref: 'A1', priceCents: 30_000_000 }],
          }),
        ),
      );
    expect(await refusal(priceList(foreign.id))).toBe('VALIDATION_FAILED');
    const list = await priceList(doc.id);
    expect(list.sourceDocumentId).toBe(doc.id);

    await as(owner, (ctx) =>
      developments.deleteDevelopmentDocument(ctx, { developmentId: dev.id, documentId: doc.id }),
    );
    expect((await as(owner, (ctx) => developments.listDevelopmentDocuments(ctx, dev.id))).items).toEqual([]);
    expect(
      (await as(owner, (ctx) => developments.getPriceList(ctx, dev.id, list.version))).sourceDocumentId,
    ).toBeNull();
    // The row is gone at once; the object goes with the worker's job for the event.
    expect(await storage().head('private', keyOf(dev, doc.id))).not.toBeNull();
    await runDeleteJob(doc.id);
    expect(await storage().head('private', keyOf(dev, doc.id))).toBeNull();
    expect(
      await refusal(
        as(owner, (ctx) => developments.deleteDevelopmentDocument(ctx, { developmentId: dev.id, documentId: doc.id })),
      ),
    ).toBe('DEVELOPMENT_DOCUMENT_NOT_FOUND');
  });

  it('[S4-F4] an hour-old development-documents/ object without a row is swept; one with a row stays', async () => {
    const dev = await sharedDev();
    const kept = await upload(dev, 'kept');
    const orphan = keyOf(dev, newId());
    keys.push(orphan);
    await storage().put('private', orphan, pdf('orphan'), { contentType: 'application/pdf' });
    const sweep = () => developments.developmentsJobs.sweepOrphanDocuments.spec.run({}, jobCtx());

    await sweep(); // younger than an hour: may still be between store and record
    expect(await storage().head('private', orphan)).not.toBeNull();
    useFakeClock(Date.now() + developments.DEVELOPMENT_DOCUMENT_ORPHAN_MIN_AGE_MS + 60_000);
    try {
      await sweep();
    } finally {
      restoreClock();
    }
    expect(await storage().head('private', orphan)).toBeNull();
    expect(await storage().head('private', keyOf(dev, kept.id))).not.toBeNull();
  });
});
