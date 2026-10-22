import { CreateFeedConnectionBody, RESALES_API_URL } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import en from '../../../../../../../../packages/i18n/messages/en/imports.json';
import es from '../../../../../../../../packages/i18n/messages/es/imports.json';
import { resalesFormInput } from './resales-input';

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const filled = { clientId: ' 1000 ', apiKey: 'k'.repeat(40), filterAlias: '1', languages: 'ES, de,,' };

describe('Resales Online connection form', () => {
  it('[S7-F14] the form fields make a valid Resales connection body: fixed address, basic credentials, alias and languages', () => {
    const input = resalesFormInput(form(filled), false);
    if (!input.ok) throw new Error('expected a body');
    const body = CreateFeedConnectionBody.parse({
      name: 'Resales',
      connector: 'resales-online',
      url: input.url,
      credentials: input.credentials,
      settings: input.settings,
      scheduleMinutes: 1440,
    });
    expect(body).toMatchObject({
      connector: 'resales-online',
      url: RESALES_API_URL,
      credentials: { type: 'basic', username: '1000', password: 'k'.repeat(40) },
      settings: { filterAlias: '1', languages: 'es,de' },
    });
  });

  it('[S7-F14] a bad filter alias is sent as typed, so the API answers FEED_SETTINGS_INVALID, which the page words in EN and ES', () => {
    const input = resalesFormInput(form({ ...filled, filterAlias: '54031' }), false);
    expect(input.ok && input.settings.filterAlias).toBe('54031');
    for (const messages of [en, es]) expect(messages.errors.FEED_SETTINGS_INVALID).toMatch(/Resales/);
  });

  it('[S7-F14] on edit both credential fields blank keep the saved ones; both filled replace them; one alone is refused in EN and ES', () => {
    const kept = resalesFormInput(form({ ...filled, clientId: '', apiKey: '' }), true);
    expect(kept.ok && kept.credentials).toBeUndefined();
    const replaced = resalesFormInput(form({ ...filled, apiKey: 'new' }), true);
    expect(replaced.ok && replaced.credentials).toMatchObject({ type: 'basic', username: '1000', password: 'new' });
    expect(resalesFormInput(form({ ...filled, apiKey: '' }), true)).toEqual({
      ok: false,
      error: 'CREDENTIALS_INCOMPLETE',
    });
    expect(resalesFormInput(form({ ...filled, clientId: '' }), true)).toEqual({
      ok: false,
      error: 'CREDENTIALS_INCOMPLETE',
    });
    // On create both are needed: blank ones reach the contract, which refuses them.
    const created = resalesFormInput(form({ ...filled, clientId: '' }), false);
    expect(
      created.ok &&
        CreateFeedConnectionBody.safeParse({
          name: 'x',
          connector: 'resales-online',
          url: created.url,
          credentials: created.credentials,
        }).success,
    ).toBe(false);
    expect(en.errors.RESALES_CREDENTIALS_BOTH).toBeTruthy();
    expect(es.errors.RESALES_CREDENTIALS_BOTH).toBeTruthy();
  });

  it('[S7-F14] the form has EN and ES strings for every Resales field', () => {
    const keys = (o: Record<string, unknown>) => Object.keys(o).sort();
    expect(keys(es.form.resales)).toEqual(keys(en.form.resales));
    expect(es.form.formats['resales-online']).toBeTruthy();
    expect(en.form.formats['resales-online']).toBeTruthy();
  });
});
