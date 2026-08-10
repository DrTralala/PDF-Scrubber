import { describe, expect, test } from 'vitest';

import { parseDecorationGraphics } from '../../src/analysis/decoration-graphics';
import { tokeniseContentStream } from '../../src/content/tokeniser';
import { IDENTITY } from '../../src/geometry/matrix';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import type { StreamPathSegment } from '../../src/model';

const encoder = new TextEncoder();
const pageRef = Object.freeze({ objectNumber: 1, generationNumber: 0 });
const streamPath: readonly StreamPathSegment[] = Object.freeze([Object.freeze({
  kind: 'pageContents' as const,
  ref: Object.freeze({ objectNumber: 2, generationNumber: 0 }),
  resourceName: null,
})]);

function parse(content: string, referenceCount = 1) {
  return parseDecorationGraphics(tokeniseContentStream(
    encoder.encode(content),
    PROVISIONAL_LIMITS,
  ), {
    pageRef,
    streamPath,
    referenceCount,
    pageMatrix: IDENTITY,
    initialCtm: IDENTITY,
  });
}

describe('parseDecorationGraphics', () => {
  test('recognises one self-contained solid stroked line with a stable source range', () => {
    const graphics = parse('q\n0 G\n1 w\n10 -2 m\n110 -2 l\nS\nQ');

    expect(graphics).toEqual([{
      address: {
        pageRef,
        streamPath,
        operatorRange: { start: 0, end: 7 },
      },
      referenceCount: 1,
      paint: 'stroke',
      axis: [[10, -2], [110, -2]],
      quad: [[10, -2.5], [110, -2.5], [110, -1.5], [10, -1.5]],
      bounds: { x: 10, y: -2.5, width: 100, height: 1 },
      thickness: 1,
      colour: { colourSpace: 'DeviceGray', components: [0] },
    }]);
  });

  test.each(['f', 'f*'])('recognises one thin filled rectangle painted with %s', (paint) => {
    const graphics = parse(`q\n0.1 0.2 0.3 rg\n10 4 100 2 re\n${paint}\nQ`);

    expect(graphics).toHaveLength(1);
    expect(graphics[0]).toMatchObject({
      paint: 'fill',
      axis: [[10, 5], [110, 5]],
      quad: [[10, 4], [110, 4], [110, 6], [10, 6]],
      thickness: 2,
      colour: { colourSpace: 'DeviceRGB', components: [0.1, 0.2, 0.3] },
    });
  });

  test.each([
    ['dashed', 'q\n0 G\n1 w\n[3 2] 0 d\n10 -2 m\n110 -2 l\nS\nQ'],
    ['compound', 'q\n0 G\n1 w\n10 -2 m\n110 -2 l\n10 -5 m\n110 -5 l\nS\nQ'],
    ['stroked rectangle', 'q\n0 G\n1 w\n10 -2 100 2 re\nS\nQ'],
    ['custom curve', 'q\n0 G\n1 w\n10 -2 m\n30 2 80 -6 110 -2 c\nS\nQ'],
  ])('rejects %s graphics rather than producing mutable evidence', (_name, content) => {
    expect(parse(content)).toEqual([]);
  });

  test('rejects singular or non-finite effective transforms', () => {
    expect(parse('q\n1 0 0 0 0 0 cm\n0 G\n1 w\n10 -2 m\n110 -2 l\nS\nQ')).toEqual([]);
  });

  test('retains the source stream reference count for later shared-content rejection', () => {
    expect(parse('q\n0 G\n1 w\n10 -2 m\n110 -2 l\nS\nQ', 2)[0])
      .toMatchObject({ referenceCount: 2 });
  });
});
