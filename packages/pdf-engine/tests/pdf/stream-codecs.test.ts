import { PDFContext, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { decodeStreamBytes } from '../../src/pdf/stream-codecs';

describe('decodeStreamBytes', () => {
  it('copies bytes from an unfiltered stream', async () => {
    const stream = PDFContext.create().stream('plain content');

    expect(new TextDecoder().decode(await decodeStreamBytes(stream, 1024))).toBe(
      'plain content',
    );
  });

  it('decodes the single FlateDecode form emitted by the corpus builder', async () => {
    const stream = PDFContext.create().flateStream('compressed content');

    expect(new TextDecoder().decode(await decodeStreamBytes(stream, 1024))).toBe(
      'compressed content',
    );
  });

  it('decodes a singleton FlateDecode filter array', async () => {
    const context = PDFContext.create();
    const stream = context.flateStream('compressed content');
    stream.dict.set(
      PDFName.of('Filter'),
      context.obj([PDFName.of('FlateDecode')]),
    );

    expect(new TextDecoder().decode(await decodeStreamBytes(stream, 1024))).toBe(
      'compressed content',
    );
  });

  it('rejects unsupported filter chains', async () => {
    const context = PDFContext.create();
    const stream = context.stream('unsupported', { Filter: 'ASCIIHexDecode' });

    await expect(decodeStreamBytes(stream, 1024)).rejects.toMatchObject({
      code: 'UNSUPPORTED_DOCUMENT',
    });
  });

  it('rejects output beyond the limit while decoding', async () => {
    const stream = PDFContext.create().flateStream('A'.repeat(4096));

    await expect(decodeStreamBytes(stream, 100)).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
      details: {
        resource: 'decodedStreamBytes',
        limit: 100,
        observedBytes: expect.any(Number),
      },
    });
  });
});
