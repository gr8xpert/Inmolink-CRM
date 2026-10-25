/**
 * Support e-mail settings (S13-05), set by the worker at boot (`configureSupport`): the dashboard's base URL for the
 * links, and the support inbox told about new tickets and member replies (`SUPPORT_INBOX_EMAIL`; unset: staff work
 * from the console queue and no inbox mail is sent).
 */
export interface SupportConfig {
  webUrl: string;
  staffInbox: string | null;
}

let current: SupportConfig = { webUrl: '', staffInbox: null };

export function configureSupport(config: { webUrl?: string; staffInbox?: string | null }): void {
  current = { webUrl: (config.webUrl ?? '').replace(/\/+$/, ''), staffInbox: config.staffInbox ?? null };
}

export function supportConfig(): SupportConfig {
  return current;
}
