import type {
  AnalysedGlyph,
  AnalysedTextLine,
  CanonicalBounds,
  GlyphSourceAddress,
  SourceGlyphSlice,
  SourceDecorationWarning,
  TextSelection,
} from '../model';
import { glyphSourceAddressKey } from '../model';
import { styleRunsForGlyphRange } from './group-lines';

function glyphText(glyph: AnalysedGlyph): string {
  return glyph.unicode ?? '\uFFFC';
}

function boundsOf(glyphs: readonly AnalysedGlyph[]): CanonicalBounds {
  const left = Math.min(...glyphs.map(({ bounds }) => bounds.x));
  const bottom = Math.min(...glyphs.map(({ bounds }) => bounds.y));
  const right = Math.max(...glyphs.map(({ bounds }) => bounds.x + bounds.width));
  const top = Math.max(...glyphs.map(({ bounds }) => bounds.y + bounds.height));
  return Object.freeze({ x: left, y: bottom, width: right - left, height: top - bottom });
}

function sameReference(
  left: GlyphSourceAddress['pageRef'],
  right: GlyphSourceAddress['pageRef'],
): boolean {
  return left.objectNumber === right.objectNumber &&
    left.generationNumber === right.generationNumber;
}

function samePath(
  left: GlyphSourceAddress['streamPath'],
  right: GlyphSourceAddress['streamPath'],
): boolean {
  return left.length === right.length && left.every((segment, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      segment.kind === candidate.kind &&
      segment.resourceName === candidate.resourceName &&
      sameReference(segment.ref, candidate.ref);
  });
}

function sourceSlices(glyphs: readonly AnalysedGlyph[]): readonly SourceGlyphSlice[] {
  const slices: SourceGlyphSlice[] = [];
  for (const glyph of glyphs) {
    const source = glyph.mutationAddress;
    const previous = slices.at(-1);
    if (
      previous !== undefined &&
      previous.operatorRange.start === source.operatorRange.start &&
      previous.operatorRange.end === source.operatorRange.end &&
      previous.glyphRange.start === source.glyphRange.start &&
      previous.glyphRange.end === source.glyphRange.end &&
      sameReference(previous.pageRef, source.pageRef) &&
      samePath(previous.streamPath, source.streamPath)
    ) continue;
    if (
      previous !== undefined &&
      sameReference(previous.pageRef, source.pageRef) &&
      samePath(previous.streamPath, source.streamPath) &&
      previous.operatorRange.start === source.operatorRange.start &&
      previous.operatorRange.end === source.operatorRange.end &&
      previous.glyphRange.end === source.glyphRange.start
    ) {
      slices[slices.length - 1] = Object.freeze({
        ...previous,
        glyphRange: Object.freeze({
          start: previous.glyphRange.start,
          end: source.glyphRange.end,
        }),
      });
      continue;
    }
    slices.push(source);
  }
  return Object.freeze(slices);
}

type CharacterRange = Readonly<{ start: number; end: number }>;

function characterRanges(glyphs: readonly AnalysedGlyph[]): readonly CharacterRange[] {
  let offset = 0;
  return Object.freeze(glyphs.map((glyph) => {
    const start = offset;
    offset += glyphText(glyph).length;
    return Object.freeze({ start, end: offset });
  }));
}

function expandToGraphemes(
  glyphs: readonly AnalysedGlyph[],
  start: number,
  end: number,
): readonly [number, number] {
  const ranges = characterRanges(glyphs);
  const text = glyphs.map(glyphText).join('');
  const segments = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)]
    .map((segment, index, all) => Object.freeze({
      start: segment.index,
      end: all[index + 1]?.index ?? text.length,
    }));
  let expandedStart = start;
  let expandedEnd = end;
  for (const segment of segments) {
    const overlapsSelection = ranges.slice(start, end).some((range) =>
      range.start < segment.end && range.end > segment.start);
    if (!overlapsSelection) continue;
    const overlappingGlyphs = ranges
      .map((range, index) => ({ range, index }))
      .filter(({ range }) => range.start < segment.end && range.end > segment.start)
      .map(({ index }) => index);
    expandedStart = Math.min(expandedStart, overlappingGlyphs[0] ?? expandedStart);
    expandedEnd = Math.max(expandedEnd, (overlappingGlyphs.at(-1) ?? expandedEnd - 1) + 1);
  }
  return Object.freeze([expandedStart, expandedEnd]);
}

function overlaps(
  left: Readonly<{ start: number; end: number }>,
  right: Readonly<{ start: number; end: number }>,
): boolean {
  return left.start < right.end && left.end > right.start;
}

export function buildTextSelection(
  line: AnalysedTextLine,
  anchorGlyph: number,
  focusGlyph: number,
): TextSelection {
  if (
    !Number.isSafeInteger(anchorGlyph) ||
    !Number.isSafeInteger(focusGlyph) ||
    anchorGlyph < 0 ||
    focusGlyph < 0 ||
    anchorGlyph >= line.glyphs.length ||
    focusGlyph >= line.glyphs.length
  ) {
    throw new RangeError('Text selection endpoints must resolve to glyphs on one line');
  }
  const requestedStart = Math.min(anchorGlyph, focusGlyph);
  const requestedEnd = Math.max(anchorGlyph, focusGlyph) + 1;
  const [start, end] = expandToGraphemes(line.glyphs, requestedStart, requestedEnd);
  const glyphRange = Object.freeze({ start, end });
  const glyphs = line.glyphs.slice(start, end);
  const styleRuns = styleRunsForGlyphRange(line.glyphs, glyphRange);
  const sourceDecorations = Object.freeze(line.sourceDecorations.filter(({ glyphRange: owner }) =>
    owner.start >= start && owner.end <= end));
  const partialWarnings: SourceDecorationWarning[] = line.sourceDecorations
    .filter(({ glyphRange: owner }) => overlaps(owner, glyphRange) &&
      !(owner.start >= start && owner.end <= end))
    .map(({ graphic, glyphRange: owner }) => Object.freeze({
      reason: 'ambiguous-geometry' as const,
      graphic,
      lineKey: line.key,
      glyphRanges: Object.freeze([owner]),
    }));
  const lineWarnings = line.decorationWarnings.filter(({ glyphRanges }) =>
    glyphRanges.length === 0 || glyphRanges.some((range) => overlaps(range, glyphRange)));
  return Object.freeze({
    key: `${line.key}|selection:${glyphSourceAddressKey(glyphs[0]!.source)}:${glyphSourceAddressKey(glyphs.at(-1)!.source)}`,
    pageIndex: line.pageIndex,
    lineKey: line.key,
    glyphRange,
    sourceSlices: sourceSlices(glyphs),
    text: styleRuns.map(({ text }) => text).join(''),
    bounds: boundsOf(glyphs),
    styleRuns,
    sourceDecorations,
    decorationWarnings: Object.freeze([...lineWarnings, ...partialWarnings]),
    capability: line.capability,
  });
}
