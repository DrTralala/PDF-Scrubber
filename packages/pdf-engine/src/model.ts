import type { PageSpace } from './geometry/page-space';
import type { Matrix } from './geometry/matrix';

export type PdfObjectRef = Readonly<{
  objectNumber: number;
  generationNumber: number;
}>;

export type StreamPathSegment = Readonly<{
  kind: 'pageContents' | 'formXObject';
  ref: PdfObjectRef;
  resourceName: string | null;
}>;

export type HalfOpenRange = Readonly<{ start: number; end: number }>;

export type SpanAddress = Readonly<{
  pageRef: PdfObjectRef;
  streamPath: readonly StreamPathSegment[];
  operatorRange: HalfOpenRange;
  glyphRange: HalfOpenRange;
}>;

export type CanonicalBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type PdfColour = Readonly<{
  colourSpace: 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK';
  components: readonly number[];
}>;

export type GlyphSourceAddress = Readonly<{
  pageRef: PdfObjectRef;
  streamPath: readonly StreamPathSegment[];
  operatorIndex: number;
  glyphIndex: number;
  sourceCodeRange: HalfOpenRange;
}>;

export type EffectiveTextStyle = Readonly<{
  fontResourceName: string;
  fontBaseName: string;
  fontSize: number;
  horizontalScaling: number;
  characterSpacing: number;
  wordSpacing: number;
  rise: number;
  renderingMode: number;
  fillColour: PdfColour;
  strokeColour: PdfColour;
  fontWeight: number | null;
  italicAngle: number | null;
}>;

export type TextDecorationKind = 'underline' | 'strikethrough';

export type TextDecorations = Readonly<{
  underline: boolean;
  strikethrough: boolean;
}>;

export type DecorationGraphicAddress = Readonly<{
  pageRef: PdfObjectRef;
  streamPath: readonly StreamPathSegment[];
  operatorRange: HalfOpenRange;
}>;

export type DecorationQuad = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];

export type SourceDecorationGraphic = Readonly<{
  address: DecorationGraphicAddress;
  referenceCount: number;
  paint: 'stroke' | 'fill';
  axis: readonly [readonly [number, number], readonly [number, number]];
  quad: DecorationQuad;
  bounds: CanonicalBounds;
  thickness: number;
  colour: PdfColour;
}>;

export type MatchedSourceDecoration = Readonly<{
  kind: TextDecorationKind;
  graphic: SourceDecorationGraphic;
  lineKey: string;
  glyphRange: HalfOpenRange;
}>;

export type DecorationWarningReason =
  | 'ambiguous-geometry'
  | 'shared-content'
  | 'multiple-owners'
  | 'unsupported-style';

export type SourceDecorationWarning = Readonly<{
  reason: DecorationWarningReason;
  graphic: SourceDecorationGraphic;
  lineKey: string | null;
  glyphRanges: readonly HalfOpenRange[];
}>;

export const DEFAULT_TEXT_DECORATIONS: TextDecorations = Object.freeze({
  underline: false,
  strikethrough: false,
});

export type CapabilityKind =
  | 'safeReplacement'
  | 'replacementWithSubstitution'
  | 'readOnly';

export type CapabilityReason =
  | 'supportedExistingFont'
  | 'substituteFontRequired'
  | 'replacementOverflow'
  | 'unsupportedEncoding'
  | 'ambiguousTransform'
  | 'sharedResource'
  | 'outlinedText'
  | 'scannedContent'
  | 'fontEmbeddingProhibited'
  | 'unsupportedOperator'
  | 'malformedContent';

export type Capability = Readonly<{
  kind: CapabilityKind;
  reasons: readonly CapabilityReason[];
}>;

export type AnalysedSpan = Readonly<{
  address: SpanAddress;
  unicode: string | null;
  bounds: CanonicalBounds;
  baseline: readonly [number, number];
  glyphs: readonly AnalysedGlyph[];
  styleKey: string;
  style: EffectiveTextStyle;
  fontSize: number;
  horizontalScaling: number;
  textMatrix: readonly [number, number, number, number, number, number];
  renderMatrix: readonly [number, number, number, number, number, number];
  resource: AnalysedResourceEvidence;
  capability: Capability;
}>;

