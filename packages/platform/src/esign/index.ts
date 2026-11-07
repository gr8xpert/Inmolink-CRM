import { PDFDocument } from 'pdf-lib';

/**
 * Electronic signature provider (R2-05b, PLAN §7 M13; H17 open: built-in simple signature vs a provider, after lawyer
 * input). The signing flow itself — who signs, the e-mailed one-time code, the signature capture, the audit trail — is
 * the documents module's; the provider makes the signed document from the original PDF and the audit trail's pages.
 *
 * - `builtin` (the default): a simple electronic signature (eIDAS art. 3(10)). `seal` keeps every page of the original
 *   PDF as it is (page content copied, never re-rendered) and appends the audit trail's pages. The signed file's
 *   integrity is its SHA-256, recorded by the caller; the original's SHA-256 is printed on the audit trail.
 * - An advanced / qualified provider (later, H17) implements the same interface: its `seal` may add its own signature
 *   (PAdES) and timestamp to the bytes.
 *
 * Pure computation (no network): safe in a worker job, never inside a DB transaction anyway (it can take a while).
 */
export interface ESignProvider {
  /** Recorded on the signing request (`builtin`, or the provider's name). */
  readonly name: string;
  /** `SIMPLE` (eIDAS art. 3(10)), `ADVANCED` or `QUALIFIED`. */
  readonly level: 'SIMPLE' | 'ADVANCED' | 'QUALIFIED';
  /** The signed PDF: the original's pages, then the audit trail's. Throws on a PDF it cannot read. */
  seal(input: ESignSealInput): Promise<Uint8Array>;
}

export interface ESignSealInput {
  /** The original document, exactly as stored (its SHA-256 is the one the signers saw). */
  original: Uint8Array;
  /** The audit trail, rendered as its own PDF. */
  auditTrail: Uint8Array;
  /** Document information written into the signed PDF (title, subject, keywords). */
  info?: { title?: string; subject?: string; keywords?: readonly string[] };
}

/** Thrown for input the provider cannot seal (a damaged or encrypted PDF): retrying does not help. */
export class ESignInputError extends Error {
  override readonly name = 'ESignInputError';
}

/** Largest PDF the built-in provider loads (the forms library's documents are far smaller). */
export const ESIGN_MAX_PDF_BYTES = 25 * 1024 * 1024;

async function load(bytes: Uint8Array, what: string): Promise<PDFDocument> {
  if (bytes.length === 0 || bytes.length > ESIGN_MAX_PDF_BYTES) throw new ESignInputError(`esign: ${what} size`);
  try {
    // never decrypt: an encrypted PDF is refused (`ignoreEncryption: false` throws on one)
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    if (doc.getPageCount() === 0) throw new Error('no pages');
    return doc;
  } catch (err) {
    throw new ESignInputError(`esign: ${what} is not a readable PDF (${(err as Error).message.slice(0, 120)})`);
  }
}

/** The built-in simple electronic signature: original pages + audit trail pages, deterministic for the same input. */
export function createBuiltinESign(): ESignProvider {
  return {
    name: 'builtin',
    level: 'SIMPLE',
    async seal(input) {
      const original = await load(input.original, 'original');
      const audit = await load(input.auditTrail, 'audit trail');
      const pages = await original.copyPages(audit, audit.getPageIndices());
      for (const page of pages) original.addPage(page);
      if (input.info?.title) original.setTitle(input.info.title);
      if (input.info?.subject) original.setSubject(input.info.subject);
      if (input.info?.keywords) original.setKeywords([...input.info.keywords]);
      original.setProducer('Inmolink e-signature (simple)');
      // a fixed modification date: the same signatures seal to the same bytes (retries record one hash)
      const stamp = original.getCreationDate() ?? new Date(0);
      original.setModificationDate(stamp);
      return original.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
    },
  };
}

let current: ESignProvider | undefined;

/** Boot (the pdf pool), or tests: the provider (default: the built-in simple signature). */
export function configureESign(provider: ESignProvider | undefined): void {
  current = provider;
}

export function esign(): ESignProvider {
  current ??= createBuiltinESign();
  return current;
}
