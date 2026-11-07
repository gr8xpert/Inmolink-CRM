import type { SignatureRequestDto } from '@inmolink/contracts';
import { loadMessages } from '@inmolink/i18n/server';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FormList, PlaceholderNotice, RequestTimeline, SignerRows, type T } from './parts';
import { errorKey, errorOf, GENERATED_TEMPLATES, reasonOf, requestOptionsOf, signersOf, templateOf } from './query';

const uuid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);

const translator = (locale: 'en' | 'es'): T => {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: 'documents.dashboard' });
  return (key, values) => t(key as never, values as never);
};
const date = (iso: string) => iso.slice(0, 10);

const fields = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

const request = (patch: Partial<SignatureRequestDto> = {}): SignatureRequestDto => ({
  id: uuid(1),
  formId: uuid(2),
  provider: 'builtin',
  status: 'COMPLETED',
  ordered: true,
  documentSha256: SHA,
  signedSha256: 'b'.repeat(64),
  signedSizeBytes: 2000,
  message: null,
  expiresAt: '2026-11-21T10:00:00.000Z',
  createdByUserId: uuid(3),
  createdAt: '2026-11-07T10:00:00.000Z',
  allSignedAt: '2026-11-08T10:00:00.000Z',
  completedAt: '2026-11-08T10:05:00.000Z',
  cancelledAt: null,
  signers: [
    {
      id: uuid(4),
      position: 1,
      role: 'buyer',
      name: 'Bruno',
      email: 'bruno@example.com',
      locale: 'en',
      invitedAt: '2026-11-07T10:01:00.000Z',
      signedAt: '2026-11-07T12:00:00.000Z',
      signatureKind: 'DRAWN',
      signedIp: '203.0.113.7',
    },
    {
      id: uuid(5),
      position: 2,
      role: 'agency',
      name: 'Ana',
      email: 'ana@example.com',
      locale: 'es',
      invitedAt: null,
      signedAt: null,
      signatureKind: null,
      signedIp: null,
    },
  ],
  url: null,
  urlExpiresAt: null,
  ...patch,
});

describe('[R2-05c] forms screens', () => {
  it('[R2-05c] every forms screen says the clauses are placeholders, not for use with clients (EN and ES)', () => {
    expect(renderToStaticMarkup(<PlaceholderNotice t={translator('en')} />)).toContain('not for use with clients');
    expect(renderToStaticMarkup(<PlaceholderNotice t={translator('es')} />)).toContain('no usar con clientes');
    const list = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{}}>
        <FormList
          t={translator('en')}
          date={date}
          items={[
            {
              id: uuid(9),
              template: 'OFFER',
              locale: 'en',
              templateVersion: 1,
              status: 'READY',
              label: 'R-100 · Bruno',
              listingId: uuid(10),
              contactId: uuid(11),
              dealId: null,
              sha256: SHA,
              sizeBytes: 1000,
              createdByUserId: uuid(3),
              createdAt: '2026-11-07T10:00:00.000Z',
              renderedAt: '2026-11-07T10:00:05.000Z',
              placeholder: true,
              url: null,
              urlExpiresAt: null,
            },
          ]}
        />
      </NextIntlClientProvider>,
    );
    expect(list).toContain(`/forms/${uuid(9)}`);
    expect(list).toContain('Offer');
    expect(list).toContain('Placeholder — not for clients');
  });

  it('[R2-05c] the signing status timeline shows who signed, how, when and from where, and both hashes', () => {
    const html = renderToStaticMarkup(<RequestTimeline request={request()} t={translator('en')} date={date} />);
    expect(html).toContain('Signed');
    expect(html).toContain('signed 2026-11-07 (drawn, from 203.0.113.7)');
    expect(html).toContain('waiting for their turn');
    expect(html).toContain(SHA);
    expect(html).toContain('b'.repeat(64));
    const es = renderToStaticMarkup(
      <RequestTimeline request={request({ status: 'EXPIRED', signedSha256: null })} t={translator('es')} date={date} />,
    );
    expect(es).toContain('Caducada');
    expect(es).not.toContain('b'.repeat(64));
  });

  it('[R2-05c] send for signature: signer rows prefilled, parsed into the API body, empty rows skipped', () => {
    const rows = renderToStaticMarkup(
      <SignerRows
        roles={['buyer', 'agency']}
        prefill={[{ name: 'Bruno', email: 'bruno@example.com', role: 'buyer' }]}
        rows={3}
        t={translator('en')}
      />,
    );
    expect(rows).toContain('value="bruno@example.com"');
    expect(rows.match(/name="signer\.\d\.email"/g)).toHaveLength(3);

    const form = fields({
      'signer.0.name': 'Bruno',
      'signer.0.email': 'bruno@example.com',
      'signer.0.role': 'buyer',
      'signer.1.name': '',
      'signer.1.email': '',
      'signer.2.name': 'Ana',
      'signer.2.email': 'ana@example.com',
      'signer.2.role': 'agency',
      'signer.2.locale': 'es',
    });
    expect(signersOf(form, 'OFFER')).toEqual([
      { name: 'Bruno', email: 'bruno@example.com', role: 'buyer' },
      { name: 'Ana', email: 'ana@example.com', role: 'agency', locale: 'es' },
    ]);
    // a role the template has not, a half row, an unknown language, or nobody: refused before the API
    expect(
      signersOf(
        fields({ 'signer.0.name': 'X', 'signer.0.email': 'x@example.com', 'signer.0.role': 'seller' }),
        'OFFER',
      ),
    ).toBeNull();
    expect(signersOf(fields({ 'signer.0.name': 'X', 'signer.0.role': 'buyer' }), 'OFFER')).toBeNull();
    expect(
      signersOf(
        fields({
          'signer.0.name': 'X',
          'signer.0.email': 'x@e.com',
          'signer.0.role': 'buyer',
          'signer.0.locale': 'fr',
        }),
        'OFFER',
      ),
    ).toBeNull();
    expect(signersOf(fields({}), 'OFFER')).toBeNull();

    expect(requestOptionsOf(fields({ ordered: 'on', expiresInDays: '7', message: 'Hola' }))).toEqual({
      ordered: true,
      expiresInDays: 7,
      message: 'Hola',
    });
    // no expiry posted: the API's default
    expect(requestOptionsOf(fields({}))).toEqual({ ordered: false });
    expect(requestOptionsOf(fields({ expiresInDays: '61' }))).toBeNull();
  });

  it('[R2-05c] filters and errors: templates, the collaboration agreement only from its deal, refusals in EN and ES', () => {
    expect(templateOf('RESERVATION')).toBe('RESERVATION');
    expect(templateOf('NOPE')).toBeUndefined();
    expect(GENERATED_TEMPLATES).not.toContain('COLLABORATION_AGREEMENT');
    expect(errorOf('ESIGN_NOT_ENABLED')).toBe('ESIGN_NOT_ENABLED');
    expect(errorOf('<script>')).toBe('generic');
    expect(reasonOf('party_member')).toBe('party_member');
    expect(reasonOf('x')).toBeNull();
    for (const locale of ['en', 'es'] as const) {
      const t = translator(locale);
      expect(t(`errors.${errorKey('SIGNERS_INVALID', 'party_member')}`)).not.toContain('errors.');
      expect(t(`errors.${errorKey('FORMS_NOT_ENABLED', null)}`)).not.toContain('errors.');
    }
  });
});
