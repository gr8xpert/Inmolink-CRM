import type { z } from 'zod';
import { aadFor, type Keyring } from './aead';

/**
 * A JSON value stored encrypted in one column of a tenant table (S10-F3): connection credentials of imports and
 * exports. The ciphertext is bound to the agency, table, column and row (`aadFor`, the same associated data the
 * modules wrote before), so a value copied to another row, column, table or tenant does not decrypt.
 *
 * The keyring is passed as a getter so a module can declare its cipher at load time and configure the keys at boot.
 * With a `schema`, a decrypted value is parsed by it (a stored value of the wrong shape throws, never flows on).
 */
export interface RowCipher<T> {
  encrypt(agencyId: string, rowId: string, value: T): string;
  decrypt(agencyId: string, rowId: string, envelope: string): T;
}

export function rowCipher<T>(
  table: string,
  column: string,
  keyring: () => Keyring,
  schema?: z.ZodType<T>,
): RowCipher<T> {
  const aad = (agencyId: string, rowId: string) => {
    // An empty part would bind the value to no row (or no tenant): every row of the table could decrypt it.
    if (!agencyId || !rowId) throw new Error(`rowCipher(${table}.${column}): agencyId and rowId are required`);
    return aadFor({ agencyId, table, column, rowId });
  };
  return {
    encrypt: (agencyId, rowId, value) => keyring().encrypt(JSON.stringify(value), aad(agencyId, rowId)),
    decrypt: (agencyId, rowId, envelope) => {
      const value: unknown = JSON.parse(keyring().decrypt(envelope, aad(agencyId, rowId)));
      return schema ? schema.parse(value) : (value as T);
    },
  };
}
