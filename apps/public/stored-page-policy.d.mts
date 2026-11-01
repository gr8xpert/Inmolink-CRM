// Types of `stored-page-policy.mjs` (S16-F8; S17-F2: flight pushes checked against the entry's `rscData`).
/** An entry's RSC payload: Next stores a Buffer. */
export type RscData = Uint8Array | string | undefined;
export declare const MAX_SCRIPT_HASHES: number;
export declare function isNextInlineScript(body: string, isTurbopackBootstrap: boolean): boolean;
export declare function inlineScriptHashes(
  html: string,
  rscData?: RscData,
): { hashes: string[]; dropped: number; unmatched: number };
export declare function storedPageScriptPolicy(
  html: string,
  rscData?: RscData,
  dev?: boolean,
): { policy: string; dropped: number; unmatched: number };
export declare const CSP_HEADER: 'content-security-policy';
export declare function withStoredPageScriptPolicy<T>(
  data: T,
  options?: {
    dev?: boolean;
    onCapped?: (dropped: number) => void;
    onUnmatched?: (unmatched: number, noRscData: boolean) => void;
  },
): T;
