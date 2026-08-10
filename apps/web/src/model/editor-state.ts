import {
  ENGINE_ERROR_CODES,
  type AnalysedSpan,
  type CanonicalBounds,
  type CapabilityReason,
  type DocumentEditingFont,
  type EngineErrorCode,
  type FontDescriptor,
  type FontMatchKind,
  type TextSelection,
} from '@pdf-editor/pdf-engine';
import type {
  AnalysePageResult,
  RichReplacementPreviewResult,
  ReplacementPreviewResult,
} from '@pdf-editor/worker-protocol';

import type { EditorRichTextRun } from '../editing/rich-text-buffer';

export const CAPABILITY_REASON_COPY: Record<CapabilityReason, string> = {
  supportedExistingFont: 'The original font can represent this replacement.',
  substituteFontRequired: 'The original font cannot encode this replacement. PDF-Scrubber will embed Noto Sans, so appearance and spacing may change.',
  replacementOverflow: 'This replacement does not fit the selected text bounds. Use shorter text.',
  unsupportedEncoding: 'PDF-Scrubber cannot prove how this text maps to editable characters.',
  ambiguousTransform: 'PDF-Scrubber cannot prove this text’s position and transformation safely.',
  sharedResource: 'This text is reused elsewhere in the PDF and cannot be changed independently.',
  outlinedText: 'This content is drawn as outlines rather than editable text.',
  scannedContent: 'This page contains scanned content rather than editable text.',
  fontEmbeddingProhibited: 'The required font cannot be embedded in this PDF.',
  unsupportedOperator: 'This text uses a PDF operation PDF-Scrubber does not edit safely.',
  malformedContent: 'This text belongs to malformed PDF content and cannot be changed safely.',
};

export type EditorPhase =
  | 'empty'
  | 'opening'
  | 'ready'
  | 'analysing'
  | 'previewing'
  | 'applying'
  | 'recovering'
  | 'recoverableError'
  | 'fatalError';

export type FontInventoryState = 'scanning' | 'ready' | 'failed';

export type EditorTool = 'select' | 'pan';
export type FitMode = 'page' | 'width' | 'custom';

export type EditorError = Readonly<{
  code: string;
  message: string;
  action: 'chooseAnother' | 'selectAgain' | 'reset' | 'retry';
}>;

export type EditorSpanSelection = Readonly<{
  kind: 'span';
  spanKey: string;
  span: AnalysedSpan;
}>;

export type EditorTextSelection = Readonly<{
  kind: 'text';
  groupKey: string | null;
  textSelection: TextSelection;
}>;

export type EditorSelection = EditorSpanSelection | EditorTextSelection;

export type EditorRichFontStatus = Readonly<{
  key: string;
  requestedName: string | null;
  fontId: string | null;
  actualName: string | null;
  source: FontDescriptor['source'] | null;
  matchKind: FontMatchKind | 'unavailable';
  reasons: readonly string[];
}>;

export type EditorRichState = Readonly<{
  runs: readonly EditorRichTextRun[];
  allowedRegion: CanonicalBounds;
  maxAllowedWidth: number;
  substitutionConsents: readonly string[];
  fontStatuses: readonly EditorRichFontStatus[];
  preview: RichReplacementPreviewResult | null;
}>;

export type EditorSnapshot = Readonly<{
  phase: EditorPhase;
  generation: number;
  fileName: string | null;
  pageIndex: number;
  pageCount: number;
  zoom: number;
  fitMode: FitMode;
  tool: EditorTool;
  showOverlays: boolean;
  analysis: AnalysePageResult | null;
  fonts: readonly FontDescriptor[];
  fontInventoryState: FontInventoryState;
  editingFonts: readonly DocumentEditingFont[];
  selection: EditorSelection | null;
  replacement: string;
  acceptSubstitution: boolean;
  preview: ReplacementPreviewResult | null;
  richEditor: EditorRichState | null;
  hasEdits: boolean;
  downloadAvailable: boolean;
  displayVersion: number;
  status: string;
  error: EditorError | null;
}>;

