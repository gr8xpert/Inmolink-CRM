// Types of `script-policy.mjs` (S16-F8).
export declare const TURNSTILE_ORIGIN: 'https://challenges.cloudflare.com';
export declare const CSP_REPORT_PATH: '/api/csp-report';
export declare const CSP_REPORT_DIRECTIVE: string;
export declare const NONCE_SHAPE: RegExp;
export declare function portalScriptSrc(nonce: string, dev?: boolean): string;
export declare function newNonce(): string;
export declare const SHA256_SOURCE: RegExp;
export declare function hashedScriptSrc(hashes: readonly string[], dev?: boolean): string;
export declare const PAGE_BASE_CSP: string;
export declare const FALLBACK_PAGE_CSP: string;
