import type {
  CapabilityKind,
  CapabilityReason,
  EngineErrorCode,
} from '@pdf-editor/pdf-engine';

export const MANDATORY_CLASSES = [
  'tj',
  'tjArray',
  'singleQuote',
  'doubleQuote',
  'textState',
  'subsetFont',
  'ligature',
  'combiningMarks',
  'bidirectional',
  'verticalWriting',
  'rotation',
  'cropBox',
  'userUnit',
  'formXObject',
  'nestedFormXObject',
  'sharedFormXObject',
  'customEncoding',
  'missingToUnicode',
  'incorrectToUnicode',
  'pdfUaMarker',
  'pdfAMarker',
  'signatureMarker',
  'encryptionMarker',
  'malformedStream',
  'decompressionAbuse',
  'addedTextControl',
  'addedImageControl',
  'wkhtmltopdfRichLine',
] as const;

export type CorpusClass = (typeof MANDATORY_CLASSES)[number];

export type ExpectedBaseline =
  | Readonly<{
      kind: 'capability';
      capability: CapabilityKind;
      reason?: CapabilityReason;
    }>
  | Readonly<{ kind: 'rejected'; error: EngineErrorCode }>
  | Readonly<{ kind: 'crossConsumerControl' }>;

export type DisclosureCode = 'PDF_UA' | 'PDF_A' | 'SIGNATURE';

export type AssetProvenance = Readonly<{
  package: '@fontsource/noto-sans' | '@fontsource/noto-sans-arabic';
  version: '5.3.0';
  licence: 'OFL-1.1';
}>;

export type EligibleTextExpectation = Readonly<{
  sourceGlyphCount: number;
  groups: readonly Readonly<{
    text: string;
    styleRunCount: number;
    replacementRuns: readonly string[];
  }>[];
  excludedGraphicCount: number;
}>;

export type CorpusCase = Readonly<{
  id: string;
  source: 'synthetic';
  generatorVersion: 1;
  classes: readonly CorpusClass[];
  targetPage: number;
  targetUnicode: string;
  replacementUnicode: string;
  expected: ExpectedBaseline;
  expectedDisclosureCodes: readonly DisclosureCode[];
  assets: readonly AssetProvenance[];
  eligibleText?: EligibleTextExpectation;
}>;

export type BuiltCorpusCase = CorpusCase & Readonly<{ sha256: string }>;
