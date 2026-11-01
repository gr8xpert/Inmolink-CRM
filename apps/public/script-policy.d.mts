// Types of `script-policy.mjs` (S16-F8).
export { newNonce, PAGE_BASE_CSP, TURNSTILE_ORIGIN } from '@inmolink/platform/web-security';
export declare const CSP_REPORT_PATH: '/api/csp-report';
export declare const CSP_REPORT_DIRECTIVE: string;
export declare const NONCE_SHAPE: RegExp;
export declare function portalScriptSrc(nonce: string, dev?: boolean): string;
export declare const SHA256_SOURCE: RegExp;
export declare function hashedScriptSrc(hashes: readonly string[], dev?: boolean): string;
export declare const FALLBACK_PAGE_CSP: string;
