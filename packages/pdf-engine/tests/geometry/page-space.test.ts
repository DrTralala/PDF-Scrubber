import { describe, expect, test } from 'vitest';

import {
  canonicalPageSize,
  canonicalToPdf,
  canonicalToViewport,
  pdfToCanonical,
  type PageSpace,
} from '../../src/geometry/page-space';
import { transformPoint } from '../../src/geometry/matrix';

const POINTS = [
  [40, 50],
  [125.25, 311.75],
  [572, 742],
] as const;

function expectRoundTrip(page: PageSpace): void {
  for (const [x, y] of POINTS) {
    const canonical = transformPoint(pdfToCanonical(page), x, y);
    const restored = transformPoint(canonicalToPdf(page), ...canonical);
    expect(Math.abs(restored[0] - x)).toBeLessThan(1e-7);
    expect(Math.abs(restored[1] - y)).toBeLessThan(1e-7);

    const canonicalAgain = transformPoint(
      pdfToCanonical(page),
      ...transformPoint(canonicalToPdf(page), ...canonical),
    );
    expect(Math.abs(canonicalAgain[0] - canonical[0])).toBeLessThan(1e-7);
    expect(Math.abs(canonicalAgain[1] - canonical[1])).toBeLessThan(1e-7);
  }
}

describe('canonical page space', () => {
  test.each([0, 90, 180, 270] as const)(
    'round-trips PDF points at rotation %i',
    (rotate) => {
      expectRoundTrip({
        mediaBox: [20, 30, 612, 792],
        cropBox: [40, 50, 572, 742],
        rotate,
        userUnit: 1,
      });
    },
  );

  test('accounts for UserUnit 2 and swaps dimensions after quarter-turns', () => {
    const page: PageSpace = {
      mediaBox: [20, 30, 612, 792],
      cropBox: [40, 50, 572, 742],
      rotate: 90,
      userUnit: 2,
    };

    expect(canonicalPageSize(page)).toEqual([1384, 1064]);
    expect(transformPoint(pdfToCanonical(page), 40, 50)).toEqual([0, 1064]);
    expect(transformPoint(pdfToCanonical(page), 572, 742)).toEqual([1384, 0]);
    expectRoundTrip(page);
  });

  test('uses the MediaBox and CropBox intersection as the visible page', () => {
    const page: PageSpace = {
      mediaBox: [20, 30, 612, 792],
      cropBox: [0, 50, 572, 900],
      rotate: 0,
      userUnit: 1,
    };

    expect(canonicalPageSize(page)).toEqual([552, 742]);
    expect(transformPoint(pdfToCanonical(page), 20, 30)).toEqual([0, -20]);
    expect(transformPoint(pdfToCanonical(page), 20, 50)).toEqual([0, 0]);
  });

  test.each([
    ['invalid rotation', { mediaBox: [0, 0, 10, 10], rotate: 45, userUnit: 1 }],
    ['zero user unit', { mediaBox: [0, 0, 10, 10], rotate: 0, userUnit: 0 }],
    ['inverted box', { mediaBox: [0, 10, 10, 0], rotate: 0, userUnit: 1 }],
    [
      'disjoint crop',
      {
        mediaBox: [0, 0, 10, 10],
        cropBox: [20, 20, 30, 30],
        rotate: 0,
        userUnit: 1,
      },
    ],
  ] as const)('rejects %s as an ambiguous transform', (_name, page) => {
    expect(() => pdfToCanonical(page as PageSpace)).toThrow(
      expect.objectContaining({ reason: 'ambiguousTransform' }),
    );
  });

  test('converts canonical y-up coordinates to a PDF.js-style viewport', () => {
    const page: PageSpace = {
      mediaBox: [20, 30, 612, 792],
      cropBox: [40, 50, 572, 742],
      rotate: 90,
      userUnit: 2,
    };
    const toViewport = canonicalToViewport(page, 1.5, 7, 11);
    const fromPdf = pdfToCanonical(page);

    expect(transformPoint(toViewport, 0, 0)).toEqual([7, 1607]);
    expect(transformPoint(toViewport, 1384, 1064)).toEqual([2083, 11]);
    expect(transformPoint(toViewport, ...transformPoint(fromPdf, 40, 50))).toEqual([
      7,
      11,
    ]);
  });
});
