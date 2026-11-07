import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { configureESign, createBuiltinESign, ESignInputError, esign } from './index';
import { fakeESign } from './testing';

async function pdfOf(pages: number, text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date('2026-11-07T10:00:00Z'));
  for (let i = 0; i < pages; i++) doc.addPage([300, 300]).drawText(`${text} ${i + 1}`, { x: 20, y: 150 });
  return doc.save();
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('esign (R2-05b)', () => {
  it('[R2-05b] the built-in provider appends the audit trail pages after every original page', async () => {
    const original = await pdfOf(3, 'clause');
    const auditTrail = await pdfOf(1, 'audit');
    const signed = await createBuiltinESign().seal({ original, auditTrail, info: { title: 'Offer' } });
    const doc = await PDFDocument.load(signed);
    expect(doc.getPageCount()).toBe(4);
    expect(doc.getTitle()).toBe('Offer');
  });

  it('[R2-05b] sealing is deterministic (a retried seal records the same hash)', async () => {
    const original = await pdfOf(2, 'clause');
    const auditTrail = await pdfOf(1, 'audit');
    const a = await createBuiltinESign().seal({ original, auditTrail });
    const b = await createBuiltinESign().seal({ original, auditTrail });
    expect(sha(a)).toBe(sha(b));
  });

  it('[R2-05b] a damaged PDF is refused as bad input', async () => {
    const auditTrail = await pdfOf(1, 'audit');
    await expect(
      createBuiltinESign().seal({ original: new TextEncoder().encode('%PDF-1.4 nope'), auditTrail }),
    ).rejects.toBeInstanceOf(ESignInputError);
    await expect(createBuiltinESign().seal({ original: new Uint8Array(), auditTrail })).rejects.toBeInstanceOf(
      ESignInputError,
    );
  });

  it('[R2-05b] the adapter defaults to the built-in provider and takes a fake in tests', async () => {
    configureESign(undefined);
    expect(esign().name).toBe('builtin');
    const fake = fakeESign();
    configureESign(fake);
    const out = await esign().seal({ original: new Uint8Array([1]), auditTrail: new Uint8Array([2]) });
    expect(fake.seals).toHaveLength(1);
    expect(out[0]).toBe(1);
    expect(out.at(-1)).toBe(2);
    configureESign(undefined);
  });
});
