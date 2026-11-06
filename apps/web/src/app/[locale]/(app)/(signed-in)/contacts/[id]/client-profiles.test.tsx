import type { ClientProfileDto } from '@inmolink/contracts';
import { loadMessages } from '@inmolink/i18n/server';
import { createTranslator } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { listingTaxonomy } from '../../listings/taxonomy';
import { ClientProfiles } from './client-profiles';
import { parseProfileForm, parseVersion, profileFormValues } from './profile-form';

vi.mock('@/i18n/navigation', () => ({
  Link: (p: { href: unknown; children: unknown; 'aria-label'?: string }) => (
    <a href={JSON.stringify(p.href)} aria-label={p['aria-label']}>
      {p.children as string}
    </a>
  ),
}));

const uuid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const [CONTACT, VILLA, CITY, POOL] = [uuid(1), uuid(2), uuid(3), uuid(4)];

const tax = listingTaxonomy({
  propertyTypes: [{ id: uuid(20), name: 'Homes', types: [{ id: VILLA, name: 'Villa' }] }],
  locations: [{ id: CITY, name: 'Marbella', children: [] }],
  features: [{ id: uuid(21), name: 'Outdoor', features: [{ id: POOL, name: 'Pool' }] }],
} as never);

const profile = (patch: Partial<ClientProfileDto> = {}): ClientProfileDto => ({
  id: uuid(10),
  contactId: CONTACT,
  mode: 'REVIEW',
  frequency: 'DAILY',
  transactionType: 'SALE',
  propertyTypeIds: [VILLA],
  locationIds: [CITY],
  featureIds: [POOL],
  priceMinCents: null,
  priceMaxCents: 60_000_000,
  bedsMin: 3,
  bathsMin: null,
  areaMinM2: null,
  areaMaxM2: null,
  wishes: 'Sea view',
  version: 4,
  createdAt: '2026-11-07T10:00:00.000Z',
  updatedAt: '2026-11-07T10:00:00.000Z',
  ...patch,
});

function render(locale: 'en' | 'es', props: Partial<Parameters<typeof ClientProfiles>[0]> = {}) {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: 'contacts.profiles' });
  return renderToStaticMarkup(
    <ClientProfiles
      contactId={CONTACT}
      profiles={[profile()]}
      editing={null}
      conflict={false}
      tax={tax}
      t={(key, values) => t(key as never, values as never)}
      euros={(c) => `€${c / 100}`}
      actions={{ save: '/save', delete: '/delete' }}
      {...props}
    />,
  );
}

const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) f.append(k, x);
  return f;
};

describe('client profiles on the contact page (R2-02d)', () => {
  it('[R2-02d] lists profiles with criteria, mode and labelled actions, in EN and ES', () => {
    const en = render('en');
    expect(en).toContain('Search profiles');
    expect(en).toContain('Buy · Villa · Marbella · … – €600000 · 3 bedrooms or more · Must-haves: Pool');
    expect(en).toContain('Review matches · Daily');
    expect(en).toContain('aria-label="Edit search profile 1"');
    expect(en).toContain('aria-label="Delete search profile 1"');
    expect(en).toContain('aria-label="Matches of search profile 1"');
    const es = render('es');
    expect(es).toContain('Perfiles de búsqueda');
    expect(es).toContain('Revisar coincidencias · A diario');
    expect(render('en', { profiles: [] })).toContain('No search profiles yet.');
    expect(render('en', { profiles: null })).toContain('role="alert"');
  });

  it('[R2-02d] the form creates, or edits at the profile’s version with its values; a conflict is announced', () => {
    const create = render('en');
    expect(create).toContain('New search profile');
    expect(create).not.toContain('name="version"');
    // every field has a label (wrapping label or legend)
    for (const name of [
      'mode',
      'frequency',
      'transactionType',
      'propertyTypeIds',
      'locationIds',
      'priceMin',
      'wishes',
    ]) {
      expect(create).toMatch(new RegExp(`<label[^>]*><span>[^<]+</span><(select|input|textarea)[^>]*name="${name}"`));
    }
    expect(create).toContain('<legend class="mb-1">Must-haves</legend>');
    const edit = render('en', { editing: profile(), conflict: true });
    expect(edit).toContain('Edit search profile');
    expect(edit).toContain('name="version" value="4"');
    expect(edit).toContain('value="600000"');
    expect(edit).toMatch(/value="[^"]+" checked=""|checked="" value=/);
    expect(edit).toContain('Someone changed this profile meanwhile');
  });

  it('[R2-02d] the posted form becomes a contract body (euros → cents, empty → unset); bad input is refused', () => {
    const ok = parseProfileForm(
      form({
        mode: 'AUTO_SEND',
        frequency: 'WEEKLY',
        transactionType: 'SALE',
        propertyTypeIds: [VILLA, VILLA],
        locationIds: CITY,
        featureIds: POOL,
        priceMin: '',
        priceMax: '600000',
        bedsMin: '3',
        bathsMin: '',
        areaMin: '80,5',
        areaMax: '',
        wishes: '  Sea view ',
      }),
    );
    expect(ok).toEqual({
      ok: true,
      body: expect.objectContaining({
        mode: 'AUTO_SEND',
        frequency: 'WEEKLY',
        transactionType: 'SALE',
        propertyTypeIds: [VILLA],
        locationIds: [CITY],
        featureIds: [POOL],
        priceMinCents: null,
        priceMaxCents: 60_000_000,
        bedsMin: 3,
        bathsMin: null,
        areaMinM2: 80.5,
        wishes: 'Sea view',
      }),
    });
    const base = { mode: 'REVIEW', frequency: 'DAILY' };
    expect(parseProfileForm(form({ ...base, transactionType: '' }))).toMatchObject({ ok: true });
    for (const bad of [
      { mode: 'ALWAYS', frequency: 'DAILY' },
      { ...base, priceMax: '12.5' },
      { ...base, bedsMin: 'three' },
      { ...base, locationIds: 'marbella' },
      { ...base, priceMin: '900', priceMax: '100' },
    ]) {
      expect(parseProfileForm(form(bad))).toEqual({ ok: false });
    }
    expect(parseVersion(form({ version: '4' }))).toBe(4);
    expect(parseVersion(form({ version: '0' }))).toBeNull();
    expect(profileFormValues(null)).toMatchObject({ mode: 'REVIEW', frequency: 'DAILY', priceMax: '' });
  });
});
