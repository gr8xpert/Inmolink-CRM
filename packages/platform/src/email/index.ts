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
  /**
   * S7-05: the sender's display name (e.g. the website's name on a lead acknowledgement). The address stays the
   * platform's own (`EMAIL_FROM`, SPF/DKIM aligned); only the name shown changes. One line, no quotes or brackets.
   */
  fromName?: string;
  /** S7-05: where replies go (e.g. the website's contact e-mail). */
  replyTo?: string;
  /**
   * S10-05: the provider's idempotency key (`Idempotency-Key`, Resend keeps it 24 h): a retry of the same logical send
   * is delivered once. Safe characters only, ≤ 256 chars. SMTP has no such thing — the key is ignored there.
   */
  idempotencyKey?: string;
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
  /**
   * S10-05: the provider answered that it refused the message (a 4xx other than 409 / 429): nothing was sent, a caller
   * may give up its claim on the send. Otherwise (timeout, 5xx, a dropped connection) it is unknown whether it went.
   */
  readonly notSent: boolean;
  constructor(message: string, opts: { notSent?: boolean } = {}) {
    super(message);
    this.notSent = opts.notSent ?? false;
  }
}

/** Rejects header injection and obviously bad addresses before any driver sees the message. */
export function assertMessage(message: EmailMessage): void {
  if (!EMAIL.test(message.to) || message.to.length > 254) throw new TypeError('email: invalid recipient');
  if (/[\r\n]/.test(message.subject) || message.subject.length > 300) throw new TypeError('email: invalid subject');
  if (message.tag !== undefined && !/^[a-z0-9._-]{1,64}$/.test(message.tag)) throw new TypeError('email: invalid tag');
  if (message.fromName !== undefined && !/^[^\r\n"<>\\]{1,100}$/.test(message.fromName)) {
    throw new TypeError('email: invalid sender name');
  }
  if (message.idempotencyKey !== undefined && !/^[A-Za-z0-9:._-]{1,256}$/.test(message.idempotencyKey)) {
    throw new TypeError('email: invalid idempotency key');
  }
  if (message.replyTo !== undefined && (!EMAIL.test(message.replyTo) || message.replyTo.length > 254)) {
    throw new TypeError('email: invalid reply-to');
  }
}

/** The configured sender's address (`Name <addr>` or a bare address). */
function addressOf(from: string): string {
  return /<([^<>]+)>\s*$/.exec(from)?.[1] ?? from.trim();
}

/** The `From` header: the configured sender, or its address under the message's display name. */
export function senderOf(from: string, message: Pick<EmailMessage, 'fromName'>): string {
  return message.fromName ? `"${message.fromName}" <${addressOf(from)}>` : from;
}

export function createSmtpMailer(options: { from: string; smtpUrl: string }): Mailer {
  const transport: Transporter = nodemailer.createTransport(options.smtpUrl);
  return {
    async send(message) {
      assertMessage(message);
      try {
        const info = await transport.sendMail({
          from: senderOf(options.from, message),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
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
        headers: {
          authorization: `Bearer ${options.resendApiKey}`,
          'content-type': 'application/json',
          ...(message.idempotencyKey ? { 'idempotency-key': message.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: senderOf(options.from, message),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.tag ? { tags: [{ name: 'tag', value: message.tag.replaceAll('.', '_') }] } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const refused = res.status >= 400 && res.status < 500 && res.status !== 409 && res.status !== 429;
        throw new EmailSendError(`resend send failed (${res.status})`, { notSent: refused });
      }
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
