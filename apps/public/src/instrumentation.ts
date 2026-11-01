/**
 * Next.js server start-up hook. S16-F8: every HTML answer leaves with a `script-src` (`server/script-fallback.ts`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { installScriptPolicyFallback } = await import('./server/script-fallback');
  installScriptPolicyFallback();
}
