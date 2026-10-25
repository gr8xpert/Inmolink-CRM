import type { PdfRenderer } from './index';

/**
 * Test doubles for the PDF adapter (`@inmolink/platform/pdf/testing`): renders nothing, keeps the HTML it was given
 * and how many renders ran at once.
 */
export function fakePdfRenderer(options: { delayMs?: number } = {}): PdfRenderer & {
  documents: string[];
  maxActive: number;
} {
  let active = 0;
  const out = {
    documents: [] as string[],
    maxActive: 0,
    get active() {
      return active;
    },
    async render(html: string, renderOptions: { signal?: AbortSignal } = {}) {
      active++;
      out.maxActive = Math.max(out.maxActive, active);
      try {
        out.documents.push(html);
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
        renderOptions.signal?.throwIfAborted();
        return new TextEncoder().encode(`%PDF-1.4\n% fake ${out.documents.length}\n%%EOF\n`);
      } finally {
        active--;
      }
    },
    async close() {},
  };
  return out;
}

/** Pages of a PDF (`/Type /Page` objects; Chrome writes them uncompressed). Tests only. */
export function pdfPageCount(bytes: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(bytes);
  return (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}
