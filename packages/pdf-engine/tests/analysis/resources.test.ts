import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';

import { PROVISIONAL_LIMITS } from '../../src/limits';
import { ObjectStore } from '../../src/pdf/object-store';
import { ResourceIndex } from '../../src/analysis/resources';
import { analysePage } from '../../src/analysis/analyse-page';

async function fixture(id: string): Promise<Uint8Array> {
  return readFile(resolve('fixtures/generated', `${id}.pdf`));
}

describe('ResourceIndex', () => {
  test('decodes array-form bfrange mappings in the wkhtmltopdf fixture', async () => {
    const store = await ObjectStore.open(
      await fixture('30-wkhtmltopdf-rich-line'),
      PROVISIONAL_LIMITS,
    );
    const page = await analysePage(store, 0);
    const glyphs = page.spans.flatMap(({ glyphs: spanGlyphs }) => spanGlyphs);

    expect(glyphs).toHaveLength(50);
    expect(glyphs.every(({ unicode }) => unicode !== null)).toBe(true);
    expect(glyphs.map(({ unicode }) => unicode).join('')).toBe(
      'ShopeeCustomer Name:Alex Morganthis is a bold text',
    );
  });

  test('decodes a Standard 14 font with authoritative widths', async () => {
    const store = await ObjectStore.open(await fixture('01-simple-tj'), PROVISIONAL_LIMITS);
    const index = await ResourceIndex.build(store, 0);
    const path = store.listPageStreams(0)[0]!.path;
    const fontName = index.fontNames(path)[0]!;
    const font = index.font(path, fontName);
    const glyphs = font.decode(new TextEncoder().encode('Target 01'));

    expect(font).toMatchObject({ subtype: 'Type1', baseFont: 'Helvetica', writingMode: 0 });
    expect(glyphs.map(({ unicode }) => unicode).join('')).toBe('Target 01');
    expect(glyphs.every(({ advance }) => advance > 0)).toBe(true);
    expect(glyphs.map(({ sourceCodeStart, sourceCodeEnd }) => [sourceCodeStart, sourceCodeEnd]))
      .toEqual(Array.from({ length: 9 }, (_, indexValue) => [indexValue, indexValue + 1]));
  });

  test('uses embedded Type0 ToUnicode and CID width evidence', async () => {
    const store = await ObjectStore.open(await fixture('08-combining-marks'), PROVISIONAL_LIMITS);
    const index = await ResourceIndex.build(store, 0);
    const path = store.listPageStreams(0)[0]!.path;
    const font = index.font(path, index.fontNames(path)[0]!);
    const stream = store.listPageStreams(0)[0]!;
    const encoded = stream.decodedBytes;
    const firstHexStart = encoded.indexOf(0x3c);
    const firstHexEnd = encoded.indexOf(0x3e, firstHexStart + 1);
    const hex = new TextDecoder().decode(encoded.slice(firstHexStart + 1, firstHexEnd));
    const sourceCodes = Uint8Array.from(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
    const glyphs = font.decode(sourceCodes);

    expect(font).toMatchObject({ subtype: 'Type0', embedded: true, writingMode: 0 });
    expect(glyphs.map(({ unicode }) => unicode).join('')).toBe('Café 08');
    expect(glyphs.every(({ glyphId, advance }) =>
      glyphId !== null && Number.isFinite(advance) && advance >= 0)).toBe(true);
    expect(glyphs.some(({ advance }) => advance > 0)).toBe(true);
    expect(glyphs.every(({ sourceCodeEnd, sourceCodeStart }) => sourceCodeEnd - sourceCodeStart === 2))
      .toBe(true);
  });

  test('records Form ownership and inbound sharing before classification', async () => {
    const store = await ObjectStore.open(
      await fixture('18-shared-form-xobject'),
      PROVISIONAL_LIMITS,
    );
    const first = await ResourceIndex.build(store, 0);
    const rootPath = store.listPageStreams(0).find(({ path }) => path.length === 1)!.path;
    const formName = first.formNames(rootPath)[0]!;

    expect(first.form(rootPath, formName)).toMatchObject({ referenceCount: 2 });
  });

  test('preserves source evidence but reports null Unicode without a usable mapping', async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 200]);
    const font = document.context.register(document.context.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'PrivateFont',
      FirstChar: 65,
      LastChar: 65,
      Widths: [500],
    }));
    page.node.set(PDFName.of('Resources'), document.context.obj({ Font: { F0: font } }));
    const stream = document.context.register(
      document.context.stream('BT /F0 12 Tf 20 30 Td (A) Tj ET'),
    );
    page.node.set(PDFName.of('Contents'), stream);
    const store = await ObjectStore.open(
      await document.save({ useObjectStreams: false }),
      PROVISIONAL_LIMITS,
    );
    const path = store.listPageStreams(0)[0]!.path;
    const indexed = await ResourceIndex.build(store, 0);

    expect(indexed.font(path, 'F0').decode(Uint8Array.of(65))).toEqual([
      expect.objectContaining({
        sourceCodeStart: 0,
        sourceCodeEnd: 1,
        glyphId: 65,
        unicode: null,
        advance: 500,
      }),
    ]);
  });
});
