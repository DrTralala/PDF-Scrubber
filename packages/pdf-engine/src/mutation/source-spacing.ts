import type { ShapedRun } from '../fonts/harfbuzz-shaper';
import type {
  AnalysedStyleRun,
  AnalysedTextLine,
  EffectiveTextStyle,
} from '../model';

type SourceLineGeometry = Pick<AnalysedTextLine, 'baselineDirection' | 'glyphs'>;
type SourceStyleRun = Pick<AnalysedStyleRun, 'glyphRange'>;

function normalisedDirection(
  direction: readonly [number, number],
): readonly [number, number] | null {
  const magnitude = Math.hypot(direction[0], direction[1]);
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return null;
  return [direction[0] / magnitude, direction[1] / magnitude];
}

function projectedBounds(
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>,
  direction: readonly [number, number],
): readonly [number, number] {
  const points: readonly (readonly [number, number])[] = [
    [bounds.x, bounds.y],
    [bounds.x + bounds.width, bounds.y],
    [bounds.x, bounds.y + bounds.height],
    [bounds.x + bounds.width, bounds.y + bounds.height],
  ];
  const projected = points.map(([x, y]) => x * direction[0] + y * direction[1]);
  return [Math.min(...projected), Math.max(...projected)];
}

export function sourceRunExtent(
  line: SourceLineGeometry,
  sourceRun: SourceStyleRun,
): number {
  const direction = normalisedDirection(line.baselineDirection);
  if (direction === null) return 0;
  const glyphs = line.glyphs.slice(sourceRun.glyphRange.start, sourceRun.glyphRange.end);
  if (glyphs.length === 0) return 0;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const glyph of glyphs) {
    const [glyphStart, glyphEnd] = projectedBounds(glyph.bounds, direction);
    start = Math.min(start, glyphStart);
    end = Math.max(end, glyphEnd);
  }
  const extent = end - start;
  return Number.isFinite(extent) && extent > 0 ? extent : 0;
}

export function sourceRunAdvanceProfile(
  line: SourceLineGeometry,
  sourceRun: SourceStyleRun,
  baselineScale: number,
  shapedGlyphCount?: number,
): readonly number[] | null {
  const direction = normalisedDirection(line.baselineDirection);
  if (direction === null || !(baselineScale > 0) || !Number.isFinite(baselineScale)) return null;
  const glyphs = line.glyphs.slice(sourceRun.glyphRange.start, sourceRun.glyphRange.end);
  if (glyphs.length === 0) return null;
  if (shapedGlyphCount !== undefined && glyphs.length !== shapedGlyphCount) return null;
  const projections = glyphs.map((glyph) => projectedBounds(glyph.bounds, direction));
  const advances = projections.map(([start, glyphEnd], index) => {
    const nextStart = projections[index + 1]?.[0];
    const end = nextStart ?? glyphEnd;
    return (end - start) / baselineScale;
  });
  return advances.every((advance) => Number.isFinite(advance) && advance > 0)
    ? Object.freeze(advances)
    : null;
}

export function sourceAdvanceProfilePrefix(
  profile: readonly number[] | null,
  sourceRun: ShapedRun,
  editedRun: ShapedRun,
): readonly number[] | null {
  if (profile === null) return null;
  const limit = Math.min(profile.length, sourceRun.glyphs.length, editedRun.glyphs.length);
  let length = 0;
  while (length < limit) {
    const sourceGlyph = sourceRun.glyphs[length]!;
    const editedGlyph = editedRun.glyphs[length]!;
    if (
      sourceGlyph.glyphId !== editedGlyph.glyphId ||
      sourceGlyph.cluster !== editedGlyph.cluster
    ) break;
    length += 1;
  }
  return length === 0 ? null : Object.freeze(profile.slice(0, length));
}

export function shapedRunAdvance(
  text: string,
  shapedRun: ShapedRun,
  style: EffectiveTextStyle,
): number {
  if (
    !(shapedRun.unitsPerEm > 0) ||
    !(style.fontSize > 0) ||
    !(style.horizontalScaling > 0) ||
    !Number.isFinite(shapedRun.unitsPerEm) ||
    !Number.isFinite(style.fontSize) ||
    !Number.isFinite(style.horizontalScaling)
  ) return 0;
  const characters = [...text];
  let advance = 0;
  for (const glyph of shapedRun.glyphs) {
    const character = characters[glyph.cluster] ?? '';
    advance += (
      glyph.xAdvance / shapedRun.unitsPerEm * style.fontSize
      + style.characterSpacing
      + (character === ' ' ? style.wordSpacing : 0)
    ) * style.horizontalScaling;
  }
  return Number.isFinite(advance) && advance > 0 ? advance : 0;
}

export function sourceSpacingScale(input: Readonly<{
  sourceExtent: number;
  baselineScale: number;
  shapedAdvance: number;
}>): number {
  if (
    !(input.sourceExtent > 0) ||
    !(input.baselineScale > 0) ||
    !(input.shapedAdvance > 0) ||
    !Number.isFinite(input.sourceExtent) ||
    !Number.isFinite(input.baselineScale) ||
    !Number.isFinite(input.shapedAdvance)
  ) return 1;
  const scale = input.sourceExtent / (input.baselineScale * input.shapedAdvance);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}
