/**
 * The audit-trail page of a signed form (R2-05b): a complete HTML document for the `pdf` renderer, appended by the
 * e-signature provider after the original's pages. Pure: every value escaped, no script, no remote asset (a drawn
 * signature is an inline `data:image/png` the renderer allows). Times in UTC (ISO 8601), so the record reads the same
 * in every language.
 */
import type { Translate } from '@inmolink/i18n/server';
import { escapeHtml } from '../../email-text';

const e = (s: string | number | null | undefined) => escapeHtml(String(s ?? ''));
const utc = (at: Date | string | null) => (at ? `${new Date(at).toISOString().replace('.000Z', 'Z')}` : '—');

export interface AuditSigner {
  position: number;
  /** The role label (translated). */
  role: string;
  name: string;
  email: string;
  invitedAt: Date | string | null;
  codeSentAt: Date | string | null;
  signedAt: Date | string | null;
  signatureKind: string | null;
  signatureText: string | null;
  /** base64 PNG (no data: prefix). */
  signaturePng: string | null;
  documentSha256: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface AuditTrailInput {
  t: Translate;
  lang: string;
  agencyName: string;
  documentLabel: string;
  formId: string;
  requestId: string;
  requestedAt: Date | string;
  allSignedAt: Date | string | null;
  originalSha256: string;
  signers: readonly AuditSigner[];
}

const PNG_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function signerBlock(t: Translate, s: AuditSigner, n: number): string {
  const kind = s.signatureKind === 'DRAWN' ? t('signing.audit.drawn') : t('signing.audit.typed');
  const image =
    s.signatureKind === 'DRAWN' && s.signaturePng && PNG_BASE64.test(s.signaturePng)
      ? `<img class="drawn" alt="" src="data:image/png;base64,${s.signaturePng}">`
      : `<div class="typed">${e(s.signatureText)}</div>`;
  const rows: [string, string][] = [
    [t('signing.audit.role'), e(s.role)],
    [t('signing.audit.signatureName'), e(s.signatureText ?? s.name)],
    [t('signing.audit.email'), e(s.email)],
    [t('signing.audit.invitedAt'), e(utc(s.invitedAt))],
    [t('signing.audit.codeSentAt'), e(utc(s.codeSentAt))],
    [t('signing.audit.signedAt'), e(utc(s.signedAt))],
    [t('signing.audit.method'), e(kind)],
    [t('signing.audit.ip'), e(s.ip ?? '—')],
    [t('signing.audit.userAgent'), e(s.userAgent ?? '—')],
    [t('signing.audit.signedHash'), `<code>${e(s.documentSha256)}</code>`],
  ];
  return `<section class="signer"><h2>${e(t('signing.audit.signer', { n }))} · ${e(s.name)}</h2><div class="row"><table class="kv">${rows
    .map(([k, v]) => `<tr><th>${e(k)}</th><td>${v}</td></tr>`)
    .join('')}</table><div class="mark">${image}</div></div></section>`;
}

export function auditTrailHtml(input: AuditTrailInput): string {
  const { t } = input;
  const head: [string, string][] = [
    [t('signing.audit.document'), e(input.documentLabel)],
    [t('signing.audit.documentId'), `<code>${e(input.formId)}</code>`],
    [t('signing.audit.request'), `<code>${e(input.requestId)}</code>`],
    [t('signing.audit.provider'), e(t('signing.audit.simple'))],
    [t('signing.audit.agency'), e(input.agencyName)],
    [t('signing.audit.requestedAt'), e(utc(input.requestedAt))],
    [t('signing.audit.allSignedAt'), e(utc(input.allSignedAt))],
    [t('signing.audit.originalHash'), `<code>${e(input.originalSha256)}</code>`],
  ];
  return `<!DOCTYPE html><html lang="${e(input.lang)}"><head><meta charset="utf-8"><title>${e(t('signing.audit.title'))}</title><style>
@page { size: A4; margin: 14mm 14mm 16mm; }
* { box-sizing: border-box; }
body { font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif; color: #1d232b; font-size: 9pt; line-height: 1.4; margin: 0; }
h1 { font-size: 15pt; margin: 0 0 1mm; }
.intro { color: #5b6573; margin: 0 0 4mm; }
h2 { font-size: 10.5pt; margin: 5mm 0 1.5mm; border-bottom: .3mm solid #c9d0d8; padding-bottom: 1mm; }
table.kv { width: 100%; border-collapse: collapse; }
table.kv th { text-align: left; width: 34%; font-weight: 600; color: #5b6573; padding: 1mm 1.5mm; vertical-align: top; }
table.kv td { padding: 1mm 1.5mm; word-break: break-all; }
code { font-family: "DejaVu Sans Mono", Menlo, Consolas, monospace; font-size: 8pt; }
.signer { break-inside: avoid; }
.row { display: flex; gap: 4mm; align-items: flex-start; }
.row .kv { flex: 1; }
.mark { width: 55mm; min-height: 20mm; border: .3mm solid #c9d0d8; border-radius: 1mm; display: flex; align-items: center; justify-content: center; padding: 1.5mm; }
.mark .drawn { max-width: 100%; max-height: 26mm; }
.mark .typed { font-family: "Brush Script MT", "Segoe Script", cursive; font-size: 15pt; text-align: center; word-break: break-word; }
.note { margin-top: 6mm; font-size: 7.5pt; color: #5b6573; border-top: .3mm solid #d9dee4; padding-top: 2mm; }
</style></head><body>
<h1>${e(t('signing.audit.title'))}</h1>
<p class="intro">${e(t('signing.audit.intro'))}</p>
<table class="kv">${head.map(([k, v]) => `<tr><th>${e(k)}</th><td>${v}</td></tr>`).join('')}</table>
${input.signers.map((s, i) => signerBlock(t, s, i + 1)).join('\n')}
<p class="note">${e(t('signing.audit.note'))}</p>
</body></html>`;
}
