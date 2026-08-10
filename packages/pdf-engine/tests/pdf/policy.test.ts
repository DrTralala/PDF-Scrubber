import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';

import { PROVISIONAL_LIMITS } from '../../src/limits';
import { ObjectStore } from '../../src/pdf/object-store';
import {
  detectDocumentPolicy,
  inspectEncryptionEvidence,
} from '../../src/pdf/policy';

async function fixture(id: string): Promise<Uint8Array> {
  return readFile(resolve('fixtures/generated', `${id}.pdf`));
}

describe('document policy evidence', () => {
  test('reports tags and PDF/UA characteristics without claiming conformance', async () => {
    const store = await ObjectStore.open(
      await fixture('22-tagged-pdfua-marker'),
      PROVISIONAL_LIMITS,
    );

    expect(await detectDocumentPolicy(store)).toEqual({
      encryption: { observed: false, confidence: 'notObserved' },
      signatures: { observed: false, confidence: 'notObserved', count: 0 },
      markedContent: { observed: true, confidence: 'direct' },
      structureTree: { observed: true, confidence: 'direct' },
      pdfA: { observed: false, confidence: 'notObserved', identifier: null },
      pdfUa: { observed: true, confidence: 'direct', identifier: null },
    });
  });

  test('reports XMP PDF/A identifiers as metadata evidence', async () => {
    const store = await ObjectStore.open(await fixture('23-pdfa-marker'), PROVISIONAL_LIMITS);
    expect((await detectDocumentPolicy(store)).pdfA).toEqual({
      observed: true,
      confidence: 'metadata',
      identifier: 'PDF/A-2B',
    });
  });

  test('reports XMP PDF/UA identifiers as metadata evidence', async () => {
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    const metadata = document.context.stream(
      '<rdf:Description xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" ' +
      'pdfuaid:part="1"/>',
      { Type: 'Metadata', Subtype: 'XML' },
    );
    document.catalog.set(PDFName.of('Metadata'), document.context.register(metadata));
    const store = await ObjectStore.open(
      await document.save({ useObjectStreams: false }),
      PROVISIONAL_LIMITS,
    );

    expect((await detectDocumentPolicy(store)).pdfUa).toEqual({
      observed: true,
      confidence: 'metadata',
      identifier: 'PDF/UA-1',
    });
  });

  test('counts signature fields and dictionaries as direct evidence', async () => {
    const store = await ObjectStore.open(
      await fixture('24-signature-marker'),
      PROVISIONAL_LIMITS,
    );
    expect((await detectDocumentPolicy(store)).signatures).toEqual({
      observed: true,
      confidence: 'direct',
      count: 1,
    });
  });

  test('counts a standalone signature dictionary as direct evidence', async () => {
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    document.context.register(document.context.obj({ Type: 'Sig', Filter: 'M0Filter' }));
    const store = await ObjectStore.open(
      await document.save({ useObjectStreams: false }),
      PROVISIONAL_LIMITS,
    );

    expect((await detectDocumentPolicy(store)).signatures).toEqual({
      observed: true,
      confidence: 'direct',
      count: 1,
    });
  });

  test('detects encryption before opening and open rejects it', async () => {
    const bytes = await fixture('25-encryption-marker');
    expect(inspectEncryptionEvidence(bytes)).toEqual({
      observed: true,
      confidence: 'direct',
    });
    await expect(ObjectStore.open(bytes, PROVISIONAL_LIMITS)).rejects.toMatchObject({
      code: 'UNSUPPORTED_DOCUMENT',
    });
  });

  test('returns byte-for-byte stable evidence for identical input', async () => {
    const store = await ObjectStore.open(await fixture('01-simple-tj'), PROVISIONAL_LIMITS);
    const first = await detectDocumentPolicy(store);
    const second = await detectDocumentPolicy(store);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