const ERROR_PRESENTATION: Record<
  EngineErrorCode,
  Omit<EditorError, 'code'>
> = {
  UNSUPPORTED_DOCUMENT: {
    message: 'This release cannot open encrypted or unsupported PDFs.',
    action: 'chooseAnother',
  },
  MALFORMED_INPUT: {
    message: 'This PDF could not be read safely.',
    action: 'chooseAnother',
  },
  RESOURCE_LIMIT: {
    message: 'This PDF exceeds a supported processing limit.',
    action: 'chooseAnother',
  },
  READ_ONLY_SPAN: {
    message: 'This text cannot be changed safely. Choose another text span.',
    action: 'selectAgain',
  },
  FONT_UNAVAILABLE: {
    message: 'The replacement font is unavailable.',
    action: 'retry',
  },
  FONT_EMBEDDING_PROHIBITED: {
    message: 'This font does not permit the required embedding.',
    action: 'selectAgain',
  },
  REPLACEMENT_OVERFLOW: {
    message: 'This replacement does not fit. Use shorter text.',
    action: 'retry',
  },
  STALE_REVISION: {
    message: 'The page changed. Select the text again.',
    action: 'selectAgain',
  },
  VALIDATION_FAILURE: {
    message: 'Replacement was not applied; the last validated document was restored.',
    action: 'reset',
  },
  INTERNAL_FAILURE: {
    message: 'The PDF worker stopped safely. Reset or reopen the document.',
    action: 'reset',
  },
};

type ErrorLike = Readonly<{
  code?: unknown;
  name?: unknown;
  details?: Readonly<Record<string, unknown>>;
}>;

function finiteLimit(details: ErrorLike['details']): number | null {
  const limit = details?.limit;
  return typeof limit === 'number' && Number.isFinite(limit) && limit >= 0
    ? limit
    : null;
}

function formattedResourceLimit(details: ErrorLike['details']): string | null {
  const resource = details?.resource;
  const limit = finiteLimit(details);
  if (typeof resource !== 'string' || limit === null) return null;
  switch (resource) {
    case 'fileBytes':
      return `This PDF exceeds the ${limit / (1024 * 1024)} MiB file limit.`;
    case 'indirectObjects':
      return `This PDF exceeds the ${limit.toLocaleString('en-US')} indirect-object limit.`;
    case 'nestingDepth':
      return `This PDF exceeds the nesting-depth limit of ${limit}.`;
    case 'decodedStreamBytes':
      return `This PDF contains a decoded stream larger than ${limit / (1024 * 1024)} MiB.`;
    case 'operations':
      return `This PDF contains more than ${limit.toLocaleString('en-US')} operations in one content stream.`;
    case 'imagePixels':
      return `This PDF requires rendering more than ${limit / 1_000_000} megapixels on one page.`;
    case 'processingTime':
      return `PDF processing exceeded the ${limit / 1000}-second limit.`;
    default:
      return null;
  }
}

export function editorError(error: unknown): EditorError {
  const candidate = error !== null && typeof error === 'object'
    ? error as ErrorLike
    : {};
  const code: EngineErrorCode = candidate.name === 'ValidationRejectedError'
    ? 'VALIDATION_FAILURE'
    : typeof candidate.code === 'string'
      && ENGINE_ERROR_CODES.includes(candidate.code as EngineErrorCode)
      ? candidate.code as EngineErrorCode
      : 'INTERNAL_FAILURE';
  const presentation = ERROR_PRESENTATION[code];
  const resourceMessage = code === 'RESOURCE_LIMIT'
    ? formattedResourceLimit(candidate.details)
    : null;
  const rawLimit = finiteLimit(candidate.details);
  const limitSuffix = code === 'RESOURCE_LIMIT' && resourceMessage === null && rawLimit !== null
    ? ` Limit: ${rawLimit}.`
    : '';

  return Object.freeze({
    code,
    message: resourceMessage ?? `${presentation.message}${limitSuffix}`,
    action: presentation.action,
  });
}
