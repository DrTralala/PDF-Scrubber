import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PDFDocument } from 'pdf-lib';
import { describe, expect, test } from 'vitest';

import {
  embedResolvedFontRuns,
  type ResolvedFontAsset,
} from '../../src/fonts/font-embedding';
import { FontRegistry } from '../../src/fonts/font-registry';
import { shapeText } from '../../src/fonts/harfbuzz-shaper';

const CASES = [
  {
    name: 'TTF',
    path: resolve('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'),
    fontFileKey: '/FontFile2',
  },
  {
    name: 'CFF/OTF',
    path: resolve('packages/test-support/fixtures/fonts/Cantarell-Regular.otf'),
    fontFileKey: '/FontFile3',
  },
  {
    name: 'WOFF1',
    path: resolve('node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff'),
    fontFileKey: '/FontFile2',
  },
] as const;

async function asset(path: string): Promise<ResolvedFontAsset> {
  const bytes = new Uint8Array(await readFile(path));
  const registry = new FontRegistry();
  const descriptor = await registry.register({ source: 'upload', fileName: path, bytes });
  return Object.freeze({
    descriptor,
    bytes: registry.getBytes(descriptor.id),
    matchKind: 'exact',
  });
}

describe('embedResolvedFontRuns', () => {
  test.each(CASES)('embeds multiple $name runs through one font resource', async ({ path, fontFileKey }) => {
    const font = await asset(path);
    const runs = await Promise.all(['Fo', 'lio'].map(async (text) => Object.freeze({
      text,
      shapedRun: await shapeText({ fontBytes: font.bytes, text }),
    })));
    const document = await PDFDocument.create();

    const plan = await embedResolvedFontRuns(document, runs, font);
    const bytes = await document.save({ useObjectStreams: false });

    expect(plan.encodedTexts).toHaveLength(2);
    expect(plan.encodedTexts.every((encoded) => /^<[0-9A-F]+>$/i.test(encoded))).toBe(true);
    expect(plan.provenance.hash).toBe(font.descriptor.hash);
    expect(plan.subset).toBe(true);
    expect(new TextDecoder('latin1').decode(bytes)).toContain(fontFileKey);
  });

  test('rejects font bytes that no longer match the inspected descriptor', async () => {
    const font = await asset(CASES[0].path);
    const tampered = new Uint8Array(font.bytes);
    const finalIndex = tampered.length - 1;
    tampered[finalIndex] = tampered[finalIndex]! ^ 0xff;
    const text = 'PDF-Scrubber';
    const document = await PDFDocument.create();

    await expect(embedResolvedFontRuns(document, [{
      text,
      shapedRun: await shapeText({ fontBytes: font.bytes, text }),
    }], Object.freeze({ ...font, bytes: tampered }))).rejects.toMatchObject({
      code: 'STALE_REVISION',
    });
  });
});
