import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createLogger,
  REDACTED,
  redactPaths,
  redactPathsInText,
  redactQueryParams,
  sanitizeError,
  stripQuery,
  withRequestId,
} from './index';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, done) {
      raw.push(String(chunk));
      lines.push(JSON.parse(String(chunk)));
      done();
    },
  });
  return { lines, raw, destination };
}

describe('logger', () => {
  it('[S0-03] redaction removes configured fields (email, phone, password, token, key) from logs', () => {
    const out = capture();
    const logger = createLogger({ destination: out.destination, service: 'test' });

    logger.info(
      {
        email: 'buyer@example.com',
        phone: '+34600111222',
        password: 'hunter2-secret',
        token: 'tok_live_123',
        key: 'sk_live_456',
        user: { id: 'u1', email: 'agent@example.com' },
        req: { headers: { authorization: 'Bearer abc.def.ghi', cookie: 'sid=xyz', 'set-cookie': 'sid=xyz' } },
        lead: { contact: { details: { phone: '+34600999888' } } },
        listingId: 'keep-me',
      },
      'lead received',
    );

    const text = out.raw.join('');
    for (const secret of [
      'buyer@example.com',
      '+34600111222',
      'hunter2-secret',
      'tok_live_123',
      'sk_live_456',
      'agent@example.com',
      'abc.def.ghi',
      'sid=xyz',
      '+34600999888',
    ]) {
      expect(text).not.toContain(secret);
    }
    const line = out.lines[0] as Record<string, unknown> & { user: Record<string, unknown> };
    expect(line.email).toBe(REDACTED);
    expect(line.user.email).toBe(REDACTED);
    expect(line.user.id).toBe('u1');
    expect(line.listingId).toBe('keep-me');
    expect(line.msg).toBe('lead received');
  });

  it('[S1-F5] redacts person names, top level and nested', () => {
    const out = capture();
    createLogger({ destination: out.destination }).info({
      name: 'Ana García',
      user: { id: 'u1', name: 'Luis Pérez', firstName: 'Luis' },
      invite: { contact: { fullName: 'Marta Ruiz' } },
    });
    const text = out.raw.join('');
    for (const pii of ['Ana García', 'Luis Pérez', 'Marta Ruiz']) expect(text).not.toContain(pii);
    expect((out.lines[0] as { user: Record<string, unknown> }).user).toEqual({
      id: 'u1',
      name: REDACTED,
      firstName: REDACTED,
    });
  });

  it('[S2-F2] a logged agency profile DTO has its contact fields censored', () => {
    const out = capture();
    createLogger({ destination: out.destination }).info({
      profile: {
        displayName: 'Inmo Sol',
        contactEmail: 'ana@inmosol.es',
        contactPhone: '+34 600 111 222',
        websiteUrl: 'https://ana-garcia.example',
      },
      document: { id: 'd1', fileName: 'NIF Ana Garcia.pdf', decisionReason: 'Blurry NIF of Ana' },
    });
    const text = out.raw.join('');
    for (const pii of ['ana@inmosol.es', '+34 600 111 222', 'ana-garcia.example', 'NIF Ana Garcia', 'Blurry NIF']) {
      expect(text).not.toContain(pii);
    }
    expect((out.lines[0] as { profile: Record<string, unknown> }).profile).toEqual({
      displayName: 'Inmo Sol',
      contactEmail: REDACTED,
      contactPhone: REDACTED,
      websiteUrl: REDACTED,
    });
  });

  it('[S0-03] redacts extra keys passed by the app', () => {
    const out = capture();
    createLogger({ destination: out.destination, redact: ['dni'] }).info({ dni: '12345678Z' });
    expect(out.raw.join('')).not.toContain('12345678Z');
  });

  it('[S0-03] binds the request id to every line of a child logger', () => {
    const out = capture();
    const log = withRequestId(createLogger({ destination: out.destination }), 'req-123', { agencyId: 'a1' });
    log.info('one');
    log.warn('two');
    expect(out.lines.map((l) => [l.requestId, l.agencyId, l.level])).toEqual([
      ['req-123', 'a1', 'info'],
      ['req-123', 'a1', 'warn'],
    ]);
  });

  it('[S0-03] drops row values that database errors echo', () => {
    const out = capture();
    const err = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      detail: 'Key (email)=(buyer@example.com) already exists.',
      parameters: ['buyer@example.com'],
    });
    createLogger({ destination: out.destination }).error({ err }, 'insert failed');
    const text = out.raw.join('');
    expect(text).not.toContain('buyer@example.com');
    expect(text).toContain('23505');
  });

  it('[S0-03] redacts API-key headers and strips query strings from URLs', () => {
    const out = capture();
    createLogger({ destination: out.destination }).info({ req: { headers: { 'x-api-key': 'inl_live_abc_secret' } } });
    expect(out.raw.join('')).not.toContain('inl_live_abc_secret');
    expect(stripQuery('/reset?token=abc')).toBe('/reset');
    expect(stripQuery('/v2/listings')).toBe('/v2/listings');
  });

  it('[S8-F4] redacts website form fields: WhatsApp, Turnstile tokens, idempotency keys, page URL, viewing slots', () => {
    const out = capture();
    createLogger({ destination: out.destination }).info(
      {
        whatsapp: '+34600777666',
        turnstileToken: 'ts-token-abc',
        body: {
          'cf-turnstile-response': 'cf-response-def',
          idempotencyKey: 'idem-key-ghi',
          pageUrl: 'https://agency.example/villa?ref=buyer-jkl',
          viewingSlots: ['2026-11-02T10:00-slot-mno'],
          slots: [{ date: '2026-11-03', timeOfDay: 'slot-stu' }],
        },
        req: { headers: { 'idempotency-key': 'idem-header-pqr' } },
        outgoing: { headers: { 'Idempotency-Key': 'idem-caps-vwx', 'CF-Turnstile-Response': 'cf-caps-yz' } },
        leadId: 'keep-me',
      },
      'lead received',
    );
    const text = out.raw.join('');
    for (const secret of [
      '+34600777666',
      'ts-token-abc',
      'cf-response-def',
      'idem-key-ghi',
      'buyer-jkl',
      'slot-mno',
      'slot-stu',
      'idem-caps-vwx',
      'cf-caps-yz',
      'idem-header-pqr',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(out.lines[0]).toMatchObject({ whatsapp: REDACTED, turnstileToken: REDACTED, leadId: 'keep-me' });
  });

  it('[S8-02] a legacy api_key quoted in a text is redacted, other parameters kept', () => {
    const text = 'GET https://legacy.example/api/properties?page=2&api_key=lk_secret123&lang=es failed';
    expect(redactPathsInText(text)).toBe(
      `GET https://legacy.example/api/properties?page=2&api_key=${REDACTED}&lang=es failed`,
    );
    expect(redactPathsInText('"/v1/types?api_key=abc"')).toBe(`"/v1/types?api_key=${REDACTED}"`);
  });

  it('[S9-01] a portal feed token in a path or a quoted URL is redacted, the rest kept', () => {
    const token = 'p'.repeat(43);
    expect(stripQuery(`/v2/portal-feeds/${token}/kyero.xml?x=1`)).toBe(`/v2/portal-feeds/${REDACTED}/kyero.xml`);
    expect(redactPathsInText(`GET https://feed.example/v2/portal-feeds/${token}/inmolink.xml failed`)).toBe(
      `GET https://feed.example/v2/portal-feeds/${REDACTED}/inmolink.xml failed`,
    );
  });

  it('[S10-06] a calendar feed token in a path or a quoted URL is redacted, the rest kept', () => {
    const token = 'c'.repeat(43);
    expect(stripQuery(`/v2/calendars/${token}/calendar.ics?lang=es`)).toBe(`/v2/calendars/${REDACTED}/calendar.ics`);
    expect(redactPathsInText(`GET https://feed.example/v2/calendars/${token}/calendar.ics failed`)).toBe(
      `GET https://feed.example/v2/calendars/${REDACTED}/calendar.ics failed`,
    );
  });

  it('[S10-01] a failed query’s bound values (PII) never reach a log line, its cause or a sanitized error', () => {
    const pg = Object.assign(
      new Error('duplicate key value violates unique constraint "contact_emails_agency_email_uq"'),
      {
        code: '23505',
        constraint: 'contact_emails_agency_email_uq',
        detail: 'Key (agency_id, email)=(a, ana@example.com) already exists.',
      },
    );
    const message =
      'Failed query: insert into "contact_emails" ("email") values ($1)\nparams: ana@example.com,+34600111222';
    const make = () =>
      Object.assign(new Error(message, { cause: pg }), {
        name: 'DrizzleQueryError',
        query: 'insert into "contact_emails" ("email") values ($1)',
        params: ['ana@example.com', '+34600111222'],
      });
    const out = capture();
    createLogger({ destination: out.destination }).error({ err: make() }, 'insert failed');
    const text = out.raw.join('');
    expect(text).not.toContain('ana@example.com');
    expect(text).not.toContain('+34600111222');
    expect(text).toContain('contact_emails_agency_email_uq');
    expect(text).toContain('23505');

    const err = sanitizeError(make());
    expect(err.message).toBe(`Failed query: insert into "contact_emails" ("email") values ($1)\nparams: ${REDACTED}`);
    expect(err.stack).not.toContain('ana@example.com');
    expect(err.stack).toContain('    at ');
    expect((err as unknown as { params: unknown }).params).toBe(REDACTED);
    expect(redactQueryParams('no params here')).toBe('no params here');
  });

  it('[S11-F4] a logged CRM request body prints none of its nested e-mails, phones or notes', () => {
    const out = capture();
    createLogger({ destination: out.destination }).info(
      {
        req: {
          id: 'r1',
          body: {
            emails: [{ email: 'ana-nested@example.com', label: 'work' }],
            phones: [{ phone: '+34611222333', label: 'mobile' }],
            notes: 'note-secret-abc',
            description: 'desc-secret-def',
          },
        },
        contact: { emails: [{ email: 'deep-mail@example.com' }], phones: ['+34699888777'], notes: 'n-secret-ghi' },
        enquiry: { visitorName: 'Visitor Vera', visitorEmail: 'vera@example.com', visitorPhone: '+34655444333' },
        other: { wrapper: { emails: [{ email: 'deeper-mail@example.com' }] } },
      },
      'crm write',
    );
    const text = out.raw.join('');
    for (const pii of [
      'ana-nested@example.com',
      '+34611222333',
      'note-secret-abc',
      'desc-secret-def',
      'deep-mail@example.com',
      '+34699888777',
      'n-secret-ghi',
      'Visitor Vera',
      'vera@example.com',
      '+34655444333',
      'deeper-mail@example.com',
    ]) {
      expect(text).not.toContain(pii);
    }
    const line = out.lines[0] as { req: { id: string; body: unknown }; contact: Record<string, unknown> };
    expect(line.req.id).toBe('r1');
    expect(line.req.body).toBe(REDACTED);
    expect(line.contact.emails).toBe(REDACTED);
    expect(line.contact.phones).toBe(REDACTED);
  });

  it('[S0-03] bindings cannot overwrite the request id', () => {
    const out = capture();
    withRequestId(createLogger({ destination: out.destination }), 'req-1', { requestId: 'spoofed' }).info('x');
    expect(out.lines[0]?.requestId).toBe('req-1');
  });

  it('[S0-03] builds bracket paths for keys that are not identifiers', () => {
    const paths = redactPaths(['email', 'set-cookie']);
    expect(paths).toContain('email');
    expect(paths).toContain('*.*.*.email');
    expect(paths).toContain('["set-cookie"]');
    expect(paths).toContain('*.*["set-cookie"]');
  });
});
