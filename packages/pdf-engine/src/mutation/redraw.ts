import { PDFDict, PDFName, PDFNumber, PDFRef } from 'pdf-lib';

import { analysePage } from '../analysis/analyse-page';
import { PDF_SCRUBBER_MARKED_CONTENT_TAG } from '../content/brand-markers';
import {
  embedResolvedFontRuns,
  embedSubstituteFont,
  type ResolvedFontAsset,
  type SubstituteFontAsset,
} from '../fonts/font-embedding';
import type { ShapedRun } from '../fonts/harfbuzz-shaper';
import { resolveTextDecorationMetrics } from '../fonts/text-decoration-metrics';
import { multiply, transformPoint, type Matrix } from '../geometry/matrix';
import { canonicalToPdf, type PageBox, type PageSpace } from '../geometry/page-space';
import type {
  AnalysedSpan,
  CanonicalBounds,
  EffectiveTextStyle,
  PdfColour,
  PdfObjectRef,
  SpanAddress,
  TextSelection,
  TextDecorations,
} from '../model';
import {
  OBJECT_STORE_ANALYSIS_ACCESS,
  type ObjectStore,
} from '../pdf/object-store';
import { MutationError } from './excise';
import { isolatePageContents } from './isolate-page';

export type ControlledRedrawResult = Readonly<{
  fontResourceName: string;
  contentStreamRef: PdfObjectRef;
  contentBytes: Uint8Array;
}>;

export type ResolvedRichTextRun = Readonly<{
  text: string;
  style: EffectiveTextStyle;
  shapedRun: ShapedRun;
  fontAsset: ResolvedFontAsset;
  decorations: TextDecorations;
}>;

export type ControlledRichRedrawResult = Readonly<{
  fontResourceNames: readonly string[];
  contentStreamRef: PdfObjectRef;
  contentBytes: Uint8Array;
  bounds: CanonicalBounds;
}>;

export type RichRedrawMeasurement = Readonly<{
  bounds: CanonicalBounds;
}>;

function pageSpace(store: ObjectStore, pageIndex: number): PageSpace {
  const { document } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const page = document.getPage(pageIndex);
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const box = (value: typeof media): PageBox => Object.freeze([
    value.x,
    value.y,
    value.x + value.width,
    value.y + value.height,
  ]);
  return Object.freeze({
    mediaBox: box(media),
    cropBox: box(crop),
    rotate: page.getRotation().angle,
    userUnit: page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber)?.asNumber() ?? 1,
  });
}

function number(value: number): string {
  if (!Number.isFinite(value)) {
    throw new MutationError('READ_ONLY_SPAN', 'Redraw transform is not finite');
  }
  const rounded = Math.abs(value) < 5e-10 ? 0 : Number(value.toFixed(9));
  return String(rounded);
}

function actualTextHex(text: string): string {
  let result = 'FEFF';
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0xffff) {
      result += codePoint.toString(16).padStart(4, '0');
    } else {
      const value = codePoint - 0x10000;
      result += (0xd800 + (value >> 10)).toString(16).padStart(4, '0');
      result += (0xdc00 + (value & 0x3ff)).toString(16).padStart(4, '0');
    }
  }
  return result.toUpperCase();
}

function colourOperator(colour: PdfColour, stroke: boolean): string {
  if (
    colour.components.some((component) => !Number.isFinite(component)) ||
    (colour.colourSpace === 'DeviceGray' && colour.components.length !== 1) ||
    (colour.colourSpace === 'DeviceRGB' && colour.components.length !== 3) ||
    (colour.colourSpace === 'DeviceCMYK' && colour.components.length !== 4)
  ) {
    throw new MutationError('READ_ONLY_SPAN', 'Replacement colour is invalid');
  }
  const operator = colour.colourSpace === 'DeviceGray'
    ? stroke ? 'G' : 'g'
    : colour.colourSpace === 'DeviceRGB'
      ? stroke ? 'RG' : 'rg'
      : stroke ? 'K' : 'k';
  return `${colour.components.map(number).join(' ')} ${operator}`;
}

function encodedGlyphs(encodedText: string, glyphCount: number): readonly string[] {
  const match = /^<([0-9A-F]+)>$/i.exec(encodedText);
  if (match === null || match[1]!.length !== glyphCount * 4) {
    throw new MutationError(
      'INTERNAL_FAILURE',
      'Embedded subset encoding does not align with the shaped glyph run',
    );
  }
  return Object.freeze(Array.from(
    { length: glyphCount },
    (_, index) => `<${match[1]!.slice(index * 4, index * 4 + 4)}>` ,
  ));
}

