import { describe, expect, test } from 'vitest';

import {
  IDENTITY,
  invert,
  multiply,
  transformPoint,
  type Matrix,
} from '../../src/geometry/matrix';

describe('affine matrices', () => {
  test('multiplies in application order from right to left', () => {
    const translate: Matrix = [1, 0, 0, 1, 10, 20];
    const scale: Matrix = [2, 0, 0, 3, 0, 0];

    expect(transformPoint(multiply(translate, scale), 4, 5)).toEqual([18, 35]);
    expect(transformPoint(multiply(IDENTITY, scale), 4, 5)).toEqual([8, 15]);
  });

  test('round-trips through an invertible matrix', () => {
    const matrix: Matrix = [1.25, -0.5, 0.75, 2, 31, -17];
    const transformed = transformPoint(matrix, -8.5, 14.25);
    const restored = transformPoint(invert(matrix), ...transformed);

    expect(restored[0]).toBeCloseTo(-8.5, 12);
    expect(restored[1]).toBeCloseTo(14.25, 12);
  });

  test.each([
    ['singular', [1, 2, 2, 4, 0, 0]],
    ['non-finite', [1, 0, 0, 1, Number.POSITIVE_INFINITY, 0]],
  ] as const)('rejects a %s matrix as an ambiguous transform', (_name, matrix) => {
    expect(() => invert(matrix as Matrix)).toThrow(
      expect.objectContaining({ reason: 'ambiguousTransform' }),
    );
  });

  test('rejects non-finite input during multiplication and point transforms', () => {
    expect(() => multiply(IDENTITY, [1, 0, 0, 1, Number.NaN, 0])).toThrow(
      expect.objectContaining({ reason: 'ambiguousTransform' }),
    );
    expect(() => transformPoint(IDENTITY, Number.NaN, 0)).toThrow(
      expect.objectContaining({ reason: 'ambiguousTransform' }),
    );
  });

  test('rejects singular input during multiplication and point transforms', () => {
    const singular: Matrix = [1, 2, 2, 4, 0, 0];
    expect(() => multiply(IDENTITY, singular)).toThrow(
      expect.objectContaining({ reason: 'ambiguousTransform' }),
    );
    expect(() => transformPoint(singular, 1, 1)).toThrow(
      expect.objectContaining({ reason: 'ambiguousTransform' }),
    );
  });

  test('composes text, CTM, and two nested Form matrices explicitly', () => {
    const textMatrix: Matrix = [12, 0, 0, 12, 4, 6];
    const ctm: Matrix = [1, 0.2, 0.1, 1, 72, 90];
    const outerForm: Matrix = [0, 1, -1, 0, 200, 20];
    const innerForm: Matrix = [0.5, 0, 0, 0.5, 8, 10];
    const composed = multiply(
      outerForm,
      multiply(innerForm, multiply(ctm, textMatrix)),
    );
    const point = transformPoint(composed, 0.25, 0.75);
    const roundTrip = transformPoint(invert(composed), ...point);

    expect(roundTrip[0]).toBeCloseTo(0.25, 12);
    expect(roundTrip[1]).toBeCloseTo(0.75, 12);
  });
});
