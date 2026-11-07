import type { ESignProvider, ESignSealInput } from './index';

/**
 * Test double for the e-signature provider (`@inmolink/platform/esign/testing`): seals the fake PDF renderer's bytes
 * (which no PDF library reads) by joining the original and the audit trail with a marker, and keeps every input.
 */
export function fakeESign(): ESignProvider & { seals: ESignSealInput[] } {
  const seals: ESignSealInput[] = [];
  return {
    name: 'fake',
    level: 'SIMPLE',
    seals,
    async seal(input) {
      seals.push(input);
      const marker = new TextEncoder().encode('\n% --- audit trail ---\n');
      const out = new Uint8Array(input.original.length + marker.length + input.auditTrail.length);
      out.set(input.original, 0);
      out.set(marker, input.original.length);
      out.set(input.auditTrail, input.original.length + marker.length);
      return out;
    },
  };
}
