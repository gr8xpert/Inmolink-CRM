import type { DealDto, DealSignersDto, FormDocumentDto, SignatureRequestDto } from '@inmolink/contracts';
import { loadMessages } from '@inmolink/i18n/server';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { T } from '../../forms/parts';

// the section's server actions and links (no session, no API here)
vi.mock('../../forms/actions', () => ({
  createCollaborationAgreementAction: async () => {},
  openFormAction: async () => ({ url: '' }),
  sendDealSignatureAction: async () => {},
}));
vi.mock('@/i18n/navigation', () => ({
  Link: (p: { href: string; children: unknown; className?: string }) => <a href={p.href}>{p.children as string}</a>,
}));
vi.mock('@/server/forms-api', () => ({}));

const { AgreementPanel } = await import('./collaboration-agreement');

const uuid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const t: T = (() => {
  const tr = createTranslator({ locale: 'en', messages: loadMessages('en'), namespace: 'documents.dashboard' });
  return (key, values) => tr(key as never, values as never);
})();
const deal = (stage: DealDto['stage'] = 'OFFER') =>
  ({ id: uuid(1), stage, counterpartName: 'Costa Homes' }) as unknown as DealDto;
const form = (patch: Partial<FormDocumentDto> = {}) =>
  ({
    id: uuid(2),
    label: 'Collaboration agreement',
    status: 'READY',
    sha256: 'a'.repeat(64),
    placeholder: true,
    createdAt: '2026-11-07T10:00:00.000Z',
    ...patch,
  }) as unknown as FormDocumentDto;
const request = (status: SignatureRequestDto['status']) =>
  ({
    id: uuid(3),
    formId: uuid(2),
    status,
    ordered: false,
    documentSha256: 'a'.repeat(64),
    signedSha256: null,
    expiresAt: '2026-11-21T10:00:00.000Z',
    createdAt: '2026-11-07T10:00:00.000Z',
    allSignedAt: null,
    completedAt: null,
    cancelledAt: null,
    signers: [],
    events: [],
  }) as unknown as SignatureRequestDto;
const signers: DealSignersDto = {
  ownRole: 'introducerAgency',
  own: [{ userId: uuid(10), name: 'Ana Intro', email: 'ana@intro.es', dealMember: true }],
  counterpart: [
    { userId: uuid(11), name: 'Olga Owner', email: 'o***@costa.es', dealMember: true },
    { userId: uuid(12), name: 'Admin Costa', email: 'a***@costa.es', dealMember: false },
  ],
};

const render = (el: ReactElement) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={loadMessages('en')}>
      {el}
    </NextIntlClientProvider>,
  );
const panel = (
  state: Parameters<typeof AgreementPanel>[0]['state'],
  opts: { stage?: DealDto['stage']; acting?: boolean } = {},
) =>
  render(
    <AgreementPanel
      deal={deal(opts.stage)}
      state={state}
      locale="en"
      acting={opts.acting ?? false}
      query={{}}
      t={t}
      date={(iso) => iso.slice(0, 10)}
    />,
  );

describe('[R2-05c] the deal room’s collaboration agreement', () => {
  it('[R2-05c] the signers are prefilled from the deal: one per party, by user id; the other agency’s addresses masked', () => {
    const html = panel({ forms: [form()], requests: [], signers });
    expect(html).toContain('name="ownUserId"');
    expect(html).toContain('name="counterpartUserId"');
    expect(html).toContain(`value="${uuid(11)}"`);
    expect(html).toContain('o***@costa.es');
    // no free-text signer the requester could type
    expect(html).not.toContain('name="signer.0.email"');
    expect(html).toContain(t('placeholder'));
  });

  it('[R2-05c] while the agreement is out for signature or signed it is not regenerated; signed: not sent again', () => {
    const open = panel({ forms: [form()], requests: [request('OPEN')], signers });
    expect(open).not.toContain(t('deal.regenerate'));
    expect(open).toContain('name="counterpartUserId"');
    const done = panel({ forms: [form()], requests: [request('COMPLETED')], signers });
    expect(done).not.toContain(t('deal.regenerate'));
    expect(done).not.toContain('name="counterpartUserId"');
    // an expired request no longer holds it
    expect(panel({ forms: [form()], requests: [request('EXPIRED')], signers })).toContain(t('deal.regenerate'));
  });

  it('[R2-05c] e-signature off: no send form; fallen through or acting: nothing to change; a final form: no placeholder', () => {
    const off = panel({ forms: [form()], requests: null, signers: null });
    expect(off).not.toContain('name="counterpartUserId"');
    expect(off).toContain(t('detail.download'));
    const fell = panel({ forms: [form()], requests: [], signers }, { stage: 'FELL_THROUGH' });
    expect(fell).not.toContain(t('deal.regenerate'));
    expect(fell).not.toContain('name="counterpartUserId"');
    expect(panel({ forms: [], requests: null, signers: null }, { acting: true })).not.toContain(t('deal.generate'));
    expect(panel({ forms: [form({ placeholder: false })], requests: [], signers })).not.toContain(t('placeholder'));
  });
});
