import { describe, expect, it } from 'vitest';

import {
  ENGINE_ERROR_CODES,
  MAX_PDF_FILE_BYTES,
  MAX_PDF_FILE_MIB,
  PROVISIONAL_LIMITS,
  fingerprint,
  spanAddressKey,
  type SpanAddress,
} from '../src/index';

describe('stable engine contracts', () => {
  it('keeps geometry out of stable span identity', () => {
    const address: SpanAddress = {
      pageRef: { objectNumber: 4, generationNumber: 0 },
      streamPath: [
        {
          kind: 'pageContents',
          ref: { objectNumber: 8, generationNumber: 0 },
          resourceName: null,
        },
      ],
      operatorRange: { start: 2, end: 3 },
      glyphRange: { start: 0, end: 5 },
    };
    const first = {
      address,
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    };
    const second = {
      address,
      bounds: { x: 40, y: 40, width: 10, height: 10 },
    };

    expect(spanAddressKey(first.address)).toBe(spanAddressKey(second.address));
    expect(spanAddressKey(address)).toBe(
      '4:0|pageContents:8:0:-|2:3|0:5',
    );
  });

  it('fingerprints the complete byte array as lowercase SHA-256', async () => {
    const bytes = new TextEncoder().encode('abc');

    await expect(fingerprint(bytes)).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('publishes the exact engine error codes and measured browser limits', () => {
    expect(ENGINE_ERROR_CODES).toEqual([
      'UNSUPPORTED_DOCUMENT',
      'MALFORMED_INPUT',
      'RESOURCE_LIMIT',
      'READ_ONLY_SPAN',
      'FONT_UNAVAILABLE',
      'FONT_EMBEDDING_PROHIBITED',
      'REPLACEMENT_OVERFLOW',
      'STALE_REVISION',
      'VALIDATION_FAILURE',
      'INTERNAL_FAILURE',
    ]);
    expect(MAX_PDF_FILE_MIB).toBe(15);
    expect(MAX_PDF_FILE_BYTES).toBe(15_728_640);
    expect(PROVISIONAL_LIMITS).toEqual({
      maxFileBytes: 15_728_640,
      maxObjects: 2_000,
      maxNestingDepth: 12,
      maxDecodedStreamBytes: 4 * 1024 * 1024,
      maxOperationsPerStream: 50_000,
      maxImagePixels: 12_000_000,
      maxProcessingMs: 30_000,
    });
    expect(Object.isFrozen(PROVISIONAL_LIMITS)).toBe(true);
  });
});
