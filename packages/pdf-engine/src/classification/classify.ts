import type {
  AnalysedSpan,
  CanonicalBounds,
  Capability,
  CapabilityReason,
} from '../model';

const REASON_ORDER: readonly CapabilityReason[] = Object.freeze([
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
]);

const READ_ONLY_REASONS = new Set<CapabilityReason>([
  'replacementOverflow',
  'ambiguousTransform',
  'sharedResource',
  'outlinedText',
  'scannedContent',
  'fontEmbeddingProhibited',
  'unsupportedOperator',
  'malformedContent',
]);

const STANDARD_14_FONTS = new Set([
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Symbol', 'ZapfDingbats',
]);

export type ReplacementFontEvidence = Readonly<{
  existingFontCanEncode: boolean;
  substituteFontAvailable: boolean;
  substituteFontEmbeddable: boolean;
  replacementBounds: CanonicalBounds;
  acceptSubstitution: boolean;
}>;

export type ReplacementClassification = Capability & Readonly<{
  normalisedReplacement: string;
  canApply: boolean;
  substitutionAccepted: boolean;
}>;

function reasons(values: Iterable<CapabilityReason>): readonly CapabilityReason[] {
  const unique = new Set(values);
  return Object.freeze(REASON_ORDER.filter((reason) => unique.has(reason)));
}

function immutableCapability(
  kind: Capability['kind'],
  values: Iterable<CapabilityReason>,
): Capability {
  return Object.freeze({ kind, reasons: reasons(values) });
}

function finiteBounds(bounds: CanonicalBounds): boolean {
  return Number.isFinite(bounds.x) && Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) && Number.isFinite(bounds.height) &&
    bounds.width >= 0 && bounds.height >= 0;
}

function finiteMatrix(matrix: readonly number[]): boolean {
  return matrix.length === 6 && matrix.every(Number.isFinite);
}

function exactExcisionIsProvable(span: AnalysedSpan): boolean {
  const { glyphRange, operatorRange, streamPath } = span.address;
  if (
    streamPath.length === 0 ||
    operatorRange.start < 0 || operatorRange.end <= operatorRange.start ||
    glyphRange.start < 0 || glyphRange.end <= glyphRange.start ||
    span.glyphs.length === 0
  ) return false;

  let previousEnd: number | null = null;
  for (const glyph of span.glyphs) {
    if (
      !Number.isSafeInteger(glyph.glyphIndex) ||
      !Number.isSafeInteger(glyph.sourceCodeStart) ||
      !Number.isSafeInteger(glyph.sourceCodeEnd) ||
      glyph.sourceCodeStart < 0 ||
      glyph.sourceCodeEnd <= glyph.sourceCodeStart ||
      (previousEnd !== null && glyph.sourceCodeStart !== previousEnd)
    ) return false;
    previousEnd = glyph.sourceCodeEnd;
  }
  return glyphRange.end <= span.glyphs.length;
}

function derivedReadOnlyReasons(span: AnalysedSpan): CapabilityReason[] {
  const output = span.capability.kind === 'readOnly'
    ? span.capability.reasons.filter((reason) => READ_ONLY_REASONS.has(reason))
    : [];
  if (span.resource.referenceCount > 1) output.push('sharedResource');
  if (span.resource.writingMode !== 0) output.push('unsupportedEncoding');
  if (
    !finiteBounds(span.bounds) ||
    !span.baseline.every(Number.isFinite) ||
    !finiteMatrix(span.textMatrix) ||
    !finiteMatrix(span.renderMatrix)
  ) output.push('ambiguousTransform');
  return output;
}

export function classifyBaseline(span: AnalysedSpan): Capability {
  const readOnly = derivedReadOnlyReasons(span);
  if (span.unicode === null) readOnly.push('unsupportedEncoding');

  if (
    span.resource.writingMode !== 0 ||
    readOnly.some((reason) => READ_ONLY_REASONS.has(reason))
  ) {
    return immutableCapability('readOnly', readOnly);
  }
  if (!exactExcisionIsProvable(span)) {
    return immutableCapability('readOnly', ['unsupportedEncoding']);
  }
  if (span.unicode === null) {
    return immutableCapability('replacementWithSubstitution', [
      'substituteFontRequired',
      'unsupportedEncoding',
    ]);
  }
  const baseFont = span.resource.fontBaseName.replace(/^[A-Z]{6}\+/, '');
  if (
    (span.resource.fontSubtype === 'Type0' && span.resource.fontEmbedded) ||
    !STANDARD_14_FONTS.has(baseFont)
  ) {
    return immutableCapability('replacementWithSubstitution', ['substituteFontRequired']);
  }
  return immutableCapability('safeReplacement', ['supportedExistingFont']);
}

function replacementResult(
  kind: Capability['kind'],
  values: Iterable<CapabilityReason>,
  normalisedReplacement: string,
  canApply: boolean,
  substitutionAccepted: boolean,
): ReplacementClassification {
  return Object.freeze({
    kind,
    reasons: reasons(values),
    normalisedReplacement,
    canApply,
    substitutionAccepted,
  });
}

export function classifyReplacement(
  span: AnalysedSpan,
  replacement: string,
  fonts: ReplacementFontEvidence,
): ReplacementClassification {
  const normalisedReplacement = replacement.normalize('NFC');
  const baseline = classifyBaseline(span);
  if (baseline.kind === 'readOnly') {
    return replacementResult(
      'readOnly',
      baseline.reasons,
      normalisedReplacement,
      false,
      fonts.acceptSubstitution,
    );
  }

  if (!finiteBounds(fonts.replacementBounds)) {
    return replacementResult(
      'readOnly',
      ['ambiguousTransform'],
      normalisedReplacement,
      false,
      fonts.acceptSubstitution,
    );
  }
  if (
    fonts.replacementBounds.width > span.bounds.width ||
    fonts.replacementBounds.height > span.bounds.height
  ) {
    return replacementResult(
      'readOnly',
      ['replacementOverflow'],
      normalisedReplacement,
      false,
      fonts.acceptSubstitution,
    );
  }
  if (fonts.existingFontCanEncode) {
    return replacementResult(
      'safeReplacement',
      ['supportedExistingFont'],
      normalisedReplacement,
      true,
      fonts.acceptSubstitution,
    );
  }
  if (!fonts.substituteFontAvailable) {
    return replacementResult(
      'readOnly',
      ['unsupportedEncoding'],
      normalisedReplacement,
      false,
      fonts.acceptSubstitution,
    );
  }
  if (!fonts.substituteFontEmbeddable) {
    return replacementResult(
      'readOnly',
      ['fontEmbeddingProhibited'],
      normalisedReplacement,
      false,
      fonts.acceptSubstitution,
    );
  }
  return replacementResult(
    'replacementWithSubstitution',
    ['substituteFontRequired'],
    normalisedReplacement,
    fonts.acceptSubstitution,
    fonts.acceptSubstitution,
  );
}
