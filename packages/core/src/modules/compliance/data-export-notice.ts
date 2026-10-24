import { DATA_EXPORT_TTL_DAYS } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import type { EmailMessage } from '@inmolink/platform/email';
import * as identity from '../identity';
import * as repo from './data-export-repo';

/**
 * Data export alert (S10-08): every active admin of the agency is told by e-mail that an export was requested — who
 * asked, what and when — so a bulk copy of the agency's clients never goes unnoticed (a stolen admin session, a
 * leaving employee). Worker-only (`worker.ts`): it reads identity's members as `app_system`. The e-mail carries no
 * exported data and no download link, only a link to the agency's settings.
 */

let webUrl = '';

/** Called once at boot by the worker: the dashboard's base URL for the e-mail's link. */
export function configureDataExportNotice(config: { webUrl?: string }): void {
  webUrl = (config.webUrl ?? '').replace(/\/+$/, '');
}

const localeOf = (locale: string) => (isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** The admins to tell (user ids), or none when the export is gone. */
export async function dataExportNoticeRecipients(p: { agencyId: string; exportId: string }): Promise<string[]> {
  return withSystem('compliance.notifyDataExport', async (tx) => {
    const row = await repo.getExport(tx, p.exportId);
    if (!row || row.agencyId !== p.agencyId) return [];
    const admins = await identity.listAgencyAdmins(tx, p.agencyId);
    return admins.map((a) => a.userId);
  });
}

/** One admin's alert, or null when the admin or the export is gone. */
export async function renderDataExportNotice(p: {
  agencyId: string;
  exportId: string;
  userId: string;
}): Promise<EmailMessage | null> {
  if (!webUrl) throw new Error('compliance: webUrl is not configured');
  const loaded = await withSystem('compliance.sendDataExportNotice', async (tx) => {
    const row = await repo.getExport(tx, p.exportId);
    if (!row || row.agencyId !== p.agencyId) return null;
    const admin = await identity.memberRecipient(tx, p.agencyId, p.userId);
    if (!admin) return null;
    const requester = await identity.memberRecipient(tx, p.agencyId, row.createdBy);
    return { row, admin, requester };
  });
  if (!loaded) return null;
  const { row, admin, requester } = loaded;
  const locale = localeOf(admin.locale);
  const t = translator(locale, 'agency');
  const values = {
    name: admin.name,
    requester: requester?.name ?? t('dataExport.email.someone'),
    kind: t(`dataExport.kind.${row.kind}`),
    format: t(`dataExport.format.${row.format}`),
    date: row.createdAt.toISOString().slice(0, 16).replace('T', ' '),
    days: DATA_EXPORT_TTL_DAYS,
  };
  const parts = {
    greeting: t('dataExport.email.greeting', values),
    body: t('dataExport.email.body', values),
    action: t('dataExport.email.action'),
    unexpected: t('dataExport.email.unexpected'),
  };
  const link = `${webUrl}/${locale}/settings`;
  return {
    to: admin.email,
    subject: t('dataExport.email.subject', values),
    tag: 'compliance.data-export-requested',
    text: `${parts.greeting}\n\n${parts.body}\n\n${parts.action}: ${link}\n\n${parts.unexpected}\n`,
    html: [
      `<p>${escapeHtml(parts.greeting)}</p>`,
      `<p>${escapeHtml(parts.body)}</p>`,
      `<p><a href="${escapeHtml(link)}">${escapeHtml(parts.action)}</a></p>`,
      `<p style="color:#666">${escapeHtml(parts.unexpected)}</p>`,
    ].join('\n'),
  };
}