function clonePageLocalFontResources(
  store: ObjectStore,
  pageIndex: number,
  resourceName: string,
  fontReference: PDFRef,
): void {
  const { document } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const page = document.getPage(pageIndex);
  const context = document.context;
  const inheritedResources = page.node.Resources();
  const resources = inheritedResources?.clone(context) ?? context.obj({});
  const inheritedFonts = inheritedResources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const fonts = inheritedFonts?.clone(context) ?? context.obj({});
  const key = PDFName.of(resourceName);
  if (fonts.has(key)) {
    throw new MutationError('INTERNAL_FAILURE', 'Deterministic font resource name collided');
  }
  fonts.set(key, fontReference);
  resources.set(PDFName.of('Font'), fonts);
  page.node.set(PDFName.of('Resources'), resources);
}

function sameReference(left: PdfObjectRef, right: PdfObjectRef): boolean {
  return left.objectNumber === right.objectNumber &&
    left.generationNumber === right.generationNumber;
}

function sameStreamPath(left: SpanAddress['streamPath'], right: SpanAddress['streamPath']): boolean {
  return left.length === right.length && left.every((segment, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      segment.kind === candidate.kind &&
      segment.resourceName === candidate.resourceName &&
      sameReference(segment.ref, candidate.ref);
  });
}

function sameOperation(left: SpanAddress, right: SpanAddress): boolean {
  return sameReference(left.pageRef, right.pageRef) &&
    sameStreamPath(left.streamPath, right.streamPath) &&
    left.operatorRange.start === right.operatorRange.start &&
    left.operatorRange.end === right.operatorRange.end;
}

async function selectionAnchor(
  store: ObjectStore,
  selection: TextSelection,
): Promise<Readonly<{ canonicalMatrix: Matrix; pdfMatrix: Matrix }>> {
  const firstSlice = selection.sourceSlices[0];
  if (firstSlice === undefined) {
    throw new MutationError('STALE_REVISION', 'Replacement selection has no source anchor');
  }
  const analysed = await analysePage(store, selection.pageIndex);
  const matches = analysed.spans.filter(({ address }) => sameOperation(address, firstSlice));
  if (matches.length !== 1) {
    throw new MutationError('STALE_REVISION', 'Replacement selection anchor no longer resolves');
  }
  const span = matches[0]!;
  const glyph = span.glyphs[firstSlice.glyphRange.start];
  if (glyph === undefined) {
    throw new MutationError('STALE_REVISION', 'Replacement selection anchor glyph no longer resolves');
  }
  const originX = glyph.baseline[0] - span.renderMatrix[2] * glyph.style.rise;
  const originY = glyph.baseline[1] - span.renderMatrix[3] * glyph.style.rise;
  const canonicalMatrix: Matrix = Object.freeze([
    span.renderMatrix[0],
    span.renderMatrix[1],
    span.renderMatrix[2],
    span.renderMatrix[3],
    originX,
    originY,
  ]);
  return Object.freeze({
    canonicalMatrix,
    pdfMatrix: multiply(canonicalToPdf(pageSpace(store, selection.pageIndex)), canonicalMatrix),
  });
}

function boundsFromPoints(points: readonly (readonly [number, number])[]): CanonicalBounds {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return Object.freeze({
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  });
}

function unionBounds(bounds: readonly CanonicalBounds[]): CanonicalBounds {
  const left = Math.min(...bounds.map(({ x }) => x));
  const bottom = Math.min(...bounds.map(({ y }) => y));
  const right = Math.max(...bounds.map(({ x, width }) => x + width));
  const top = Math.max(...bounds.map(({ y, height }) => y + height));
  return Object.freeze({ x: left, y: bottom, width: right - left, height: top - bottom });
}

type PositionedRichGlyph = Readonly<{
  matrix: Matrix;
  bounds: CanonicalBounds;
}>;

type RichDecorationGeometry = Readonly<{
  runIndex: number;
  kind: 'underline' | 'strikethrough';
  colour: PdfColour;
  pdfPoints: readonly (readonly [number, number])[];
  bounds: CanonicalBounds;
}>;

