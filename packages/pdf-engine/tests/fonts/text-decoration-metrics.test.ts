import { describe, expect, test } from 'vitest';

import type { FontInspection } from '../../src/fonts/font-inspection';
import { resolveTextDecorationMetrics } from '../../src/fonts/text-decoration-metrics';

function inspection(
  overrides: Partial<Pick<
    FontInspection,
    | 'unitsPerEm'
    | 'underlinePosition'
    | 'underlineThickness'
    | 'strikeoutPosition'
    | 'strikeoutThickness'
  >> = {},
): Pick<
  FontInspection,
  | 'unitsPerEm'
  | 'underlinePosition'
  | 'underlineThickness'
  | 'strikeoutPosition'
  | 'strikeoutThickness'
> {
  return {
    unitsPerEm: 1000,
    underlinePosition: null,
    underlineThickness: null,
    strikeoutPosition: null,
    strikeoutThickness: null,
    ...overrides,
  };
}

describe('resolveTextDecorationMetrics', () => {
  test('normalises valid OpenType metrics to em units', () => {
    expect(resolveTextDecorationMetrics(inspection({
      unitsPerEm: 2048,
      underlinePosition: -130,
      underlineThickness: 90,
      strikeoutPosition: 530,
      strikeoutThickness: 102,
    }))).toEqual({
      underlinePositionEm: -130 / 2048,
      underlineThicknessEm: 90 / 2048,
      strikeoutPositionEm: 530 / 2048,
      strikeoutThicknessEm: 102 / 2048,
    });
  });

  test('uses bounded font-relative defaults when metrics are unavailable or invalid', () => {
    expect(resolveTextDecorationMetrics(inspection())).toEqual({
      underlinePositionEm: -0.1,
      underlineThicknessEm: 0.05,
      strikeoutPositionEm: 0.3,
      strikeoutThicknessEm: 0.05,
    });
    expect(resolveTextDecorationMetrics(inspection({
      underlinePosition: 50,
      underlineThickness: -10,
      strikeoutPosition: -20,
      strikeoutThickness: 500,
    }))).toEqual({
      underlinePositionEm: -0.1,
      underlineThicknessEm: 0.05,
      strikeoutPositionEm: 0.3,
      strikeoutThicknessEm: 0.12,
    });
  });

  test('clamps extreme valid positions and thicknesses', () => {
    expect(resolveTextDecorationMetrics(inspection({
      underlinePosition: -900,
      underlineThickness: 1,
      strikeoutPosition: 900,
      strikeoutThickness: 1,
    }))).toEqual({
      underlinePositionEm: -0.35,
      underlineThicknessEm: 0.025,
      strikeoutPositionEm: 0.6,
      strikeoutThicknessEm: 0.025,
    });
  });
});
