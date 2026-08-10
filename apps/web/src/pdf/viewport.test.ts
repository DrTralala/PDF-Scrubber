import { describe, expect, it } from 'vitest';

import { fitScale, toViewportRect } from './viewport';

describe('canonical overlay geometry', () => {
  it('maps y-up canonical bounds into a CSS y-down viewport', () => {
    expect(toViewportRect(
      { x: 10, y: 20, width: 30, height: 10 },
      { mediaBox: [0, 0, 100, 200], rotate: 0, userUnit: 1 },
      { width: 200, height: 400 },
    )).toEqual({ left: 20, top: 340, width: 60, height: 20 });
  });

  it('uses engine page space for a rotated non-zero crop', () => {
    const result = toViewportRect(
      { x: 25, y: 50, width: 100, height: 20 },
      {
        mediaBox: [20, 30, 612, 792],
        cropBox: [40, 50, 572, 742],
        rotate: 90,
        userUnit: 2,
      },
      { width: 692, height: 532 },
    );

    expect(result).toEqual({ left: 12.5, top: 497, width: 50, height: 10 });
  });

  it('rejects non-uniform display scaling', () => {
    expect(() => toViewportRect(
      { x: 0, y: 0, width: 1, height: 1 },
      { mediaBox: [0, 0, 100, 100], rotate: 0, userUnit: 1 },
      { width: 100, height: 120 },
    )).toThrow(/uniform/);
  });

  it('fits a page or its width without scaling controls out of view', () => {
    const page = { width: 600, height: 800 };
    const available = { width: 500, height: 500 };

    expect(fitScale(page, available, 'page')).toBe(0.625);
    expect(fitScale(page, available, 'width')).toBeCloseTo(5 / 6);
  });

  it('rejects invalid page and available dimensions', () => {
    expect(() => fitScale(
      { width: 0, height: 800 },
      { width: 500, height: 500 },
      'page',
    )).toThrow(/positive/);
    expect(() => fitScale(
      { width: 600, height: 800 },
      { width: Number.NaN, height: 500 },
      'width',
    )).toThrow(/finite/);
  });
});
