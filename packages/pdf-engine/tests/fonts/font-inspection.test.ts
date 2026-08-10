import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import fontkit from '@pdf-lib/fontkit';
import { describe, expect, test } from 'vitest';

import {
  inspectFont,
  readFontDecorationMetrics,
} from '../../src/fonts/font-inspection';

const TTF_PATH = resolve(
  'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',
);
const OTF_PATH = resolve(
  'packages/test-support/fixtures/fonts/Cantarell-Regular.otf',
);

async function bytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

function asOs2Version1(source: Uint8Array): Uint8Array {
  const result = new Uint8Array(source);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  const tableCount = view.getUint16(4);
  for (let index = 0; index < tableCount; index += 1) {
    const directoryOffset = 12 + index * 16;
    const tag = new TextDecoder('latin1').decode(
      result.subarray(directoryOffset, directoryOffset + 4),
    );
    if (tag !== 'OS/2') continue;
    const tableOffset = view.getUint32(directoryOffset + 8);
    view.setUint16(tableOffset, 1);
    return result;
  }
  throw new Error('Test font has no OS/2 table');
}

function withFsType(source: Uint8Array, fsType: number): Uint8Array {
  const result = new Uint8Array(source);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  const tableCount = view.getUint16(4);
  for (let index = 0; index < tableCount; index += 1) {
    const directoryOffset = 12 + index * 16;
    const tag = new TextDecoder('latin1').decode(
      result.subarray(directoryOffset, directoryOffset + 4),
    );
    if (tag === 'OS/2') {
      const tableOffset = view.getUint32(directoryOffset + 8);
      view.setUint16(tableOffset + 8, fsType);
      return result;
    }
  }
  throw new Error('Test font has no OS/2 table');
}

describe('inspectFont', () => {
  test('reports stable TTF identity, metrics, coverage, and installable rights', async () => {
    const inspection = await inspectFont(await bytes(TTF_PATH));

    expect(inspection).toMatchObject({
      sourceFormat: 'truetype',
      outlineFormat: 'truetype',
      postscriptName: 'LiberationSans',
      familyName: 'Liberation Sans',
      subfamilyName: 'Regular',
      unitsPerEm: 2048,
      weight: 400,
      width: 5,
      italic: false,
      embedding: {
        usage: 'installable',
        documentEditingAllowed: true,
        subsettingAllowed: true,
        bitmapOnly: false,
      },
    });
    expect(inspection.codePoints).toContain('A'.codePointAt(0));
    expect(inspection.codePoints).toContain('é'.codePointAt(0));
    expect(inspection.metricsFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(inspection.codePoints)).toBe(true);
  });

  test('reports a supported single-face CFF OTF', async () => {
    const inspection = await inspectFont(await bytes(OTF_PATH));

    expect(inspection).toMatchObject({
      sourceFormat: 'opentype',
      outlineFormat: 'cff',
      postscriptName: 'Cantarell-Regular',
      familyName: 'Cantarell',
      weight: 400,
      italic: false,
    });
  });

  test('derives omitted OS/2 v1 cap and x-height metrics from real glyph bounds', async () => {
    const source = await bytes(TTF_PATH);
    const patched = asOs2Version1(source);
    const parsed = fontkit.create(patched);
    const parsedOs2 = parsed['OS/2'] as typeof parsed['OS/2'] & {
      yStrikeoutPosition: number;
      yStrikeoutSize: number;
    };

    expect(parsed.capHeight).toBeUndefined();
    expect(parsed.xHeight).toBeUndefined();

    const expectedCapHeight = parsed.glyphForCodePoint('H'.codePointAt(0)!).bbox.maxY;
    const expectedXHeight = parsed.glyphForCodePoint('x'.codePointAt(0)!).bbox.maxY;
    const sourceInspection = await inspectFont(source);
    expect(Number.isFinite(sourceInspection.capHeight)).toBe(true);
    expect(Number.isFinite(sourceInspection.xHeight)).toBe(true);

    const inspection = await inspectFont(patched);

    expect(inspection).toMatchObject({
      postscriptName: 'LiberationSans',
      familyName: 'Liberation Sans',
      subfamilyName: 'Regular',
      weight: 400,
      capHeight: expectedCapHeight,
      xHeight: expectedXHeight,
      underlinePosition: parsed.underlinePosition,
      underlineThickness: parsed.underlineThickness,
      strikeoutPosition: parsedOs2.yStrikeoutPosition,
      strikeoutThickness: parsedOs2.yStrikeoutSize,
      embedding: {
        documentEditingAllowed: true,
      },
    });
  });

  test('reads signed decoration metrics and treats absent or truncated fields as unavailable', () => {
    const source = new Uint8Array(80);
    const view = new DataView(source.buffer);
    view.setInt16(8, -125);
    view.setInt16(10, 75);
    view.setInt16(40 + 26, 80);
    view.setInt16(40 + 28, 450);

    expect(readFontDecorationMetrics(source, [
      { tag: 'post', offset: 0, length: 12 },
      { tag: 'OS/2', offset: 40, length: 30 },
    ])).toEqual({
      underlinePosition: -125,
      underlineThickness: 75,
      strikeoutPosition: 450,
      strikeoutThickness: 80,
    });
    expect(readFontDecorationMetrics(source, [
      { tag: 'post', offset: 0, length: 11 },
      { tag: 'OS/2', offset: 40, length: 29 },
    ])).toEqual({
      underlinePosition: null,
      underlineThickness: null,
      strikeoutPosition: null,
      strikeoutThickness: null,
    });
  });

  test.each([
    [0x0000, 'installable', true, true, false],
    [0x0008, 'editable', true, true, false],
    [0x0004, 'preview-print', false, true, false],
    [0x0002, 'restricted', false, true, false],
    [0x0100, 'installable', true, false, false],
    [0x0200, 'installable', false, true, true],
  ] as const)(
    'interprets fsType 0x%s without weakening embedding rights',
    async (fsType, usage, documentEditingAllowed, subsettingAllowed, bitmapOnly) => {
      const inspection = await inspectFont(withFsType(await bytes(TTF_PATH), fsType));

      expect(inspection.embedding).toEqual({
        usage,
        documentEditingAllowed,
        subsettingAllowed,
        bitmapOnly,
      });
    },
  );
});
