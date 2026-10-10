import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Transactional email (S0-09). Drivers: `smtp` (Mailpit locally; also Amazon SES through its SMTP
 * endpoint), `resend` (HTTPS API) and `memory` (tests). Send only from worker jobs — never inside a
 * DB transaction or a request (CLAUDE.md rules 6–7). Bodies may contain one-time links: never log them.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Short tag for provider analytics, e.g. `identity.verify-email`. */
  tag?: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<{ id?: string }>;
  close(): Promise<void>;
}

export type EmailConfig =
  | { driver: 'smtp'; from: string; smtpUrl: string }
  | { driver: 'resend'; from: string; resendApiKey: string; endpoint?: string }
  | { driver: 'memory'; from: string };

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

export class EmailSendError extends Error {
  override readonly name = 'EmailSendError';
}

/** Rejects header injection and obviously bad addresses before any driver sees the message. */
export function assertMessage(message: EmailMessage): void {
  if (!EMAIL.test(message.to) || message.to.length > 254) throw new TypeError('email: invalid recipient');
  if (/[\r\n]/.test(message.subject) || message.subject.length > 300) throw new TypeError('email: invalid subject');
  if (message.tag !== undefined && !/^[a-z0-9._-]{1,64}$/.test(message.tag)) throw new TypeError('email: invalid tag');
}

export function createSmtpMailer(options: { from: string; smtpUrl: string }): Mailer {
  const transport: Transporter = nodemailer.createTransport(options.smtpUrl);
  return {
    async send(message) {
      assertMessage(message);
      try {
        const info = await transport.sendMail({
          from: options.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: message.tag ? { 'X-Inmolink-Tag': message.tag } : undefined,
        });
        return { id: info.messageId };
      } catch (err) {
        // The transport error may echo recipients; keep only its code.
        throw new EmailSendError(`smtp send failed (${(err as { code?: string }).code ?? 'unknown'})`);
      }
    },
    async close() {
      transport.close();
    },
  };
}

export function createResendMailer(options: {
  from: string;
  resendApiKey: string;
  endpoint?: string;
  fetch?: typeof fetch;
}): Mailer {
  const doFetch = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? 'https://api.resend.com/emails';
  return {
    async send(message) {
      assertMessage(message);
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.resendApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.tag ? { tags: [{ name: 'tag', value: message.tag.replaceAll('.', '_') }] } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new EmailSendError(`resend send failed (${res.status})`);
      const body = (await res.json().catch(() => ({}))) as { id?: string };
      return { id: body.id };
    },
    async close() {},
  };
}

export interface MemoryMailer extends Mailer {
  readonly sent: EmailMessage[];
}

export function createMemoryMailer(): MemoryMailer {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message) {
      assertMessage(message);
      sent.push(message);
      return { id: String(sent.length) };
    },
    async close() {},
  };
}

export function createMailer(config: EmailConfig): Mailer {
  switch (config.driver) {
    case 'smtp':
      return createSmtpMailer(config);
    case 'resend':
      return createResendMailer(config);
    case 'memory':
      return createMemoryMailer();
  }
}

let current: Mailer | undefined;

/** Sets the process-wide mailer (worker boot, or a memory mailer in tests). */
export async function configureEmail(next: EmailConfig | Mailer): Promise<void> {
  await closeEmail();
  current = 'send' in next ? next : createMailer(next);
}

export function mailer(): Mailer {
  if (!current) throw new Error('email is not configured (call configureEmail at boot)');
  return current;
}

export async function closeEmail(): Promise<void> {
  const open = current;
  current = undefined;
  await open?.close();
}
