/**
 * The document scan hook (security rules: "documents virus-scanned if a scanner is configured"): one hook for
 * every PDF upload — listing documents (S3-F5), development documents (S4-F4). `clean` until one is configured.
 */
export type DocumentScanner = (bytes: Uint8Array) => Promise<'clean' | 'infected'>;

let scanner: DocumentScanner = async () => 'clean';

/** Plugs in a scanner (e.g. ClamAV in the worker image, later); tests pass a fake. */
export function configureDocumentScanner(next: DocumentScanner): void {
  scanner = next;
}

/** The configured scanner's verdict on an upload's bytes. */
export function scanDocument(bytes: Uint8Array): Promise<'clean' | 'infected'> {
  return scanner(bytes);
}
