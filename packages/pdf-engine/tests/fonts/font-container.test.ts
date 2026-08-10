import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { normaliseFontContainer } from '../../src/fonts/font-container';

const TTF_PATH = resolve(
  'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',
);
const OTF_PATH = resolve(
  'packages/test-support/fixtures/fonts/Cantarell-Regular.otf',
);
const WOFF1_PATH = resolve(
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff',
);
const COLOUR_OTF_PATH = resolve(
  'packages/test-support/fixtures/fonts/SourceCodePro-Regular.otf',
);

async function bytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

describe('normaliseFontContainer', () => {
  test.each([
    [TTF_PATH, 'truetype', 'truetype', 0x00010000],
    [OTF_PATH, 'opentype', 'cff', 0x4f54544f],
    [WOFF1_PATH, 'woff1', 'truetype', 0x00010000],
  ] as const)(
    'normalises supported %s bytes into a bounded SFNT',
    async (path, sourceFormat, outlineFormat, signature) => {
      const result = await normaliseFontContainer(await bytes(path));

      expect(result.sourceFormat).toBe(sourceFormat);
      expect(result.outlineFormat).toBe(outlineFormat);
      expect(new DataView(
        result.sfntBytes.buffer,
        result.sfntBytes.byteOffset,
        result.sfntBytes.byteLength,
      ).getUint32(0)).toBe(signature);
      expect(result.tableTags).toContain('cmap');
      expect(result.tableTags).toContain('name');
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.tableTags)).toBe(true);
    },
  );

  test.each([
    [new Uint8Array([0x77, 0x4f, 0x46, 0x32]), 'WOFF2'],
    [new Uint8Array([0x74, 0x74, 0x63, 0x66]), 'font collections'],
    [new Uint8Array([0, 1, 2, 3]), 'font signature'],
  ] as const)('rejects unsupported %s input', async (input, description) => {
    await expect(normaliseFontContainer(input)).rejects.toMatchObject({
      code: 'FONT_UNAVAILABLE',
      message: expect.stringContaining(description),
    });
  });

  test('rejects colour-outline tables', async () => {
    await expect(
      normaliseFontContainer(await bytes(COLOUR_OTF_PATH)),
    ).rejects.toMatchObject({
      code: 'FONT_UNAVAILABLE',
      message: expect.stringContaining('colour'),
    });
  });

  test('rejects variable-font tables before parsing the face', async () => {
    const input = new Uint8Array(await bytes(TTF_PATH));
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const tableCount = view.getUint16(4);
    let replaced = false;
    for (let index = 0; index < tableCount; index += 1) {
      const offset = 12 + index * 16;
      const tag = new TextDecoder('latin1').decode(input.subarray(offset, offset + 4));
      if (tag === 'name') {
        input.set(new TextEncoder().encode('fvar'), offset);
        replaced = true;
        break;
      }
    }
    expect(replaced).toBe(true);

    await expect(normaliseFontContainer(input)).rejects.toMatchObject({
      code: 'FONT_UNAVAILABLE',
      message: expect.stringContaining('variable'),
    });
  });
});
