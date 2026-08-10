import type {
  AnalysedSpan,
  AnalysedTextLayout,
  Capability,
  EngineErrorDescriptor,
  DocumentEditingFont,
  FontDescriptor,
  FontMatchKind,
  FontSourceKind,
  PageSpace,
  SessionRichReplacementPayload,
  SessionRichReplacementPreconditions,
  SessionReplacementPreconditions,
} from '@pdf-editor/pdf-engine';

export const ENGINE_OPERATIONS = [
  'ping',
  'registerFont',
  'openDocument',
  'inspectDocumentFonts',
  'analysePage',
  'previewReplacement',
  'applyReplacement',
  'previewRichReplacement',
  'applyRichReplacement',
  'validateCandidate',
  'validateExport',
  'exportDocument',
  'closeDocument',
] as const;

export type EngineOperation = (typeof ENGINE_OPERATIONS)[number];

type RequestBase<Operation extends EngineOperation, Payload> = Readonly<{
  requestId: string;
  operation: Operation;
  payload: Payload;
}>;

type DocumentRequest<Operation extends EngineOperation, Payload> = RequestBase<
  Operation,
  Payload
> &
  Readonly<{
    documentId: string;
    revision: number;
  }>;

export type ReplacementPayload = Readonly<{
  spanKey: string;
  replacement: string;
  acceptSubstitution: boolean;
}>;

export type ReplacementPreconditions = SessionReplacementPreconditions;
export type RichReplacementPayload = SessionRichReplacementPayload;
export type RichReplacementPreconditions = SessionRichReplacementPreconditions;

export type EngineRequest =
  | RequestBase<'ping', null>
  | RequestBase<'registerFont', Readonly<{
      source: Extract<FontSourceKind, 'local' | 'upload'>;
      fileName: string;
      bytes: ArrayBuffer;
    }>>
  | RequestBase<'openDocument', Readonly<{ bytes: ArrayBuffer }>>
  | DocumentRequest<'inspectDocumentFonts', null>
  | DocumentRequest<'analysePage', Readonly<{ pageIndex: number }>>
  | DocumentRequest<'previewReplacement', ReplacementPayload>
  | (DocumentRequest<'applyReplacement', ReplacementPayload> &
      Readonly<{ preconditions: ReplacementPreconditions }>)
  | DocumentRequest<'previewRichReplacement', RichReplacementPayload>
  | (DocumentRequest<'applyRichReplacement', RichReplacementPayload> &
      Readonly<{ preconditions: RichReplacementPreconditions }>)
  | DocumentRequest<'validateCandidate', Readonly<{ candidateId: string }>>
  | DocumentRequest<'validateExport', null>
  | (DocumentRequest<'exportDocument', null> &
      Readonly<{
        preconditions: Readonly<{ validatedCandidateHash: string }>;
      }>)
  | DocumentRequest<'closeDocument', null>;

export type OpenDocumentResult = Readonly<{
  documentId: string;
  fingerprint: string;
  revision: 0;
  fonts: readonly FontDescriptor[];
}>;

export type InspectDocumentFontsResult = readonly DocumentEditingFont[];

export type AnalysePageResult = Readonly<{
  pageIndex: number;
  pageSpace: PageSpace;
  spans: readonly AnalysedSpan[];
  spanKeys: readonly string[];
  textLayout: AnalysedTextLayout;
}>;

export type ReplacementPreviewResult = Readonly<{
  capability: Capability;
  normalisedReplacement: string;
  canApply: boolean;
  substitutionAccepted: boolean;
  preconditions: ReplacementPreconditions;
}>;

export type ApplyReplacementResult = Readonly<{
  candidateId: string;
  revision: number;
  candidateHash: string;
}>;

export type RichReplacementPreviewResult = Readonly<{
  commandHash: string;
  nextRevision: number;
  selectionKey: string;
  replacement: string;
  replacementBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  allowedRegion: Readonly<{ x: number; y: number; width: number; height: number }>;
  fits: boolean;
  requiredSubstitutionConsents: readonly string[];
  fontMatches: readonly Readonly<{
    fontId: string;
    matchKind: FontMatchKind;
  }>[];
  preconditions: RichReplacementPreconditions;
}>;

export type ApplyRichReplacementResult = Readonly<{
  candidateId: string;
  revision: number;
  candidateHash: string;
  commandHash: string;
  fontResourceNames: readonly string[];
  replacementBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
}>;

export type ValidationEvidence = Readonly<{
  candidateId: string;
  candidateHash: string;
  valid: boolean;
  checks: readonly string[];
  revision: number;
}>;

export type EngineSuccessResponse =
  | Readonly<{
      requestId: string;
      operation: 'ping';
      ok: true;
      value: 'worker:ready';
    }>
  | Readonly<{
      requestId: string;
      operation: 'registerFont';
      ok: true;
      value: FontDescriptor;
    }>
   | Readonly<{
       requestId: string;
       operation: 'openDocument';
       ok: true;
       value: OpenDocumentResult;
     }>
   | Readonly<{
       requestId: string;
       operation: 'inspectDocumentFonts';
       ok: true;
       value: InspectDocumentFontsResult;
     }>
   | Readonly<{
       requestId: string;
       operation: 'analysePage';
       ok: true;
       value: AnalysePageResult;
     }>
  | Readonly<{
      requestId: string;
      operation: 'previewReplacement';
      ok: true;
      value: ReplacementPreviewResult;
    }>
  | Readonly<{
      requestId: string;
      operation: 'applyReplacement';
      ok: true;
      value: ApplyReplacementResult;
    }>
  | Readonly<{
      requestId: string;
      operation: 'previewRichReplacement';
      ok: true;
      value: RichReplacementPreviewResult;
    }>
  | Readonly<{
      requestId: string;
      operation: 'applyRichReplacement';
      ok: true;
      value: ApplyRichReplacementResult;
    }>
  | Readonly<{
      requestId: string;
      operation: 'validateCandidate';
      ok: true;
      value: ValidationEvidence;
    }>
  | Readonly<{
      requestId: string;
      operation: 'validateExport';
      ok: true;
      value: ValidationEvidence;
    }>
  | Readonly<{
      requestId: string;
      operation: 'exportDocument';
      ok: true;
      value: Readonly<{ bytes: ArrayBuffer }>;
    }>
  | Readonly<{
      requestId: string;
      operation: 'closeDocument';
      ok: true;
      value: null;
    }>;

export type EngineFailureResponse = Readonly<{
  requestId: string;
  operation: EngineOperation;
  ok: false;
  error: EngineErrorDescriptor;
}>;

export type EngineResponse = EngineSuccessResponse | EngineFailureResponse;
