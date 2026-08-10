import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PDFDocument } from 'pdf-lib';
import { describe, expect, test } from 'vitest';

import {
  embedSubstituteFont,
  type SubstituteFontAsset,
} from '../../src/fonts/font-embedding';
import {
  shapeText,
  type ShapeTextInput,
  type ShapedRun,
} from '../../src/fonts/harfbuzz-shaper';

const LATIN_PATH = resolve(
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff',
);
const ARABIC_PATH = resolve(
  'node_modules/@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff',
);

async function input(
  text: string,
  fontPath = LATIN_PATH,
  hints: Omit<ShapeTextInput, 'fontBytes' | 'text'> = {},
): Promise<ShapeTextInput> {
  return {
    fontBytes: new Uint8Array(await readFile(fontPath)),
    text,
    ...hints,
  };
}

function expectValidRun(run: ShapedRun, codePointCount: number): void {
  expect(run.glyphs.length).toBeGreaterThan(0);
  expect(run.unitsPerEm).toBeGreaterThan(0);

  const starts = [...new Set(run.glyphs.map(({ cluster }) => cluster))].sort(
    (left, right) => left - right,
  );
  expect(starts[0]).toBe(0);
  expect(starts.every((cluster) => cluster >= 0 && cluster < codePointCount)).toBe(
    true,
  );

  const covered = new Set<number>();
  starts.forEach((start, index) => {
    const end = starts[index + 1] ?? codePointCount;
    for (let codePoint = start; codePoint < end; codePoint += 1) {
      covered.add(codePoint);
    }
  });
  expect([...covered]).toEqual(
    Array.from({ length: codePointCount }, (_, index) => index),
  );

  for (const glyph of run.glyphs) {
    expect(glyph.glyphId).toBeGreaterThan(0);
    expect(
      [glyph.xAdvance, glyph.yAdvance, glyph.xOffset, glyph.yOffset].every(
        Number.isFinite,
      ),
    ).toBe(true);
  }
}

describe('shapeText', () => {
  test.each([
    ['office', LATIN_PATH, {}, 'ltr'],
    ['A\u0301', LATIN_PATH, {}, 'ltr'],
    ['سلام', ARABIC_PATH, { script: 'Arab', language: 'ar' }, 'rtl'],
  ] as const)(
    'shapes %s with deterministic glyph and cluster evidence',
    async (text, fontPath, hints, expectedDirection) => {
      const shapeInput = await input(text, fontPath, hints);

      const first = await shapeText(shapeInput);
      const second = await shapeText(shapeInput);

      expectValidRun(first, [...text].length);
      expect(first).toEqual(second);
      expect(first.direction).toBe(expectedDirection);
      expect(Object.isFrozen(first)).toBe(true);
      expect(first.glyphs.every(Object.isFrozen)).toBe(true);
    },
  );

  test('honours explicit direction, script, and language hints', async () => {
    const run = await shapeText(
      await input('office', LATIN_PATH, {
        direction: 'rtl',
        script: 'Latn',
        language: 'en',
      }),
    );

    expect(run.direction).toBe('rtl');
  });
});

describe('embedSubstituteFont', () => {
  test('subsets exact local bytes and records complete OFL coverage evidence', async () => {
    const text = 'office A\u0301';
    const fontBytes = new Uint8Array(await readFile(LATIN_PATH));
    const shapedRun = await shapeText({ fontBytes, text });
    const document = await PDFDocument.create();
    const asset: SubstituteFontAsset = {
      bytes: fontBytes,
      family: 'Noto Sans',
      version: '5.3.0',
      licence: 'OFL-1.1',
      source: '@fontsource/noto-sans',
    };

    const plan = await embedSubstituteFont(document, shapedRun, text, asset);
    const bytes = await document.save({ useObjectStreams: false });

    expect(plan.subset).toBe(true);
    expect(plan.provenance).toEqual({
      family: 'Noto Sans',
      version: '5.3.0',
      licence: 'OFL-1.1',
      source: '@fontsource/noto-sans',
    });
    expect(plan.coveredCodePoints).toEqual([
      ...new Set([...text.normalize('NFC')].map((value) => value.codePointAt(0)!)),
    ]);
    expect(plan.encodedText).toMatch(/^<[0-9A-F]+>$/i);
    expect(plan.fontName).not.toMatch(/Helvetica|Times|Courier|Symbol|Zapf/i);
    expect(plan.fontRef.objectNumber).toBeGreaterThan(0);
    expect(new TextDecoder('latin1').decode(bytes)).toContain('/FontFile2');
  });

  test('rejects a font that does not cover every replacement code point', async () => {
    const fontBytes = new Uint8Array(await readFile(LATIN_PATH));
    const text = 'سلام';
    const document = await PDFDocument.create();

    await expect(
      embedSubstituteFont(document, await shapeText({ fontBytes, text }), text, {
        bytes: fontBytes,
        family: 'Noto Sans',
        version: '5.3.0',
        licence: 'OFL-1.1',
        source: '@fontsource/noto-sans',
      }),
    ).rejects.toMatchObject({ code: 'FONT_UNAVAILABLE' });
  });
});
