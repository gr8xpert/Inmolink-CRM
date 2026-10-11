import { describe, expect, it } from 'vitest';
import type { Tx } from './client';

describe('db client', () => {
  it('[S0-12] a repo cannot reach a table it does not import (no relational tx.query)', () => {
    // Typechecked, never run: with no schema passed to Drizzle, `tx.query.<table>` does not exist,
    // so every query names an imported table and the boundary check sees it.
    const probe = (tx: Tx) =>
      // @ts-expect-error -- no relational query API on the shared client
      tx.query.users.findMany();
    expect(probe).toBeTypeOf('function');
  });
});
