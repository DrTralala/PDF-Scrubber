import { describe, expect, test } from 'vitest';

import {
  matchDecorationGraphics,
  type DecorationTextOwner,
} from '../../src/layout/match-decorations';
import type { SourceDecorationGraphic } from '../../src/model';

const pageRef = Object.freeze({ objectNumber: 1, generationNumber: 0 });
const streamPath = Object.freeze([Object.freeze({
  kind: 'pageContents' as const,
  ref: Object.freeze({ objectNumber: 2, generationNumber: 0 }),
  resourceName: null,
})]);
const black = Object.freeze({
  colourSpace: 'DeviceGray' as const,
  components: Object.freeze([0]),
});

function owner(overrides: Partial<DecorationTextOwner> = {}): DecorationTextOwner {
  const baseline: DecorationTextOwner['baseline'] = Object.freeze([
    Object.freeze([0, 0] as const),
    Object.freeze([100, 0] as const),
  ]);
  return Object.freeze({
    lineKey: 'line-1',
    glyphRange: Object.freeze({ start: 0, end: 10 }),
    baseline,
    em: 20,
    colour: black,
    ...overrides,
  });
}

function graphic(
  start: readonly [number, number],
  end: readonly [number, number],
  overrides: Partial<SourceDecorationGraphic> = {},
): SourceDecorationGraphic {
  const half = 0.5;
  const axis: SourceDecorationGraphic['axis'] = Object.freeze([start, end]);
  const quad: SourceDecorationGraphic['quad'] = Object.freeze([
    Object.freeze([start[0], start[1] - half] as const),
    Object.freeze([end[0], end[1] - half] as const),
    Object.freeze([end[0], end[1] + half] as const),
    Object.freeze([start[0], start[1] + half] as const),
  ]);
  return Object.freeze({
    address: Object.freeze({
      pageRef,
      streamPath,
      operatorRange: Object.freeze({ start: 0, end: 7 }),
    }),
    referenceCount: 1,
    paint: 'stroke',
    axis,
    quad,
    bounds: Object.freeze({
      x: Math.min(start[0], end[0]),
      y: Math.min(start[1], end[1]) - half,
      width: Math.abs(end[0] - start[0]),
      height: Math.abs(end[1] - start[1]) + 1,
    }),
    thickness: 1,
    colour: black,
    ...overrides,
  });
}

describe('matchDecorationGraphics', () => {
  test.each([
    [-2, 'underline'],
    [6, 'strikethrough'],
  ] as const)('matches a uniquely owned line in the %s-point band as %s', (y, kind) => {
    const candidate = graphic([0, y], [100, y]);

    expect(matchDecorationGraphics([candidate], [owner()])).toEqual({
      decorations: [{
        kind,
        graphic: candidate,
        lineKey: 'line-1',
        glyphRange: { start: 0, end: 10 },
      }],
      warnings: [],
    });
  });

  test('accepts the inclusive parallel, overlap, extension, thickness and colour tolerances', () => {
    const candidate = graphic([-3, -2], [103, -2 + Math.tan(Math.PI / 180) * 106], {
      thickness: 4,
      colour: Object.freeze({ colourSpace: 'DeviceGray', components: Object.freeze([0.02]) }),
    });

    expect(matchDecorationGraphics([candidate], [owner()]).decorations)
      .toMatchObject([{ kind: 'underline' }]);
  });

  test.each([
    ['angle', graphic([0, -2], [100, -2 + Math.tan(1.01 * Math.PI / 180) * 100])],
    ['overlap', graphic([0, -2], [89.9, -2])],
    ['extension', graphic([-3.01, -2], [100, -2])],
    ['thin', graphic([0, -2], [100, -2], { thickness: 0.39 })],
    ['thick', graphic([0, -2], [100, -2], { thickness: 4.01 })],
    ['colour', graphic([0, -2], [100, -2], {
      colour: Object.freeze({ colourSpace: 'DeviceGray', components: Object.freeze([0.021]) }),
    })],
    ['underline band', graphic([0, -7.01], [100, -7.01])],
    ['strike band', graphic([0, 13.01], [100, 13.01])],
  ])('preserves a candidate outside the %s threshold as ambiguous', (_name, candidate) => {
    const result = matchDecorationGraphics([candidate], [owner()]);

    expect(result.decorations).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({ reason: 'ambiguous-geometry' })]);
  });

  test('requires exactly one owner rather than treating a line across two fields as decoration', () => {
    const candidate = graphic([0, -2], [100, -2]);
    const result = matchDecorationGraphics([candidate], [
      owner({ glyphRange: Object.freeze({ start: 0, end: 4 }), baseline: [[0, 0], [45, 0]] as const }),
      owner({ glyphRange: Object.freeze({ start: 5, end: 10 }), baseline: [[55, 0], [100, 0]] as const }),
    ]);

    expect(result.decorations).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({
      reason: 'multiple-owners',
      lineKey: 'line-1',
      glyphRanges: [{ start: 0, end: 4 }, { start: 5, end: 10 }],
    })]);
  });

  test('never matches a candidate from shared content', () => {
    const candidate = graphic([0, -2], [100, -2], { referenceCount: 2 });
    const result = matchDecorationGraphics([candidate], [owner()]);

    expect(result.decorations).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({
      reason: 'shared-content',
      lineKey: 'line-1',
    })]);
  });

  test('does not classify a distant page separator as text decoration', () => {
    const result = matchDecorationGraphics([graphic([-30, -50], [500, -50])], [owner()]);

    expect(result.decorations).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({
      reason: 'ambiguous-geometry',
      lineKey: null,
      glyphRanges: [],
    })]);
  });
});