function decorationGeometry(
  anchor: Awaited<ReturnType<typeof selectionAnchor>>,
  runIndex: number,
  kind: RichDecorationGeometry['kind'],
  colour: PdfColour,
  start: readonly [number, number],
  end: readonly [number, number],
  position: number,
  thickness: number,
): RichDecorationGeometry {
  const lower = position - thickness / 2;
  const upper = position + thickness / 2;
  const local = Object.freeze([
    Object.freeze([start[0], start[1] + lower] as const),
    Object.freeze([end[0], end[1] + lower] as const),
    Object.freeze([end[0], end[1] + upper] as const),
    Object.freeze([start[0], start[1] + upper] as const),
  ]);
  const canonicalPoints = Object.freeze(local.map(([x, y]) =>
    Object.freeze(transformPoint(anchor.canonicalMatrix, x, y))));
  const pdfPoints = Object.freeze(local.map(([x, y]) =>
    Object.freeze(transformPoint(anchor.pdfMatrix, x, y))));
  return Object.freeze({
    runIndex,
    kind,
    colour,
    pdfPoints,
    bounds: boundsFromPoints(canonicalPoints),
  });
}

function layoutRichRuns(
  anchor: Awaited<ReturnType<typeof selectionAnchor>>,
  runs: readonly ResolvedRichTextRun[],
): Readonly<{
  positions: readonly (readonly PositionedRichGlyph[])[];
  decorations: readonly RichDecorationGeometry[];
  bounds: CanonicalBounds;
}> {
  let cursorX = 0;
  let cursorY = 0;
  const glyphBounds: CanonicalBounds[] = [];
  const decorations: RichDecorationGeometry[] = [];
  const positions = runs.map((run, runIndex) => {
    const { style, shapedRun, fontAsset } = run;
    if (
      !(style.fontSize > 0) || !(style.horizontalScaling > 0) ||
      style.renderingMode < 0 || style.renderingMode > 3
    ) {
      throw new MutationError('READ_ONLY_SPAN', 'Rich replacement text state is unsupported');
    }
    const runStart = Object.freeze([cursorX, cursorY] as const);
    const characters = [...run.text.normalize('NFC')];
    const positioned = Object.freeze(shapedRun.glyphs.map((glyph) => {
      const x = cursorX + glyph.xOffset / shapedRun.unitsPerEm *
        style.fontSize * style.horizontalScaling;
      const y = cursorY + glyph.yOffset / shapedRun.unitsPerEm * style.fontSize;
      const matrix = multiply(anchor.pdfMatrix, Object.freeze([1, 0, 0, 1, x, y]));
      const inspection = fontAsset.descriptor.inspection;
      const glyphAdvance = glyph.xAdvance / shapedRun.unitsPerEm *
        style.fontSize * style.horizontalScaling;
      const left = Math.min(x, x + glyphAdvance);
      const right = Math.max(x, x + glyphAdvance);
      const bottom = y + inspection.descent / inspection.unitsPerEm * style.fontSize + style.rise;
      const top = y + inspection.ascent / inspection.unitsPerEm * style.fontSize + style.rise;
      const bounds = boundsFromPoints([
        transformPoint(anchor.canonicalMatrix, left, bottom),
        transformPoint(anchor.canonicalMatrix, right, bottom),
        transformPoint(anchor.canonicalMatrix, left, top),
        transformPoint(anchor.canonicalMatrix, right, top),
      ]);
      glyphBounds.push(bounds);
      const character = characters[glyph.cluster] ?? '';
      cursorX += (
        glyph.xAdvance / shapedRun.unitsPerEm * style.fontSize +
        style.characterSpacing +
        (character === ' ' ? style.wordSpacing : 0)
      ) * style.horizontalScaling;
      cursorY += glyph.yAdvance / shapedRun.unitsPerEm * style.fontSize;
      return Object.freeze({ matrix, bounds });
    }));
    const runEnd = Object.freeze([cursorX, cursorY] as const);
    const metrics = resolveTextDecorationMetrics(fontAsset.descriptor.inspection);
    if (run.decorations.underline) {
      decorations.push(decorationGeometry(
        anchor,
        runIndex,
        'underline',
        style.fillColour,
        runStart,
        runEnd,
        style.rise + metrics.underlinePositionEm * style.fontSize,
        metrics.underlineThicknessEm * style.fontSize,
      ));
    }
    if (run.decorations.strikethrough) {
      decorations.push(decorationGeometry(
        anchor,
        runIndex,
        'strikethrough',
        style.fillColour,
        runStart,
        runEnd,
        style.rise + metrics.strikeoutPositionEm * style.fontSize,
        metrics.strikeoutThicknessEm * style.fontSize,
      ));
    }
    return positioned;
  });
  if (glyphBounds.length === 0) {
    throw new MutationError('FONT_UNAVAILABLE', 'Rich replacement has no measurable glyphs');
  }
  return Object.freeze({
    positions: Object.freeze(positions),
    decorations: Object.freeze(decorations),
    bounds: unionBounds([...glyphBounds, ...decorations.map(({ bounds }) => bounds)]),
  });
}

