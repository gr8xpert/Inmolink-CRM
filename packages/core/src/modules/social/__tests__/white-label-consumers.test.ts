import type { ListingDetailDoc } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { whiteLabelLeaks } from '../../../testing/white-label';
import { fixtureLeaks, missingFacts, sanitizerFixture } from '../../../testing/white-label-fixtures';
import { compileOwner, NO_OWNER, plainText, textKey } from '../../../white-label';
import { whiteLabelListingText, whiteLabelListingTextWith } from '../../../white-label-listing';

/**
 * S13-F11: one white-label pass for a listing's texts (`whiteLabelListingText`) and one "present public docs" read
 * (`websiteApi.presentPublicDocs`). Every consumer is driven here through its public entry, with the reads underneath
 * faked: the owner's identity and cached model removals, the read models, the view. A network listing's text loses
 * the owner's identity, references and indirect mentions everywhere; the viewer's own listing keeps its text.
 */

const AGENCY = '01900000-0000-7000-8000-0000000000a1';
const OWNER = '01900000-0000-7000-8000-0000000000b2';
const TARGET = '01900000-0000-7000-8000-0000000000c3';
const OWN_TARGET = '01900000-0000-7000-8000-0000000000c4';
const TOKEN = 'a'.repeat(43);

const f = sanitizerFixture(3);
const indirect = f.indirect.map((i) => i.sentence);
const removals = new Map([[textKey(plainText(f.description)), indirect]]);

const taxon = (name: string) => ({ id: '01900000-0000-7000-8000-0000000000d1', name, slug: name.toLowerCase() });
function detail(id: string, ref: string, title: string, description: string): ListingDetailDoc {
  return {
    kind: 'LISTING',
    id,
    ref,
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: 45_000_000, currency: 'EUR', period: null, onRequest: false },
    propertyType: taxon('Villa'),
    place: { country: taxon('Spain'), region: null, city: taxon('San Juan'), area: null },
    bedrooms: 3,
    bathrooms: 2,
    builtM2: 180,
    plotM2: null,
    geo: null,
    cover: null,
    imageCount: 0,
    developmentId: null,
    title,
    slug: 'villa',
    textLocale: null,
    description,
    metaTitle: null,
    metaDescription: null,
    terraceM2: null,
    yearBuilt: 2010,
    priceToCents: null,
    communityFeeMonthCents: null,
    ibiYearCents: null,
    garbageTaxYearCents: null,
    energyRating: 'B',
    energyEmissionsRating: null,
    features: [],
    media: [],
  };
}

const docRows = [
  {
    targetId: TARGET,
    kind: 'LISTING',
    ownerAgencyId: OWNER,
    publicCode: 'AB12CD34',
    developmentCode: null,
    developmentOwnRef: null,
    doc: detail(TARGET, f.ref, `Villa by ${f.owner.name}`, f.description),
    updatedAt: new Date(),
    locale: 'en',
  },
  {
    targetId: OWN_TARGET,
    kind: 'LISTING',
    ownerAgencyId: AGENCY,
    publicCode: 'ZZ99ZZ99',
    developmentCode: null,
    developmentOwnRef: null,
    doc: detail(OWN_TARGET, 'OWN-1', 'Our own villa', 'Call us on +34 600 000 001.'),
    updatedAt: new Date(),
    locale: 'en',
  },
];

const reads = vi.hoisted(() => ({ ownerIdentities: 0, aiRemovals: 0, presented: 0 }));

vi.mock('@inmolink/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withPublicRead: (fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('../../../white-label-store', () => ({
  readAiRemovals: async (targets: { targetId: string }[]) => {
    reads.aiRemovals += 1;
    return new Map(targets.filter((t) => t.targetId === TARGET).map((t) => [t.targetId, removals]));
  },
}));
vi.mock('../../agencies', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerIdentities: async (_tx: unknown, ids: string[]) => {
    reads.ownerIdentities += 1;
    return new Map(ids.filter((id) => id === OWNER).map((id) => [id, f.identity]));
  },
  publicAgencies: async () => new Map(),
}));
vi.mock('../../search', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publicDocs: async (_tx: unknown, ids: string[]) => docRows.filter((r) => ids.includes(r.targetId)),
  networkPresentable: async (_tx: unknown, _agency: string, ids: string[]) => new Set(ids),
}));
vi.mock('../../website-api/service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The view `viewWith` reads (one statement + one MGET): the owner's compiled identity and cached removals.
  viewWith: async (_tx: unknown, site: { scope: { agencyId: string; presenter: unknown } }) => {
    reads.presented += 1;
    return {
      view: {
        site: { agencyId: site.scope.agencyId, referencePrefix: null },
        presenter: site.scope.presenter,
        mediaBaseUrl: 'https://media.example',
        owners: new Map([[OWNER, f.identity]]),
        matchers: new Map([[OWNER, compileOwner(f.identity)]]),
        aiRemovals: new Map([[TARGET, removals]]),
      },
      extra: undefined,
    };
  },
}));
vi.mock('../../properties/policy', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertCan: () => undefined,
}));
vi.mock('../../properties/repo', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getListing: async (_tx: unknown, id: string) => ({
    id,
    agencyId: id === TARGET ? OWNER : AGENCY,
    ref: id === TARGET ? f.ref : 'OWN-1',
    version: 3,
    deletedAt: null,
  }),
  listTranslations: async () => [
    {
      locale: 'en',
      title: `Villa by ${f.owner.name}`,
      description: f.description,
      slug: 'villa',
      metaTitle: `${f.owner.name} | ${f.ref}`,
      metaDescription: null,
      origin: 'HUMAN',
      locked: false,
      updatedAt: new Date('2026-10-01T00:00:00Z'),
    },
  ],
  listFeatureIds: async () => [],
}));
vi.mock('../../presentations/repo', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  liveSelectionByTokenHash: async () => ({
    id: '01900000-0000-7000-8000-0000000000e1',
    agencyId: AGENCY,
    title: 'Villas for Ana',
    message: null,
    locale: 'en',
    expiresAt: null,
    items: [
      { targetId: TARGET, position: 0, titleOverride: null, note: `Ask ${f.owner.name}: ${f.owner.phone}` },
      { targetId: OWN_TARGET, position: 1, titleOverride: null, note: 'Our own, <i>keys</i> at the office' },
    ],
  }),
}));

