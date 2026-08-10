import notoSansUrl from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff?url';
import notoSansBoldUrl from '@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff?url';
import {
  ENGINE_ERROR_CODES,
  PdfEngineSessions,
  PROVISIONAL_LIMITS,
  spanAddressKey,
  validateCandidateAgainstSource,
  type EngineErrorDescriptor,
  type RuntimeValidationEvidence,
  type SubstituteFontAsset,
} from '@pdf-editor/pdf-engine';
import {
  transferListForResponse,
  type EngineRequest,
  type EngineResponse,
} from '@pdf-editor/worker-protocol';

let substituteFontPromise: Promise<SubstituteFontAsset> | undefined;
let additionalBundledFontsPromise: Promise<readonly Readonly<{
  fileName: string;
  bytes: Uint8Array;
}>[]> | undefined;

function substituteFont(): Promise<SubstituteFontAsset> {
  substituteFontPromise ??= fetch(notoSansUrl).then(async (response) => {
    if (!response.ok) {
      throw new Error('Bundled Noto Sans asset could not be loaded');
    }
    return Object.freeze({
      bytes: new Uint8Array(await response.arrayBuffer()),
      family: 'Noto Sans',
      version: '5.3.0',
      licence: 'OFL-1.1',
      source: '@fontsource/noto-sans',
    });
  });
  return substituteFontPromise;
}

function additionalBundledFonts(): Promise<readonly Readonly<{
  fileName: string;
  bytes: Uint8Array;
}>[]> {
  additionalBundledFontsPromise ??= fetch(notoSansBoldUrl).then(async (response) => {
    if (!response.ok) throw new Error('Bundled Noto Sans Bold asset could not be loaded');
    return Object.freeze([Object.freeze({
      fileName: 'NotoSans-Bold.woff',
      bytes: new Uint8Array(await response.arrayBuffer()),
    })]);
  });
  return additionalBundledFontsPromise;
}

const forceValidationRejection = import.meta.env.MODE === 'test'
  && self.name === 'pdf-scrubber-pdf-engine-test-reject-validation';
const validator = forceValidationRejection
  ? async (): Promise<RuntimeValidationEvidence> => ({
      consumer: 'pdfjs',
      valid: false,
      checks: ['forced-test-rejection'],
      extraction: {
        targetText: '',
        oldTextAbsentAtTarget: false,
        newTextPresentAtTarget: false,
        oldTextOutsideTargetCount: 0,
        outsideTextPreserved: true,
        items: [],
      },
      render: {
        dpi: 144,
        width: 1,
        height: 1,
        pageWidth: 1,
        pageHeight: 1,
        rgba: new Uint8Array(4),
      },
    })
  : validateCandidateAgainstSource;

const sessions = new PdfEngineSessions({
  limits: PROVISIONAL_LIMITS,
  substituteFont,
  additionalBundledFonts,
  validator,
});

function errorDescriptor(error: unknown): EngineErrorDescriptor {
  if (error instanceof Error) {
    const candidate = error as Error & Partial<EngineErrorDescriptor>;
    if (
      typeof candidate.code === 'string'
      && ENGINE_ERROR_CODES.includes(
        candidate.code as (typeof ENGINE_ERROR_CODES)[number],
      )
    ) {
      return candidate.details === undefined
        ? {
            code: candidate.code as EngineErrorDescriptor['code'],
            message: candidate.message,
          }
        : {
            code: candidate.code as EngineErrorDescriptor['code'],
            message: candidate.message,
            details: candidate.details,
          };
    }
    return { code: 'INTERNAL_FAILURE', message: candidate.message };
  }
  return { code: 'INTERNAL_FAILURE', message: 'Unknown worker failure' };
}

function post(response: EngineResponse): void {
  self.postMessage(response, { transfer: transferListForResponse(response) });
}

self.onmessage = async ({ data }: MessageEvent<EngineRequest>) => {
  try {
    switch (data.operation) {
      case 'ping':
        post({
          requestId: data.requestId,
          operation: data.operation,
          ok: true,
          value: 'worker:ready',
        });
        return;
      case 'registerFont': {
        const value = await sessions.registerFont({
          source: data.payload.source,
          fileName: data.payload.fileName,
          bytes: new Uint8Array(data.payload.bytes),
        });
        post({ requestId: data.requestId, operation: data.operation, ok: true, value });
        return;
      }
      case 'openDocument': {
        const value = await sessions.openDocument(new Uint8Array(data.payload.bytes));
        post({ requestId: data.requestId, operation: data.operation, ok: true, value });
        return;
      }
      case 'inspectDocumentFonts': {
        const value = await sessions.inspectDocumentFonts(data.documentId, data.revision);
        post({ requestId: data.requestId, operation: data.operation, ok: true, value });
        return;
      }
      case 'analysePage': {
        const page = await sessions.analysePage(
          data.documentId,
          data.revision,
          data.payload.pageIndex,
        );
        post({
          requestId: data.requestId,
          operation: data.operation,
          ok: true,
          value: {
            pageIndex: page.pageIndex,
            pageSpace: page.pageSpace,
            spans: page.spans,
            spanKeys: page.spans.map((span) => spanAddressKey(span.address)),
            textLayout: page.textLayout,
          },
        });
        return;
      }
      case 'previewReplacement': {
        const value = await sessions.previewReplacement(
          data.documentId,
          data.revision,
          data.payload.spanKey,
          data.payload.replacement,
          data.payload.acceptSubstitution,
        );
        post({ requestId: data.requestId, operation: data.operation, ok: true, value });
        return;
      }
      case 'applyReplacement': {
        const value = await sessions.applyReplacement(
          data.documentId,
          data.revision,
          data.payload.spanKey,
          data.payload.replacement,
          data.payload.acceptSubstitution,
          data.preconditions,
        );
        post({
          requestId: data.requestId,
          operation: data.operation,
          ok: true,
          value: {
            candidateId: value.candidateId,
            revision: value.revision,
            candidateHash: value.candidateHash,
          },
        });
        return;
      }
      case 'previewRichReplacement': {
        const value = await sessions.previewRichReplacement(
          data.documentId,
          data.revision,
          data.payload,
        );
        post({ requestId: data.requestId, operation: data.operation, ok: true, value });
        return;
      }
      case 'applyRichReplacement': {
        const value = await sessions.applyRichReplacement(
          data.documentId,
          data.revision,
          data.payload,
          data.preconditions,
        );
        post({ requestId: data.requestId, operation: data.operation, ok: true, value });
        return;
      }
      case 'validateCandidate': {
        const value = await sessions.validateCandidate(
          data.documentId,
          data.revision,
          data.payload.candidateId,
        );
        post({ requestId: data.requestId, operation: data.operation, ok: true, value });
        return;
      }
      case 'validateExport': {
        const value = await sessions.validateExport(data.documentId, data.revision);
        post({ requestId: data.requestId, operation: data.operation, ok: true, value });
        return;
      }
      case 'exportDocument': {
        const bytes = sessions.exportDocument(
          data.documentId,
          data.revision,
          data.preconditions.validatedCandidateHash,
        );
        post({
          requestId: data.requestId,
          operation: data.operation,
          ok: true,
          value: { bytes },
        });
        return;
      }
      case 'closeDocument':
        sessions.closeDocument(data.documentId, data.revision);
        post({
          requestId: data.requestId,
          operation: data.operation,
          ok: true,
          value: null,
        });
        return;
    }
  } catch (error) {
    post({
      requestId: data.requestId,
      operation: data.operation,
      ok: false,
      error: errorDescriptor(error),
    });
  }
};
