import { ErrorCodes } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import en from '../../../../../../../../packages/i18n/messages/en/selections.json';
import es from '../../../../../../../../packages/i18n/messages/es/selections.json';
import { SELECTION_DONE, SELECTION_ERRORS } from './errors';
import { errorLabels, shareLabels } from './labels';

const keys = (o: unknown, prefix = ''): string[] =>
  Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

describe('selections dashboard pages', () => {
  it('[S13-F13] every error the pages explain is a real API error code with an EN and an ES text', () => {
    for (const code of SELECTION_ERRORS) {
      expect(ErrorCodes, code).toHaveProperty(code);
      expect(en.errors, code).toHaveProperty(code);
      expect(es.errors, code).toHaveProperty(code);
    }
    for (const done of SELECTION_DONE) expect(en.notices).toHaveProperty(done);
  });

  it('[S13-F13] EN and ES have the same keys (strings for the share buttons, stats and forms)', () => {
    expect(keys(es).sort()).toEqual(keys(en).sort());
    expect(en.share.whatsapp).not.toBe(es.share.whatsapp);
  });

  it('[S13-F13] the client form island gets its labels resolved on the server, errors included', () => {
    const lookup = (key: string) =>
      key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], en) as string;
    expect(shareLabels(lookup).whatsapp).toBe('Share on WhatsApp');
    const errors = errorLabels(lookup);
    expect(Object.keys(errors).sort()).toEqual([...SELECTION_ERRORS, 'generic'].sort());
  });
});
