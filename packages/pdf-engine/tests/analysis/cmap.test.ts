import { describe, expect, test } from 'vitest';

import { parseToUnicodeCMap } from '../../src/analysis/cmap';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function hex(source: string): Uint8Array {
  return Uint8Array.from(
    source.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

describe('parseToUnicodeCMap', () => {
  test('decodes bfchar plus sequential and array bfrange mappings', () => {
    const cmap = parseToUnicodeCMap(bytes(`
      1 begincodespacerange
      <00> <FF>
      endcodespacerange
      1 beginbfchar
      <20> <0020>
      endbfchar
      2 beginbfrange
      <01> <03> [<0043> <0075> <0073>]
      <10> <12> <0041>
      endbfrange
    `));

    expect(cmap.decode(hex('01'))).toBe('C');
    expect(cmap.decode(hex('02'))).toBe('u');
    expect(cmap.decode(hex('03'))).toBe('s');
    expect(cmap.decode(hex('10'))).toBe('A');
    expect(cmap.decode(hex('11'))).toBe('B');
    expect(cmap.decode(hex('12'))).toBe('C');
    expect(cmap.decode(hex('20'))).toBe(' ');
    expect(cmap.codeLengths).toEqual([1]);
  });

  test('decodes multibyte source codes and UTF-16 surrogate pairs', () => {
    const cmap = parseToUnicodeCMap(bytes(`
      1 begincodespacerange
      <0000> <FFFF>
      endcodespacerange
      1 beginbfchar
      <0102> <D83DDE00>
      endbfchar
    `));

    expect(cmap.decode(hex('0102'))).toBe('😀');
    expect(cmap.decode(hex('02'))).toBeNull();
    expect(cmap.codeLengths).toEqual([2]);
  });

  test('rejects source codes wider than the supported four bytes', () => {
    expect(() => parseToUnicodeCMap(bytes(`
      1 begincodespacerange
      <0000000000> <FFFFFFFFFF>
      endcodespacerange
    `))).toThrow('source code must contain between one and four bytes');
  });
});