const tx = {} as Tx;
const leaksOf = (texts: readonly (string | null | undefined)[]) => {
  const text = texts.filter((t): t is string => typeof t === 'string').join('\n');
  return [...fixtureLeaks(f, text, { indirect: true }), ...whiteLabelLeaks(text, { ...f.owner, agencyId: OWNER })];
};

describe('one white-label pass and one public-docs read (S13-F11)', () => {
  beforeAll(async () => {
    const { configurePresentations } = await import('../../presentations');
    configurePresentations({ tokenKey: 'test-hmac-key-0123456789abcdef0123456789' });
  });
  beforeEach(() => {
    reads.ownerIdentities = 0;
    reads.aiRemovals = 0;
    reads.presented = 0;
  });

  it('[S13-F11] the helper: identity, references and cached removals out of another agency’s text; own text kept', async () => {
    const network = { id: TARGET, agencyId: OWNER, ref: f.ref, developmentOwnRef: 'DEV-OWN-77' };
    const [description, ref, none] = await whiteLabelListingText(tx, network, AGENCY, [
      f.description,
      `See DEV-OWN-77 and Ref. ${f.ref}`,
      null,
    ] as const);
    expect(leaksOf([description, ref])).toEqual([]);
    expect(missingFacts(f, description)).toEqual([]);
    expect(ref).not.toMatch(/DEV-OWN-77/);
    expect(none).toBeNull();
    expect(reads).toMatchObject({ ownerIdentities: 1, aiRemovals: 1 });
    // The viewer's own listing: as written (or the caller's own pass), and nothing read.
    const own = { id: OWN_TARGET, agencyId: AGENCY, ref: 'OWN-1' };
    expect(await whiteLabelListingText(tx, own, AGENCY, ['<b>Ours</b> OWN-1'] as const)).toEqual(['<b>Ours</b> OWN-1']);
    expect(whiteLabelListingTextWith(null, own, AGENCY, ['<b>Ours</b>'] as const, { own: plainText })).toEqual([
      'Ours',
    ]);
    expect(reads).toMatchObject({ ownerIdentities: 1, aiRemovals: 1 });
    // Without owner facts the generic patterns still apply.
    const [generic] = whiteLabelListingTextWith(null, network, AGENCY, ['Mail x@y.example'] as const);
    expect(generic).toBe(compileOwner(NO_OWNER).clean('Mail x@y.example'));
  });

  it('[S13-F11] every consumer white-labels through it: listing content, social captions, selections, listing PDFs', async () => {
    const properties = await import('../../properties');
    const social = await import('../publish');
    const presentations = await import('../../presentations');
    const documents = await import('../../documents');
    const ctx = { tx, tenant: { agencyId: AGENCY }, clientMode: true } as unknown as Ctx;

    // Listing content in Client Mode (S12-06): one identity read and one MGET for all of its texts.
    const content = await properties.getListingContent(ctx, TARGET);
    const t = content.translations[0];
    expect(leaksOf([t?.title, t?.description, t?.metaTitle])).toEqual([]);
    expect(missingFacts(f, t?.description ?? '')).toEqual([]);
    expect(reads).toMatchObject({ ownerIdentities: 1, aiRemovals: 1 });
    // …the agency's own listing (or no Client Mode): as stored.
    const ownContent = await properties.getListingContent(ctx, OWN_TARGET);
    expect(ownContent.translations[0]?.description).toBe(f.description);

    // Social captions (S12-07): another agency's listing loses its owner; the agency's own only generic contacts.
    const caption = await social.whiteLabelled(tx, f.description, { id: TARGET, agencyId: OWNER, ref: f.ref }, AGENCY);
    expect(leaksOf([caption])).toEqual([]);
    expect(missingFacts(f, caption)).toEqual([]);
    const ownCaption = await social.whiteLabelled(
      tx,
      'Our villa: info@ours.example',
      { id: OWN_TARGET, agencyId: AGENCY, ref: 'OWN-1' },
      AGENCY,
    );
    expect(ownCaption).toBe('Our villa:');

    // Selections (S12-04): the document and the agent's note, through `presentPublicDocs`.
    const page = await presentations.selectionPage(TOKEN);
    const [network, own] = page.items;
    expect(leaksOf([network?.detail?.title, network?.detail?.description, network?.note])).toEqual([]);
    expect(network?.detail?.ref).toBe('W-AB12CD34');
    expect(own?.note).toBe('Our own, keys at the office');
    expect(own?.detail?.description).toBe('Call us on +34 600 000 001.');

    // Listing PDFs (S12-05): the same read, in the requested order.
    const pdf = await documents.loadDocumentListings({
      agencyId: AGENCY,
      listingIds: [OWN_TARGET, TARGET],
      locale: 'en',
    });
    expect(pdf.items.map((d) => d.ref)).toEqual([own?.detail?.ref, 'W-AB12CD34']);
    expect(leaksOf([pdf.items[1]?.title, pdf.items[1]?.description])).toEqual([]);
    expect(missingFacts(f, pdf.items[1]?.description ?? '')).toEqual([]);
    expect(reads.presented).toBe(2);
  });
});
