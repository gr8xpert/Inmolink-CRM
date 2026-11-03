import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fileNameHeader, fileNameHeaders } from './file-name-header';
import { UploadVerificationDocumentHeaders } from './verification';

describe('file name header', () => {
  it('[S17-F6] a name survives the header round trip, including accents and spaces', () => {
    const name = 'Escritura nº 2 (copia) ñ.pdf';
    const header = fileNameHeader(name);
    expect(header['x-file-name']).toMatch(/^[\x20-\x7e]+$/);
    expect(UploadVerificationDocumentHeaders.parse(header)['x-file-name']).toBe(name);
  });

  it('[S17-F6] the route rules apply to the decoded name; bad encoding and a missing header are refused', () => {
    const parse = (value?: string) =>
      UploadVerificationDocumentHeaders.safeParse(value === undefined ? {} : { 'x-file-name': value }).success;
    expect(parse('..%2F..%2Fetc%2Fpasswd')).toBe(false);
    expect(parse('%E0%A4%A')).toBe(false);
    expect(parse('')).toBe(false);
    expect(parse()).toBe(false);
  });

  it('[S17-F6] the other request headers are kept', () => {
    const parsed = fileNameHeaders(z.string()).parse({ 'x-file-name': 'a.pdf', authorization: 'Bearer x' });
    expect(parsed.authorization).toBe('Bearer x');
  });
});
