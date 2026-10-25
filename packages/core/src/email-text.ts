import { EmailSendError } from '@inmolink/platform/email';

/**
 * Small text helpers for e-mails and notification text built in core (S12-F18: one definition each, was copied in
 * every module's e-mail file).
 */

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text safe inside HTML element content and quoted attributes. */
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);

/**
 * One header-safe line of at most `max` characters: control characters, line/paragraph separators and invisible
 * format characters (bidi overrides; joiners kept for scripts that need them) become a space.
 */
export const line = (s: string, max: number): string =>
  s.replace(/(?:[\p{Cc}\p{Zl}\p{Zp}]|[^\P{Cf}\p{Join_Control}])+/gu, ' ').slice(0, max);

/** Whether a failed send certainly sent nothing (refused before or by the adapter): safe to release and retry. */
export const wasNotSent = (err: unknown): boolean =>
  err instanceof TypeError || (err instanceof EmailSendError && err.notSent);
