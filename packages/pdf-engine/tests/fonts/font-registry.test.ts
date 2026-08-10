import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  FontRegistry,
  type FontRequirement,
} from '../../src/fonts/font-registry';

const TTF_PATH = resolve(
  'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',
);
const OTF_PATH = resolve(
  'packages/test-support/fixtures/fonts/Cantarell-Regular.otf',
);
const BOLD_TTF_PATH = resolve(
  'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf',
);

async function bytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
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
      view.setUint16(view.getUint32(directoryOffset + 8) + 8, fsType);
      return result;
    }
  }
  throw new Error('Test font has no OS/2 table');
}

function requirement(overrides: Partial<FontRequirement> = {}): FontRequirement {
  return Object.freeze({
    postscriptName: 'LiberationSans',
    familyName: 'Liberation Sans',
    subfamilyName: 'Regular',
    weight: 400,
    italic: false,
    requiredCodePoints: Object.freeze([...'Account Name:'].map(
      (character) => character.codePointAt(0)!,
    )),
    exactByteHash: null,
    metricsFingerprint: null,
    ...overrides,
  });
}

describe('FontRegistry', () => {
  test('deduplicates owned bytes by hash and returns defensive byte copies', async () => {
    const registry = new FontRegistry();
    const input = await bytes(TTF_PATH);

    const first = await registry.register({
      source: 'upload',
      fileName: 'LiberationSans-Regular.ttf',
      bytes: input,
    });
    input.fill(0);
    const second = await registry.register({
      source: 'local',
      fileName: 'renamed.ttf',
      bytes: await bytes(TTF_PATH),
    });

    expect(second.id).toBe(first.id);
    expect(registry.list()).toHaveLength(1);
    const firstCopy = registry.getBytes(first.id);
    firstCopy.fill(0);
    expect(registry.getBytes(first.id).some((byte) => byte !== 0)).toBe(true);
  });

  test('ranks exact, compatible, substitute, and unavailable resolutions', async () => {
    const registry = new FontRegistry();
    const liberation = await registry.register({
      source: 'upload',
      fileName: 'LiberationSans-Regular.ttf',
      bytes: await bytes(TTF_PATH),
    });
    await registry.register({
      source: 'bundled',
      fileName: 'Cantarell-Regular.otf',
      bytes: await bytes(OTF_PATH),
    });

    expect(registry.resolve(requirement({ exactByteHash: liberation.hash }))).toMatchObject({
      kind: 'exact',
      font: { id: liberation.id },
    });
    expect(registry.resolve(requirement())).toMatchObject({
      kind: 'compatible-version',
      font: { id: liberation.id },
    });
    expect(registry.resolve(requirement({
      postscriptName: null,
      familyName: 'Unidentified Receipt Sans',
      subfamilyName: null,
    }))).toMatchObject({
      kind: 'substitute',
      font: { id: liberation.id },
    });
    expect(registry.resolve(requirement({
      requiredCodePoints: Object.freeze(['ش'.codePointAt(0)!]),
    }))).toEqual({
      kind: 'unavailable',
      font: null,
      reasons: ['missing-glyph-coverage'],
    });
  });

  test('prefers a style-compatible face when every candidate is a substitute', async () => {
    const registry = new FontRegistry();
    const regular = await registry.register({
      source: 'local',
      fileName: 'LiberationSans-Regular.ttf',
      bytes: await bytes(TTF_PATH),
    });
    const bold = await registry.register({
      source: 'upload',
      fileName: 'LiberationSans-Bold.ttf',
      bytes: await bytes(BOLD_TTF_PATH),
    });

    expect(registry.resolve(requirement({
      postscriptName: null,
      familyName: 'Unknown Receipt Sans',
      subfamilyName: null,
      weight: 700,
    }))).toMatchObject({
      kind: 'substitute',
      font: { id: bold.id },
    });
    expect(bold.id).not.toBe(regular.id);
  });

  test('rejects prohibited embedding and bounded-catalogue overflow', async () => {
    const registry = new FontRegistry({
      maxFaceBytes: 1024 * 1024,
      maxFaces: 1,
      maxTotalBytes: 1024 * 1024,
    });
    await registry.register({
      source: 'upload',
      fileName: 'LiberationSans-Regular.ttf',
      bytes: await bytes(TTF_PATH),
    });

    await expect(registry.register({
      source: 'upload',
      fileName: 'Cantarell-Regular.otf',
      bytes: await bytes(OTF_PATH),
    })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });

  test('rejects a font whose embedding rights prohibit edited documents', async () => {
    const registry = new FontRegistry();

    await expect(registry.register({
      source: 'upload',
      fileName: 'restricted.ttf',
      bytes: withFsType(await bytes(TTF_PATH), 0x0002),
    })).rejects.toMatchObject({
      code: 'FONT_EMBEDDING_PROHIBITED',
      message: expect.stringContaining('restricted'),
    });
    expect(registry.list()).toEqual([]);
  });

  test('clears tab-owned font bytes explicitly', async () => {
    const registry = new FontRegistry();
    const font = await registry.register({
      source: 'upload',
      fileName: 'LiberationSans-Regular.ttf',
      bytes: await bytes(TTF_PATH),
    });

    registry.clear();

    expect(registry.list()).toEqual([]);
    expect(() => registry.getBytes(font.id)).toThrowError(/not registered/i);
  });
});
