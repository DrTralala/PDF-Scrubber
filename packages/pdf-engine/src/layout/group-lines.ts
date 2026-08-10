import type {
  AnalysedGlyph,
  AnalysedPage,
  AnalysedSpan,
  AnalysedStyleRun,
  AnalysedTextGroup,
  AnalysedTextLayout,
  AnalysedTextLine,
  CanonicalBounds,
  Capability,
  CapabilityReason,
  HalfOpenRange,
  MatchedSourceDecoration,
  SourceDecorationWarning,
} from '../model';
import { glyphSourceAddressKey } from '../model';
import {
  matchDecorationGraphics,
  type DecorationTextOwner,
} from './match-decorations';

type LayoutGlyph = Readonly<{
  glyph: AnalysedGlyph;
  span: AnalysedSpan;
  direction: readonly [number, number];
}>;

type MutableLine = {
  glyphs: LayoutGlyph[];
  direction: readonly [number, number];
  origin: readonly [number, number];
};

const REASON_ORDER: readonly CapabilityReason[] = [
  'supportedExistingFont',
  'substituteFontRequired',
  'replacementOverflow',
  'unsupportedEncoding',
  'ambiguousTransform',
  'sharedResource',
  'outlinedText',
  'scannedContent',
  'fontEmbeddingProhibited',
  'unsupportedOperator',
  'malformedContent',
];

