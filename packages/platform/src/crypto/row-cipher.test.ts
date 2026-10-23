import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { aadFor, createKeyring, DecryptError, generateKey } from './aead';
import { rowCipher } from './row-cipher';

const keyring = createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' });
const credentials = { username: 'agency', password: 's3cret' };

describe('rowCipher', () => {
  const portal = rowCipher<Record<string, string>>('agency_portal_connections', 'credentials_enc', () => keyring);

  it('[S10-F3] a value round-trips for its own row', () => {
    const envelope = portal.encrypt('agency-a', 'row-1', credentials);
    expect(envelope).not.toContain('s3cret');
    expect(portal.decrypt('agency-a', 'row-1', envelope)).toEqual(credentials);
  });

  it('[S10-F3] a ciphertext bound to one row does not decrypt for another row, agency, column or table', () => {
    const envelope = portal.encrypt('agency-a', 'row-1', credentials);
    expect(() => portal.decrypt('agency-a', 'row-2', envelope)).toThrow(DecryptError);
    expect(() => portal.decrypt('agency-b', 'row-1', envelope)).toThrow(DecryptError);
    const otherColumn = rowCipher('agency_portal_connections', 'secret_enc', () => keyring);
    expect(() => otherColumn.decrypt('agency-a', 'row-1', envelope)).toThrow(DecryptError);
    const otherTable = rowCipher('feed_connections', 'credentials_enc', () => keyring);
    expect(() => otherTable.decrypt('agency-a', 'row-1', envelope)).toThrow(DecryptError);
  });

  it('[S10-F3] values stored before rowCipher (the same associated data) still decrypt, and the other way round', () => {
    const aad = aadFor({ agencyId: 'agency-a', table: 'feed_connections', column: 'credentials_enc', rowId: 'row-1' });
    const feeds = rowCipher('feed_connections', 'credentials_enc', () => keyring);
    const legacy = keyring.encrypt(JSON.stringify(credentials), aad);
    expect(feeds.decrypt('agency-a', 'row-1', legacy)).toEqual(credentials);
    expect(JSON.parse(keyring.decrypt(feeds.encrypt('agency-a', 'row-1', credentials), aad))).toEqual(credentials);
  });

  it('[S10-F3] the keyring is read when used, so a module declares its cipher before boot configures the keys', () => {
    const cipher = rowCipher('feed_connections', 'credentials_enc', () => {
      throw new Error('not configured');
    });
    expect(() => cipher.encrypt('agency-a', 'row-1', credentials)).toThrow('not configured');
  });

  it('[S10-F3] an empty agency or row id is refused: it would bind the value to no row', () => {
    expect(() => portal.encrypt('', 'row-1', credentials)).toThrow(/agencyId and rowId are required/);
    expect(() => portal.encrypt('agency-a', '', credentials)).toThrow(/agencyId and rowId are required/);
    const envelope = portal.encrypt('agency-a', 'row-1', credentials);
    expect(() => portal.decrypt('agency-a', '', envelope)).toThrow(/agencyId and rowId are required/);
  });

  it('[S10-F3] with a schema, a decrypted value of the wrong shape throws', () => {
    const typed = rowCipher('t', 'c', () => keyring, z.record(z.string(), z.string()));
    const loose = rowCipher<unknown>('t', 'c', () => keyring);
    expect(typed.decrypt('agency-a', 'row-1', typed.encrypt('agency-a', 'row-1', credentials))).toEqual(credentials);
    expect(() => typed.decrypt('agency-a', 'row-1', loose.encrypt('agency-a', 'row-1', { port: 25 }))).toThrow();
  });
});
