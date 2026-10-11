import { describe, expect, it } from 'vitest';
import { DecideVerificationBody, DocumentFileName, UploadVerificationDocumentQuery } from './verification';

describe('verification contracts', () => {
  it('[S1-03] a decision reason keeps line breaks from the staff textarea and refuses markup and controls', () => {
    const parsed = DecideVerificationBody.parse({
      decision: 'REJECT',
      agencyVersion: 3,
      reason: '  Please upload:\r\n- the CIF card\r\n- the deeds  ',
    });
    expect(parsed.reason).toBe('Please upload:\n- the CIF card\n- the deeds');
    for (const reason of ['ok', '   ', '<b>no</b>', 'tab\there', 'bell\u0007', 'x'.repeat(1001)]) {
      expect(DecideVerificationBody.safeParse({ decision: 'APPROVE', agencyVersion: 1, reason }).success, reason).toBe(
        false,
      );
    }
  });

  it('[S1-03] document names cannot carry paths, controls or markup', () => {
    expect(DocumentFileName.parse('  Escritura 2024 (copia).pdf ')).toBe('Escritura 2024 (copia).pdf');
    for (const bad of ['../../etc/passwd', 'a\\b.pdf', 'C:evil', '<img>.png', 'a\nb.pdf', '', 'x'.repeat(121)]) {
      expect(DocumentFileName.safeParse(bad).success, bad).toBe(false);
    }
    expect(UploadVerificationDocumentQuery.safeParse({ kind: 'TAX_ID', fileName: 'cif.pdf', extra: 1 }).success).toBe(
      false,
    );
  });
});
