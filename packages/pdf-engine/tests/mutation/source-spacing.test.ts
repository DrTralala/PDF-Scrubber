import { describe, expect, test } from 'vitest';

import type {
  AnalysedStyleRun,
  AnalysedTextLine,
  EffectiveTextStyle,
} from '../../src/model';
import type { ShapedRun } from '../../src/fonts/harfbuzz-shaper';
import {
  shapedRunAdvance,
  sourceRunAdvanceProfile,
  sourceRunExtent,
  sourceSpacingScale,
} from '../../src/mutation/source-spacing';

const style: EffectiveTextStyle = Object.freeze({
  fontResourceName: 'F1',
  fontBaseName: 'Source',
  fontSize: 10,
  horizontalScaling: 1,
  characterSpacing: 1,
  wordSpacing: 2,
  rise: 0,
  renderingMode: 0,
  fillColour: Object.freeze({ colourSpace: 'DeviceGray', components: Object.freeze([0]) }),
  strokeColour: Object.freeze({ colourSpace: 'DeviceGray', components: Object.freeze([0]) }),
  fontWeight: 400,
  italicAngle: 0,
});

const styleRun: AnalysedStyleRun = Object.freeze({
  glyphRange: Object.freeze({ start: 0, end: 2 }),
  text: 'A B',
  styleKey: 'source',
  style,
  decorations: Object.freeze({ underline: false, strikethrough: false }),
});

function line(baselineDirection: readonly [number, number]): AnalysedTextLine {
  return {
    key: 'line',
    pageIndex: 0,
    glyphs: [
      { bounds: { x: 10, y: 20, width: 5, height: 2 } },
      { bounds: { x: 18, y: 24, width: 3, height: 4 } },
    ],
    groups: [],
    bounds: { x: 10, y: 20, width: 11, height: 8 },
    baselineDirection,
    sourceDecorations: [],
    decorationWarnings: [],
    capability: { kind: 'safeReplacement', reasons: ['supportedExistingFont'] },
  } as unknown as AnalysedTextLine;
}

const shaped: ShapedRun = Object.freeze({
  direction: 'ltr',
  unitsPerEm: 1000,
  glyphs: Object.freeze([
    Object.freeze({ glyphId: 1, cluster: 0, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 }),
    Object.freeze({ glyphId: 2, cluster: 1, xAdvance: 600, yAdvance: 0, xOffset: 0, yOffset: 0 }),
    Object.freeze({ glyphId: 3, cluster: 2, xAdvance: 700, yAdvance: 0, xOffset: 0, yOffset: 0 }),
  ]),
});

describe('source spacing helpers', () => {
  test('calculates a finite source-spacing scale', () => {
    expect(sourceSpacingScale({
      sourceExtent: 24,
      baselineScale: 2,
      shapedAdvance: 6,
    })).toBeCloseTo(2);
    expect(sourceSpacingScale({
      sourceExtent: 0,
      baselineScale: 2,
      shapedAdvance: 6,
    })).toBe(1);
    expect(sourceSpacingScale({
      sourceExtent: 24,
      baselineScale: 0,
      shapedAdvance: 6,
    })).toBe(1);
  });

  test('projects source glyph bounds along horizontal and rotated baselines', () => {
    expect(sourceRunExtent(line([1, 0]), styleRun)).toBeCloseTo(11);
    expect(sourceRunExtent(line([0, 1]), styleRun)).toBeCloseTo(8);
  });

  test('returns source glyph advances in redraw coordinates', () => {
    expect(sourceRunAdvanceProfile(line([1, 0]), styleRun, 2)).toEqual([4, 1.5]);
  });

  test('rejects a source profile when shaping does not preserve glyph count', () => {
    expect(sourceRunAdvanceProfile(line([1, 0]), styleRun, 2, 1)).toBeNull();
  });

  test('measures shaped glyph advances with source text spacing', () => {
    expect(shapedRunAdvance('A B', shaped, style)).toBeCloseTo(23);
  });
});
