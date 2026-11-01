// Types of `stored-page-policy.mjs` (S16-F8).
export declare const MAX_SCRIPT_HASHES: number;
export declare function isNextInlineScript(body: string, isTurbopackBootstrap: boolean): boolean;
export declare function inlineScriptHashes(html: string): { hashes: string[]; dropped: number };
export declare function storedPageScriptPolicy(html: string, dev?: boolean): { policy: string; dropped: number };
export declare const CSP_HEADER: 'content-security-policy';
export declare function withStoredPageScriptPolicy<T>(
  data: T,
  options?: { dev?: boolean; onCapped?: (dropped: number) => void },
): T;
