import { describe, expect, test } from 'vitest';

import type { CanonicalBounds } from '@pdf-editor/pdf-engine';

import { autoFitRichWidth } from './rich-auto-fit';

const allowedRegion: CanonicalBounds = Object.freeze({
  x: 10,
  y: 20,
  width: 40,
  height: 12,
});

function input(overrides: Partial<Parameters<typeof autoFitRichWidth>[0]> = {}) {
  return {
    requiredBounds: { x: 10, y: 20, width: 60, height: 12 },
    allowedRegion,
    maxAllowedWidth: 100,
    autoFitEligible: true,
    ...overrides,
  } as const;
}

describe('automatic rich replacement fitting', () => {
  test('returns the measured width for safe horizontal width-only overflow', () => {
    expect(autoFitRichWidth(input())).toBe(60);
  });

  test('measures the required width from the allowed left edge to the measured right edge', () => {
    expect(autoFitRichWidth(input({
      requiredBounds: { x: 12, y: 20, width: 72, height: 12 },
      allowedRegion: { ...allowedRegion, width: 60 },
      maxAllowedWidth: 80,
    }))).toBe(74);
  });

  test.each([
    ['beyond the safe maximum', { maxAllowedWidth: 50 }],
    ['four points beyond the safe maximum', {
      requiredBounds: { x: 12, y: 20, width: 72, height: 12 },
      allowedRegion: { ...allowedRegion, width: 60 },
      maxAllowedWidth: 70,
    }],
    ['rotated or sheared', { autoFitEligible: false }],
    ['height overflow', { requiredBounds: { x: 10, y: 20, width: 60, height: 13 } }],
    ['left overflow', { requiredBounds: { x: 9, y: 20, width: 60, height: 12 } }],
    ['vertical overflow', { requiredBounds: { x: 10, y: 19, width: 60, height: 12 } }],
    ['already fitting', { requiredBounds: { x: 10, y: 20, width: 40, height: 12 } }],
  ])('returns null for %s', (_label, overrides) => {
    expect(autoFitRichWidth(input(overrides))).toBeNull();
  });
});