export async function measureControlledRichRedraw(
  store: ObjectStore,
  pageIndex: number,
  selection: TextSelection,
  runs: readonly ResolvedRichTextRun[],
): Promise<RichRedrawMeasurement> {
  if (selection.pageIndex !== pageIndex || runs.length === 0) {
    throw new MutationError('MALFORMED_INPUT', 'Rich redraw requires runs on the selected page');
  }
  const anchor = await selectionAnchor(store, selection);
  return Object.freeze({ bounds: layoutRichRuns(anchor, runs).bounds });
}

export async function appendControlledRedraw(
  store: ObjectStore,
  pageIndex: number,
  span: AnalysedSpan,
  replacement: string,
  shapedRun: ShapedRun,
  asset: SubstituteFontAsset,
  commandHash: string,
): Promise<ControlledRedrawResult> {
  await isolatePageContents(store, pageIndex);
  const { document } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const embedded = await embedSubstituteFont(document, shapedRun, replacement, asset);
  const resourceName = `M0R_${commandHash.slice(0, 16)}`;
  clonePageLocalFontResources(store, pageIndex, resourceName, embedded.font.ref);

  const glyphCodes = encodedGlyphs(embedded.encodedText, shapedRun.glyphs.length);
  const inversePage = canonicalToPdf(pageSpace(store, pageIndex));
  const base = multiply(inversePage, span.renderMatrix);
  const baseline = transformPoint(inversePage, span.baseline[0], span.baseline[1]);
  const orientedBase: Matrix = Object.freeze([
    base[0], base[1], base[2], base[3], baseline[0], baseline[1],
  ]);
  const yAxisScale = Math.hypot(span.renderMatrix[2], span.renderMatrix[3]);
  const unitHeight = embedded.font.heightAtSize(1);
  if (!(yAxisScale > 0) || !(unitHeight > 0) || !(span.bounds.height > 0)) {
    throw new MutationError('READ_ONLY_SPAN', 'Replacement font size cannot be derived');
  }
  const fontSize = span.bounds.height / yAxisScale / unitHeight;

  const lines = [
    'q',
    'BT',
    `/${resourceName} ${number(fontSize)} Tf`,
    `/Span << /ActualText <${actualTextHex(replacement)}> >> BDC`,
  ];
  let cursorX = 0;
  let cursorY = 0;
  const positioned = shapedRun.glyphs.map((glyph, index) => {
    const x = cursorX + glyph.xOffset / shapedRun.unitsPerEm * fontSize;
    const y = cursorY + glyph.yOffset / shapedRun.unitsPerEm * fontSize;
    const matrix = multiply(orientedBase, Object.freeze([1, 0, 0, 1, x, y]));
    cursorX += glyph.xAdvance / shapedRun.unitsPerEm * fontSize;
    cursorY += glyph.yAdvance / shapedRun.unitsPerEm * fontSize;
    return Object.freeze({ glyph, index, matrix });
  });
  positioned
    .sort((left, right) => left.glyph.cluster - right.glyph.cluster || left.index - right.index)
    .forEach(({ index, matrix }) => {
      lines.push(`${matrix.map(number).join(' ')} Tm`);
      lines.push(`${glyphCodes[index]} Tj`);
    });
  lines.push('EMC', 'ET', 'Q', '');
  const contentBytes = new TextEncoder().encode(lines.join('\n'));
  const contentStreamRef = await store.appendPageContentStream(pageIndex, contentBytes);
  return Object.freeze({
    fontResourceName: resourceName,
    contentStreamRef,
    contentBytes,
  });
}

