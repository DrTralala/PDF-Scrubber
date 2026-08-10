import {
  ENGINE_ERROR_CODES,
  analysePage,
  ObjectStore,
  PdfEngineSessions,
  PROVISIONAL_LIMITS,
  shapeText,
  spanAddressKey,
  validateCandidate,
  type EngineErrorDescriptor,
  type EngineLimits,
  type SubstituteFontAsset,
} from '@pdf-editor/pdf-engine';
import {
  transferListForResponse,
  type EngineRequest,
  type EngineResponse,
} from '@pdf-editor/worker-protocol';

type ShapeRequest = Readonly<{
  requestId: string;
  operation: 'shapeText';
  payload: Readonly<{ fontBytes: ArrayBuffer; text: string }>;
}>;

type ResourceProbeRequest = Readonly<{
  requestId: string;
  operation: 'resourceProbe';
  payload: Readonly<{
    bytes: ArrayBuffer;
    limits: EngineLimits;
    analyse: boolean;
    validate?: boolean;
  }>;
}>;

const fontUrl = new URL(
  '../../../node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff',
  import.meta.url,
);
const boldFontUrl = new URL(
  '../../../node_modules/@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff',
  import.meta.url,
);

const sessions = new PdfEngineSessions({
  limits: PROVISIONAL_LIMITS,
  substituteFont: async (): Promise<SubstituteFontAsset> => {
    const buffer = await fetch(fontUrl).then((response) => response.arrayBuffer());
    return Object.freeze({
      bytes: new Uint8Array(buffer as ArrayBuffer),
      family: 'Noto Sans',
      version: '5.3.0',
      licence: 'OFL-1.1',
      source: '@fontsource/noto-sans',
    });
  },
  additionalBundledFonts: async () => {
    const buffer = await fetch(boldFontUrl).then((response) => response.arrayBuffer());
    return Object.freeze([Object.freeze({
      fileName: 'NotoSans-Bold.woff',
      bytes: new Uint8Array(buffer),
    })]);
  },
});

function errorDescriptor(error: unknown): EngineErrorDescriptor {
  if (error instanceof Error) {
    const candidate = error as Error & Partial<EngineErrorDescriptor>;
    if (
      typeof candidate.code === 'string' &&
      ENGINE_ERROR_CODES.includes(candidate.code as (typeof ENGINE_ERROR_CODES)[number])
    ) {
      return candidate.details === undefined
        ? { code: candidate.code as EngineErrorDescriptor['code'], message: candidate.message }
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

self.onmessage = async ({ data }: MessageEvent<
  EngineRequest | ShapeRequest | ResourceProbeRequest
>) => {
  if (data.operation === 'shapeText') {
    try {
      const run = await shapeText({
        fontBytes: new Uint8Array(data.payload.fontBytes),
        text: data.payload.text,
      });
      self.postMessage({ requestId: data.requestId, ok: true, value: run });
    } catch (error) {
      self.postMessage({ requestId: data.requestId, ok: false, error: errorDescriptor(error) });
    }
    return;
  }
  if (data.operation === 'resourceProbe') {
    try {
      const started = performance.now();
      const store = await ObjectStore.open(new Uint8Array(data.payload.bytes), data.payload.limits);
      const analysedSpans = data.payload.analyse
        ? (await analysePage(store, 0)).spans.length
        : 0;
      if (data.payload.validate === true) {
        const validation = await validateCandidate(
          new Uint8Array(data.payload.bytes),
          {
            pageIndex: 0,
            targetBounds: { x: 0, y: 0, width: 1, height: 1 },
            oldText: '',
            newText: '',
            expectedOldTextOutsideTarget: 0,
          },
          undefined,
          data.payload.limits,
        );
        if (!validation.valid) {
          const error = Object.assign(new Error('Resource probe validation failed'), {
            code: validation.error?.code === 'RESOURCE_LIMIT'
              ? 'RESOURCE_LIMIT'
              : 'VALIDATION_FAILURE',
          });
          throw error;
        }
      }
      self.postMessage({
        requestId: data.requestId,
        ok: true,
        value: {
          ...store.resourceUsage(),
          analysedSpans,
          durationMs: performance.now() - started,
        },
      });
    } catch (error) {
      self.postMessage({ requestId: data.requestId, ok: false, error: errorDescriptor(error) });
    }
    return;
  }

  try {
    switch (data.operation) {
      case 'ping':
        post({
          requestId: data.requestId,
          operation: 'ping',
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
