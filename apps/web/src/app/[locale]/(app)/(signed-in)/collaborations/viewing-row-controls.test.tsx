import type { ViewingRequestDto } from '@inmolink/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ViewingRowControls } from './viewing-row-controls';

vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({
  Link: (p: { href: string; children: unknown }) => <a href={p.href}>{p.children as string}</a>,
}));
vi.mock('./actions', () => ({
  acceptViewingAction: () => undefined,
  cancelViewingAction: () => undefined,
  declineViewingAction: () => undefined,
  recordOutcomeAction: () => undefined,
  rescheduleViewingAction: () => undefined,
}));

const ID = '01900000-0000-7000-8000-000000000001';
const CONTACT = '01900000-0000-7000-8000-000000000002';
const viewing = (patch: Partial<ViewingRequestDto>) =>
  ({
    id: ID,
    side: 'OWNER',
    status: 'REQUESTED',
    awaiting: 'OWNER',
    contactId: null,
    expiresAt: '2026-11-20T12:00:00.000Z',
    scheduledAt: null,
    target: { kind: 'DEVELOPMENT', id: ID },
    terms: { validUntil: '2027-05-01T12:00:00.000Z', accepted: false },
    ...patch,
  }) as ViewingRequestDto;

const render = async (v: ViewingRequestDto, mayBind: boolean) =>
  renderToStaticMarkup(
    await ViewingRowControls({
      viewing: v,
      now: new Date('2026-11-10T12:00:00.000Z'),
      blocked: false,
      mayBind,
      timeZone: 'Europe/Madrid',
      back: '',
    }),
  );

describe('[S17-F56] a viewing row as rendered', () => {
  it('[S17-F56] an owner member who may not bind sees decline, cancel, the terms link and why, not accept', async () => {
    const html = await render(viewing({}), false);
    expect(html).toContain('actions.decline');
    expect(html).toContain('actions.cancel');
    expect(html).toContain(`/collaborations/viewings/${ID}/terms`);
    expect(html).toContain('hints.BIND_DEVELOPMENT');
    expect(html).not.toContain('actions.accept');
    expect(html).not.toContain('actions.reschedule');
  });

  it('[S17-F56] the owner side never links to a client, even if a row carried one', async () => {
    const html = await render(viewing({ contactId: CONTACT }), false);
    expect(html).not.toContain(`/contacts/${CONTACT}`);
    expect(html).not.toContain('actions.client');
  });

  it('[S17-F56] the introducer side links to its own client', async () => {
    const html = await render(viewing({ side: 'INTRODUCER', awaiting: 'OWNER', contactId: CONTACT }), false);
    expect(html).toContain(`/contacts/${CONTACT}`);
  });

  it('[S17-F56] a closed viewing offers only its terms', async () => {
    const html = await render(viewing({ status: 'DECLINED', awaiting: null }), true);
    expect(html).not.toContain('<form');
    expect(html).toContain('actions.terms');
  });
});