export async function appendControlledRichRedraw(
  store: ObjectStore,
  pageIndex: number,
  selection: TextSelection,
  runs: readonly ResolvedRichTextRun[],
  commandHash: string,
): Promise<ControlledRichRedrawResult> {
  if (selection.pageIndex !== pageIndex || runs.length === 0) {
    throw new MutationError('MALFORMED_INPUT', 'Rich redraw requires runs on the selected page');
  }
  if (!/^[0-9a-f]{64}$/.test(commandHash)) {
    throw new MutationError('INTERNAL_FAILURE', 'Rich redraw command hash is invalid');
  }
  if (runs.some(({ text, shapedRun }) =>
    text.length === 0 || shapedRun.direction !== 'ltr' || shapedRun.glyphs.length === 0)) {
    throw new MutationError('READ_ONLY_SPAN', 'Rich redraw supports non-empty LTR runs only');
  }

  const anchor = await selectionAnchor(store, selection);
  const layout = layoutRichRuns(anchor, runs);
  await isolatePageContents(store, pageIndex);
  const { document } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const grouped = new Map<string, {
    asset: ResolvedFontAsset;
    indexes: number[];
  }>();
  runs.forEach(({ fontAsset }, index) => {
    const existing = grouped.get(fontAsset.descriptor.id) ?? { asset: fontAsset, indexes: [] };
    if (
      existing.asset.descriptor.hash !== fontAsset.descriptor.hash ||
      existing.asset.matchKind !== fontAsset.matchKind
    ) {
      throw new MutationError('STALE_REVISION', 'One font identifier resolves to conflicting assets');
    }
    existing.indexes.push(index);
    grouped.set(fontAsset.descriptor.id, existing);
  });

  const encodedByRun = new Map<number, string>();
  const resourceByFont = new Map<string, string>();
  const resourceNames: string[] = [];
  let fontIndex = 0;
  for (const [fontId, group] of grouped) {
    const embedded = await embedResolvedFontRuns(
      document,
      group.indexes.map((index) => Object.freeze({
        text: runs[index]!.text,
        shapedRun: runs[index]!.shapedRun,
      })),
      group.asset,
    );
    const resourceName = `M0R_${commandHash.slice(0, 16)}_${fontIndex}`;
    clonePageLocalFontResources(store, pageIndex, resourceName, embedded.font.ref);
    resourceByFont.set(fontId, resourceName);
    resourceNames.push(resourceName);
    group.indexes.forEach((runIndex, index) =>
      encodedByRun.set(runIndex, embedded.encodedTexts[index]!));
    fontIndex += 1;
  }

  const replacement = runs.map(({ text }) => text).join('').normalize('NFC');
  const runGlyphCounts = runs.map(({ shapedRun }) => shapedRun.glyphs.length);
  const runDecorationFlags = runs.map(({ decorations }) =>
    Number(decorations.underline) + 2 * Number(decorations.strikethrough));
  const lines = [
    'q',
     `/${PDF_SCRUBBER_MARKED_CONTENT_TAG} << /Version 3 /ActualText <${actualTextHex(replacement)}> /CommandHash <${commandHash.toUpperCase()}> /RunGlyphCounts [${runGlyphCounts.join(' ')}] /RunDecorations [${runDecorationFlags.join(' ')}] >> BDC`,
    'BT',
  ];
  runs.forEach((run, runIndex) => {
    const { style, shapedRun, fontAsset } = run;
    const resourceName = resourceByFont.get(fontAsset.descriptor.id)!;
    const encodedText = encodedByRun.get(runIndex)!;
    const glyphCodes = encodedGlyphs(encodedText, shapedRun.glyphs.length);
    lines.push(`/${resourceName} ${number(style.fontSize)} Tf`);
    lines.push(`${number(style.characterSpacing)} Tc`);
    lines.push(`${number(style.wordSpacing)} Tw`);
    lines.push(`${number(style.horizontalScaling * 100)} Tz`);
    lines.push(`${number(style.rise)} Ts`);
    lines.push(`${style.renderingMode} Tr`);
    lines.push(colourOperator(style.fillColour, false));
    lines.push(colourOperator(style.strokeColour, true));

    shapedRun.glyphs.forEach((glyph, glyphIndex) => {
      const positioned = layout.positions[runIndex]?.[glyphIndex];
      if (positioned === undefined) {
        throw new MutationError('INTERNAL_FAILURE', 'Rich replacement layout is incomplete');
      }
      const matrix = positioned.matrix;
      lines.push(`${matrix.map(number).join(' ')} Tm`);
      lines.push(`${glyphCodes[glyphIndex]} Tj`);
    });
  });
  lines.push('ET');
  for (const decoration of layout.decorations) {
    lines.push(colourOperator(decoration.colour, false));
    const [first, second, third, fourth] = decoration.pdfPoints;
    if (
      first === undefined || second === undefined ||
      third === undefined || fourth === undefined
    ) {
      throw new MutationError('INTERNAL_FAILURE', 'Decoration geometry is incomplete');
    }
    lines.push(`${first.map(number).join(' ')} m`);
    lines.push(`${second.map(number).join(' ')} l`);
    lines.push(`${third.map(number).join(' ')} l`);
    lines.push(`${fourth.map(number).join(' ')} l`);
    lines.push('h', 'f');
  }
  lines.push('EMC', 'Q', '');
  const contentBytes = new TextEncoder().encode(lines.join('\n'));
  const contentStreamRef = await store.appendPageContentStream(pageIndex, contentBytes);
  return Object.freeze({
    fontResourceNames: Object.freeze(resourceNames),
    contentStreamRef,
    contentBytes,
    bounds: layout.bounds,
  });
}
