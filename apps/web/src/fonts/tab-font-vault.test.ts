import type { FontDescriptor } from '@pdf-editor/pdf-engine';
import { describe, expect, it, vi } from 'vitest';

import {
  TabFontVault,
  type FontRegistrationClient,
} from './tab-font-vault';

const INSPECTION = {
  sourceFormat: 'truetype',
  outlineFormat: 'truetype',
  postscriptName: 'Example-Regular',
  fullName: 'Example Regular',
  familyName: 'Example',
  subfamilyName: 'Regular',
  version: 'Version 1',
  unitsPerEm: 1000,
  ascent: 800,
  descent: -200,
  lineGap: 0,
  capHeight: 700,
  xHeight: 500,
  underlinePosition: null,
  underlineThickness: null,
  strikeoutPosition: null,
  strikeoutThickness: null,
  italicAngle: 0,
  weight: 400,
  width: 5,
  italic: false,
  numGlyphs: 10,
  codePoints: [65],
  metricsFingerprint: 'metrics',
  embedding: {
    usage: 'installable',
    documentEditingAllowed: true,
    subsettingAllowed: true,
    bitmapOnly: false,
  },
} as const satisfies FontDescriptor['inspection'];

function registrationClient(
  received: Uint8Array[],
  hash = 'font-hash',
): FontRegistrationClient {
  return {
    registerFont: vi.fn(async (source, fileName, bytes) => {
      received.push(bytes.slice());
      bytes.fill(255);
      return Object.freeze({
        id: `font:${hash}`,
        hash,
        source,
        fileName,
        byteLength: received.at(-1)!.byteLength,
        inspection: INSPECTION,
      });
    }),
  };
}

describe('TabFontVault', () => {
  it('owns registered bytes and replays copies into replacement workers', async () => {
    const vault = new TabFontVault();
    const firstBytes: Uint8Array[] = [];
    const first = registrationClient(firstBytes);
    const source = Uint8Array.of(1, 2, 3);

    const descriptor = await vault.register({
      source: 'upload',
      fileName: 'example.ttf',
      bytes: source,
    }, first);
    source[0] = 9;
    expect(descriptor.hash).toBe('font-hash');
    expect(vault.list()).toEqual([descriptor]);
    expect(firstBytes).toEqual([Uint8Array.of(1, 2, 3)]);

    const replayBytes: Uint8Array[] = [];
    await vault.registerAllWith(registrationClient(replayBytes));
    expect(replayBytes).toEqual([Uint8Array.of(1, 2, 3)]);
    expect(vault.list()).toEqual([descriptor]);
  });

  it('deduplicates accepted font hashes and clears the tab catalogue explicitly', async () => {
    const vault = new TabFontVault();
    const client = registrationClient([]);
    await vault.register({
      source: 'local',
      fileName: 'Example Regular',
      bytes: Uint8Array.of(1),
    }, client);
    await vault.register({
      source: 'upload',
      fileName: 'same.ttf',
      bytes: Uint8Array.of(1),
    }, client);

    expect(vault.list()).toHaveLength(1);
    vault.dispose();
    expect(vault.list()).toEqual([]);
    const replay = registrationClient([]);
    await vault.registerAllWith(replay);
    expect(replay.registerFont).not.toHaveBeenCalled();
  });

  it('does not write font data to browser storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const vault = new TabFontVault();
    await vault.register({
      source: 'upload',
      fileName: 'private.ttf',
      bytes: Uint8Array.of(7, 8),
    }, registrationClient([]));

    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});