export type AnalysedGlyph = Readonly<{
  glyphIndex: number;
  sourceCodeStart: number;
  sourceCodeEnd: number;
  sourceCode: number;
  glyphId: number | null;
  unicode: string | null;
  advance: number;
  source: GlyphSourceAddress;
  mutationAddress: SpanAddress;
  bounds: CanonicalBounds;
  baseline: readonly [number, number];
  styleKey: string;
  style: EffectiveTextStyle;
  decorations: TextDecorations;
}>;

export type AnalysedStyleRun = Readonly<{
  glyphRange: HalfOpenRange;
  text: string;
  styleKey: string;
  style: EffectiveTextStyle;
  decorations: TextDecorations;
}>;

export type AnalysedTextGroup = Readonly<{
  key: string;
  lineKey: string;
  glyphRange: HalfOpenRange;
  text: string;
  bounds: CanonicalBounds;
  styleRuns: readonly AnalysedStyleRun[];
  capability: Capability;
}>;

export type AnalysedTextLine = Readonly<{
  key: string;
  pageIndex: number;
  glyphs: readonly AnalysedGlyph[];
  groups: readonly AnalysedTextGroup[];
  bounds: CanonicalBounds;
  baselineDirection: readonly [number, number];
  sourceDecorations: readonly MatchedSourceDecoration[];
  decorationWarnings: readonly SourceDecorationWarning[];
  capability: Capability;
}>;

export type AnalysedTextLayout = Readonly<{
  pageIndex: number;
  lines: readonly AnalysedTextLine[];
  groups: readonly AnalysedTextGroup[];
  decorationWarnings: readonly SourceDecorationWarning[];
  eligibleSourceGlyphCount: number;
}>;

export type SourceGlyphSlice = SpanAddress;

export type TextSelection = Readonly<{
  key: string;
  pageIndex: number;
  lineKey: string;
  glyphRange: HalfOpenRange;
  sourceSlices: readonly SourceGlyphSlice[];
  text: string;
  bounds: CanonicalBounds;
  styleRuns: readonly AnalysedStyleRun[];
  sourceDecorations: readonly MatchedSourceDecoration[];
  decorationWarnings: readonly SourceDecorationWarning[];
  capability: Capability;
}>;

export type AnalysedResourceEvidence = Readonly<{
  fontResourceName: string;
  fontBaseName: string;
  fontSubtype: string;
  fontEmbedded: boolean;
  writingMode: 0 | 1;
  referenceCount: number;
  fontWeight: number | null;
  italicAngle: number | null;
}>;

export type AnalysedPage = Readonly<{
  pageIndex: number;
  pageRef: PdfObjectRef;
  pageSpace: PageSpace;
  spans: readonly AnalysedSpan[];
  decorationGraphics: readonly SourceDecorationGraphic[];
  graphicsState: Readonly<{
    balanced: true;
    finalCtm: Matrix;
  }>;
}>;

function referenceKey(ref: PdfObjectRef): string {
  return `${ref.objectNumber}:${ref.generationNumber}`;
}

export function spanAddressKey(address: SpanAddress): string {
  const path = address.streamPath
    .map(
      ({ kind, ref, resourceName }) =>
        `${kind}:${referenceKey(ref)}:${resourceName === null ? '-' : encodeURIComponent(resourceName)}`,
    )
    .join('/');

  return [
    referenceKey(address.pageRef),
    path,
    `${address.operatorRange.start}:${address.operatorRange.end}`,
    `${address.glyphRange.start}:${address.glyphRange.end}`,
  ].join('|');
}

export function decorationGraphicAddressKey(address: DecorationGraphicAddress): string {
  const path = address.streamPath
    .map(
      ({ kind, ref, resourceName }) =>
        `${kind}:${referenceKey(ref)}:${resourceName === null ? '-' : encodeURIComponent(resourceName)}`,
    )
    .join('/');
  return [
    referenceKey(address.pageRef),
    path,
    `${address.operatorRange.start}:${address.operatorRange.end}`,
  ].join('|');
}

export function glyphSourceAddressKey(address: GlyphSourceAddress): string {
  const path = address.streamPath
    .map(
      ({ kind, ref, resourceName }) =>
        `${kind}:${referenceKey(ref)}:${resourceName === null ? '-' : encodeURIComponent(resourceName)}`,
    )
    .join('/');
  return [
    referenceKey(address.pageRef),
    path,
    address.operatorIndex,
    address.glyphIndex,
    `${address.sourceCodeRange.start}:${address.sourceCodeRange.end}`,
  ].join('|');
}
