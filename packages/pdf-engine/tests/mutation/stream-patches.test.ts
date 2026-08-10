import { describe, expect, test } from 'vitest';

import {
  applyStreamPatches,
  StreamPatchError,
} from '../../src/mutation/stream-patches';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('applyStreamPatches', () => {
  test('applies sorted non-overlapping patches once against the original byte offsets', () => {
    const original = encoder.encode('abcdef');

    const result = applyStreamPatches(original, [
      { startOffset: 4, endOffset: 6, bytes: encoder.encode('Y') },
      { startOffset: 1, endOffset: 3, bytes: encoder.encode('X') },
    ]);

    expect(decoder.decode(result)).toBe('aXdY');
    expect(decoder.decode(original)).toBe('abcdef');
  });

  test.each([
    ['overlap', [
      { startOffset: 1, endOffset: 4, bytes: new Uint8Array() },
      { startOffset: 3, endOffset: 5, bytes: new Uint8Array() },
    ]],
    ['negative start', [
      { startOffset: -1, endOffset: 2, bytes: new Uint8Array() },
    ]],
    ['reversed range', [
      { startOffset: 3, endOffset: 2, bytes: new Uint8Array() },
    ]],
    ['past end', [
      { startOffset: 2, endOffset: 7, bytes: new Uint8Array() },
    ]],
  ] as const)('rejects %s rather than applying ambiguous offsets', (_name, patches) => {
    expect(() => applyStreamPatches(encoder.encode('abcdef'), patches))
      .toThrow(StreamPatchError);
  });
});