function boundsOf(glyphs: readonly AnalysedGlyph[]): CanonicalBounds {
  const left = Math.min(...glyphs.map(({ bounds }) => bounds.x));
  const bottom = Math.min(...glyphs.map(({ bounds }) => bounds.y));
  const right = Math.max(...glyphs.map(({ bounds }) => bounds.x + bounds.width));
  const top = Math.max(...glyphs.map(({ bounds }) => bounds.y + bounds.height));
  return Object.freeze({ x: left, y: bottom, width: right - left, height: top - bottom });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function normalisedDirection(span: AnalysedSpan): readonly [number, number] {
  const [x, y] = span.renderMatrix;
  const length = Math.hypot(x, y);
  return length === 0
    ? Object.freeze([1, 0])
    : Object.freeze([x / length, y / length]);
}

function visibleText(span: AnalysedSpan): boolean {
  return span.style.renderingMode !== 3 && span.style.renderingMode !== 7;
}

function compatibleLine(line: MutableLine, candidate: LayoutGlyph): boolean {
  const dot = line.direction[0] * candidate.direction[0] +
    line.direction[1] * candidate.direction[1];
  if (dot < Math.cos(Math.PI / 180)) return false;
  const perpendicular: readonly [number, number] = [-line.direction[1], line.direction[0]];
  const deltaX = candidate.glyph.baseline[0] - line.origin[0];
  const deltaY = candidate.glyph.baseline[1] - line.origin[1];
  const distance = Math.abs(deltaX * perpendicular[0] + deltaY * perpendicular[1]);
  const medianHeight = median(line.glyphs.map(({ glyph }) => glyph.bounds.height));
  return distance <= Math.max(1, medianHeight * 0.35);
}

function projection(item: LayoutGlyph, direction: readonly [number, number]): number {
  return item.glyph.baseline[0] * direction[0] + item.glyph.baseline[1] * direction[1];
}

function capabilities(
  candidates: readonly LayoutGlyph[],
  forceReadOnly: readonly CapabilityReason[] = [],
): Capability {
  const reasons = new Set<CapabilityReason>(forceReadOnly);
  let kind: Capability['kind'] = forceReadOnly.length > 0 ? 'readOnly' : 'safeReplacement';
  for (const { span } of candidates) {
    if (span.style.renderingMode >= 4) {
      kind = 'readOnly';
      reasons.add('unsupportedOperator');
    }
    if (span.capability.kind === 'readOnly') kind = 'readOnly';
    else if (kind !== 'readOnly' && span.capability.kind === 'replacementWithSubstitution') {
      kind = 'replacementWithSubstitution';
    }
    for (const reason of span.capability.reasons) reasons.add(reason);
  }
  if (kind === 'readOnly') {
    reasons.delete('supportedExistingFont');
    reasons.delete('substituteFontRequired');
  }
  if (kind === 'safeReplacement' && reasons.size === 0) reasons.add('supportedExistingFont');
  return Object.freeze({
    kind,
    reasons: Object.freeze(REASON_ORDER.filter((reason) => reasons.has(reason))),
  });
}

function glyphText(glyph: AnalysedGlyph): string {
  return glyph.unicode ?? '\uFFFC';
}

function sameDecorations(left: AnalysedGlyph, right: AnalysedGlyph): boolean {
  return left.decorations.underline === right.decorations.underline &&
    left.decorations.strikethrough === right.decorations.strikethrough;
}

function gapBetween(left: AnalysedGlyph, right: AnalysedGlyph): number {
  return right.bounds.x - (left.bounds.x + left.bounds.width);
}

function hasExplicitSpace(left: AnalysedGlyph, right: AnalysedGlyph): boolean {
  return /\s$/u.test(glyphText(left)) || /^\s/u.test(glyphText(right));
}

function needsSyntheticSpace(
  glyphs: readonly AnalysedGlyph[],
  index: number,
): boolean {
  if (index <= 0) return false;
  const left = glyphs[index - 1]!;
  const right = glyphs[index]!;
  if (hasExplicitSpace(left, right)) return false;
  const height = median(glyphs.map(({ bounds }) => bounds.height));
  const gap = gapBetween(left, right);
  return gap > height * 0.15 && gap <= height * 0.75;
}

export function styleRunsForGlyphRange(
  glyphs: readonly AnalysedGlyph[],
  range: HalfOpenRange,
): readonly AnalysedStyleRun[] {
  const runs: AnalysedStyleRun[] = [];
  let current: {
    start: number;
    end: number;
    text: string;
    glyph: AnalysedGlyph;
  } | undefined;
  for (let index = range.start; index < range.end; index += 1) {
    const glyph = glyphs[index]!;
    if (current !== undefined && needsSyntheticSpace(glyphs, index)) current.text += ' ';
    if (
      current === undefined ||
      current.glyph.styleKey !== glyph.styleKey ||
      !sameDecorations(current.glyph, glyph)
    ) {
      if (current !== undefined) {
        runs.push(Object.freeze({
          glyphRange: Object.freeze({ start: current.start, end: current.end }),
          text: current.text,
          styleKey: current.glyph.styleKey,
          style: current.glyph.style,
          decorations: current.glyph.decorations,
        }));
      }
      current = { start: index, end: index + 1, text: glyphText(glyph), glyph };
    } else {
      current.end = index + 1;
      current.text += glyphText(glyph);
    }
  }
  if (current !== undefined) {
    runs.push(Object.freeze({
      glyphRange: Object.freeze({ start: current.start, end: current.end }),
      text: current.text,
      styleKey: current.glyph.styleKey,
      style: current.glyph.style,
      decorations: current.glyph.decorations,
    }));
  }
  return Object.freeze(runs);
}

function shouldSplitGroup(glyphs: readonly AnalysedGlyph[], index: number): boolean {
  const left = glyphs[index - 1]!;
  const right = glyphs[index]!;
  if (hasExplicitSpace(left, right)) return false;
  const height = median(glyphs.map(({ bounds }) => bounds.height));
  const gap = gapBetween(left, right);
  return gap > height * 0.75 || (/\s*:\s*$/u.test(glyphText(left)) && gap > height * 0.25);
}

function group(
  lineKey: string,
  glyphs: readonly AnalysedGlyph[],
  candidates: readonly LayoutGlyph[],
  start: number,
  end: number,
): AnalysedTextGroup {
  const glyphRange = Object.freeze({ start, end });
  const selectedGlyphs = glyphs.slice(start, end);
  const styleRuns = styleRunsForGlyphRange(glyphs, glyphRange);
  return Object.freeze({
    key: `${lineKey}|group:${start}:${end}`,
    lineKey,
    glyphRange,
    text: styleRuns.map(({ text }) => text).join(''),
    bounds: boundsOf(selectedGlyphs),
    styleRuns,
    capability: capabilities(candidates.slice(start, end)),
  });
}

function containsRtlText(glyphs: readonly AnalysedGlyph[]): boolean {
  return glyphs.some(({ unicode }) =>
    unicode !== null && /[\u0590-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]/u.test(unicode));
}

function makeLine(pageIndex: number, mutable: MutableLine): AnalysedTextLine {
  const ordered = [...mutable.glyphs].sort(
    (left, right) => projection(left, mutable.direction) - projection(right, mutable.direction),
  );
  const glyphs = Object.freeze(ordered.map(({ glyph }) => glyph));
  const first = glyphs[0]!;
  const last = glyphs.at(-1)!;
  const key = `page:${pageIndex}|line:${glyphSourceAddressKey(first.source)}:${glyphSourceAddressKey(last.source)}`;
  const forceReadOnly = containsRtlText(glyphs) ||
    ordered.some(({ span }) => span.resource.writingMode === 1)
    ? ['unsupportedEncoding' as const]
    : [];
  const lineCapability = capabilities(ordered, forceReadOnly);
  const groups: AnalysedTextGroup[] = [];
  let start = 0;
  for (let index = 1; index < glyphs.length; index += 1) {
    if (!shouldSplitGroup(glyphs, index)) continue;
    groups.push(group(key, glyphs, ordered, start, index));
    start = index;
  }
  groups.push(group(key, glyphs, ordered, start, glyphs.length));
  return Object.freeze({
    key,
    pageIndex,
    glyphs,
    groups: Object.freeze(groups),
    bounds: boundsOf(glyphs),
    baselineDirection: mutable.direction,
    sourceDecorations: Object.freeze([]),
    decorationWarnings: Object.freeze([]),
    capability: lineCapability,
  });
}

function projectedBounds(
  glyphs: readonly AnalysedGlyph[],
  direction: readonly [number, number],
): Readonly<{ alongStart: number; alongEnd: number; normalStart: number; normalEnd: number }> {
  const normal: readonly [number, number] = [-direction[1], direction[0]];
  const points = glyphs.flatMap(({ bounds }) => [
    [bounds.x, bounds.y] as const,
    [bounds.x + bounds.width, bounds.y] as const,
    [bounds.x + bounds.width, bounds.y + bounds.height] as const,
    [bounds.x, bounds.y + bounds.height] as const,
  ]);
  const along = points.map(([x, y]) => x * direction[0] + y * direction[1]);
  const across = points.map(([x, y]) => x * normal[0] + y * normal[1]);
  return Object.freeze({
    alongStart: Math.min(...along),
    alongEnd: Math.max(...along),
    normalStart: Math.min(...across),
    normalEnd: Math.max(...across),
  });
}

function decorationOwners(lines: readonly AnalysedTextLine[]): readonly DecorationTextOwner[] {
  const owners: DecorationTextOwner[] = [];
  for (const line of lines) {
    const direction = line.baselineDirection;
    const normal: readonly [number, number] = [-direction[1], direction[0]];
    for (const group of line.groups) {
      for (const run of group.styleRuns) {
        const glyphs = line.glyphs.slice(run.glyphRange.start, run.glyphRange.end);
        if (glyphs.length === 0) continue;
        const extents = projectedBounds(glyphs, direction);
        const baselineNormal = median(glyphs.map(({ baseline }) =>
          baseline[0] * normal[0] + baseline[1] * normal[1]));
        const baseline: DecorationTextOwner['baseline'] = Object.freeze([
          Object.freeze([
            direction[0] * extents.alongStart + normal[0] * baselineNormal,
            direction[1] * extents.alongStart + normal[1] * baselineNormal,
          ] as const),
          Object.freeze([
            direction[0] * extents.alongEnd + normal[0] * baselineNormal,
            direction[1] * extents.alongEnd + normal[1] * baselineNormal,
          ] as const),
        ]);
        owners.push(Object.freeze({
          lineKey: line.key,
          glyphRange: run.glyphRange,
          baseline,
          em: extents.normalEnd - extents.normalStart,
          colour: run.style.fillColour,
        }));
      }
    }
  }
  return Object.freeze(owners);
}

function decorateLine(
  line: AnalysedTextLine,
  decorations: readonly MatchedSourceDecoration[],
  warnings: readonly SourceDecorationWarning[],
): AnalysedTextLine {
  const sourceDecorations = decorations.filter(({ lineKey }) => lineKey === line.key);
  const decorationWarnings = warnings.filter(({ lineKey }) => lineKey === line.key);
  if (sourceDecorations.length === 0 && decorationWarnings.length === 0) return line;
  const glyphs = Object.freeze(line.glyphs.map((glyph, index) => {
    const matching = sourceDecorations.filter(({ glyphRange }) =>
      index >= glyphRange.start && index < glyphRange.end);
    if (matching.length === 0) return glyph;
    return Object.freeze({
      ...glyph,
      decorations: Object.freeze({
        underline: matching.some(({ kind }) => kind === 'underline'),
        strikethrough: matching.some(({ kind }) => kind === 'strikethrough'),
      }),
    });
  }));
  const groups = Object.freeze(line.groups.map((existing) => {
    const styleRuns = styleRunsForGlyphRange(glyphs, existing.glyphRange);
    return Object.freeze({
      ...existing,
      text: styleRuns.map(({ text }) => text).join(''),
      styleRuns,
    });
  }));
  return Object.freeze({
    ...line,
    glyphs,
    groups,
    sourceDecorations: Object.freeze(sourceDecorations),
    decorationWarnings: Object.freeze(decorationWarnings),
  });
}

export function groupPageText(page: AnalysedPage): AnalysedTextLayout {
  const candidates = page.spans
    .filter(visibleText)
    .flatMap((span) => {
      const direction = normalisedDirection(span);
      return span.glyphs.map((glyph) => Object.freeze({ glyph, span, direction }));
    })
    .sort((left, right) =>
      right.glyph.baseline[1] - left.glyph.baseline[1] ||
      left.glyph.baseline[0] - right.glyph.baseline[0]);
  const mutableLines: MutableLine[] = [];
  for (const candidate of candidates) {
    const existing = mutableLines.find((line) => compatibleLine(line, candidate));
    if (existing === undefined) {
      mutableLines.push({
        glyphs: [candidate],
        direction: candidate.direction,
        origin: candidate.glyph.baseline,
      });
    } else {
      existing.glyphs.push(candidate);
    }
  }
  const undecoratedLines = Object.freeze(mutableLines
    .map((line) => makeLine(page.pageIndex, line))
    .sort((left, right) =>
      right.bounds.y - left.bounds.y || left.bounds.x - right.bounds.x));
  const matches = matchDecorationGraphics(page.decorationGraphics, decorationOwners(undecoratedLines));
  const lines = Object.freeze(undecoratedLines.map((line) =>
    decorateLine(line, matches.decorations, matches.warnings)));
  return Object.freeze({
    pageIndex: page.pageIndex,
    lines,
    groups: Object.freeze(lines.flatMap(({ groups }) => groups)),
    decorationWarnings: matches.warnings,
    eligibleSourceGlyphCount: candidates.length,
  });
}
