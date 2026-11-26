import { describe, expect, it } from 'vitest';

import {
  ENGINE_OPERATIONS,
  transferListForRequest,
  transferListForResponse,
  type EngineRequest,
  type EngineResponse,
} from '../src/index';

describe('worker protocol contracts', () => {
  it('round-trips every M0 request through structured clone', () => {
    const style = {
      fontResourceName: 'F1',
      fontBaseName: 'Noto Sans',
      fontSize: 12,
      horizontalScaling: 100,
      characterSpacing: 0,
      wordSpacing: 0,
      rise: 0,
      renderingMode: 0,
      fillColour: { colourSpace: 'DeviceGray' as const, components: [0] },
      strokeColour: { colourSpace: 'DeviceGray' as const, components: [0] },
      fontWeight: 400,
      italicAngle: 0,
    };
    const richPayload = {
      selection: { lineKey: 'line-1', anchorGlyphIndex: 0, focusGlyphIndex: 2 },
      runs: [{
        text: 'New',
        style,
        fontId: 'font:abc',
        fontIntent: 'preserve-source' as const,
        decorations: { underline: true, strikethrough: true },
      }],
      allowedRegion: { x: 10, y: 20, width: 100, height: 20 },
      substitutionConsents: ['font:abc'],
    };
    const requests: EngineRequest[] = [
      { requestId: 'r0', operation: 'ping', payload: null },
      {
        requestId: 'r1',
        operation: 'registerFont',
        payload: {
          source: 'upload',
          fileName: 'font.ttf',
          bytes: new Uint8Array([4, 5, 6]).buffer,
        },
      },
      {
        requestId: 'r2',
        operation: 'openDocument',
        payload: { bytes: new Uint8Array([1, 2, 3]).buffer },
      },
      {
        requestId: 'r3',
        operation: 'inspectDocumentFonts',
        documentId: 'd1',
        revision: 0,
        payload: null,
      },
      {
        requestId: 'r4',
        operation: 'analysePage',
        documentId: 'd1',
        revision: 0,
        payload: { pageIndex: 0 },
      },
      {
        requestId: 'r5',
        operation: 'previewReplacement',
        documentId: 'd1',
        revision: 0,
        payload: { spanKey: 'span-1', replacement: 'New', acceptSubstitution: false },
      },
      {
        requestId: 'r6',
        operation: 'applyReplacement',
        documentId: 'd1',
        revision: 0,
        preconditions: {
          spanKey: 'span-1',
          expectedOperatorDigest: 'sha256:operator',
          expectedGlyphText: 'Old',
          expectedNormalisedReplacement: 'New',
          expectedSubstitutionAccepted: true,
        },
        payload: { spanKey: 'span-1', replacement: 'New', acceptSubstitution: true },
      },
      {
        requestId: 'r7',
        operation: 'previewRichReplacement',
        documentId: 'd1',
        revision: 0,
        payload: richPayload,
      },
      {
        requestId: 'r8',
        operation: 'applyRichReplacement',
        documentId: 'd1',
        revision: 0,
        preconditions: {
          selectionKey: 'selection-1',
          expectedCommandHash: 'sha256:command',
          slices: [{
            addressKey: 'address-1',
            expectedOperatorDigest: 'sha256:operator',
            expectedGlyphText: 'Old',
          }],
          decorations: [],
        },
        payload: richPayload,
      },
      {
        requestId: 'r9',
        operation: 'validateCandidate',
        documentId: 'd1',
        revision: 0,
        payload: { candidateId: 'candidate-1' },
      },
      {
        requestId: 'r10',
        operation: 'validateExport',
        documentId: 'd1',
        revision: 1,
        payload: null,
      },
      {
        requestId: 'r11',
        operation: 'exportDocument',
        documentId: 'd1',
        revision: 1,
        preconditions: { validatedCandidateHash: 'sha256:candidate' },
        payload: null,
      },
      {
        requestId: 'r12',
        operation: 'exportPositionedImages',
        documentId: 'd1',
        revision: 1,
        payload: {
          images: [{
            pageIndex: 0,
            bounds: { x: 10, y: 20, width: 30, height: 40 },
            format: 'png',
            bytes: new Uint8Array([7, 8, 9]),
          }],
        },
      },
      {
        requestId: 'r13',
        operation: 'closeDocument',
        documentId: 'd1',
        revision: 1,
        payload: null,
      },
    ];

    expect(requests.map(({ operation }) => operation)).toEqual(
      ENGINE_OPERATIONS,
    );
    for (const request of requests) {
      expect(structuredClone(request)).toEqual(request);
    }
  });

  it('transfers only owned binary buffers', () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const openRequest: EngineRequest = {
      requestId: 'r1',
      operation: 'openDocument',
      payload: { bytes },
    };
    const exportResponse: EngineResponse = {
      requestId: 'r2',
      operation: 'exportDocument',
      ok: true,
      value: { bytes },
    };
    const registerRequest: EngineRequest = {
      requestId: 'r-font',
      operation: 'registerFont',
      payload: { source: 'local', fileName: 'font.ttf', bytes },
    };
    const imageBytes = new Uint8Array([4, 5, 6]);
    const sharedBackingBytes = Uint8Array.of(0, 4, 5, 6, 0);
    const positionedImagesRequest: EngineRequest = {
      requestId: 'r-images',
      operation: 'exportPositionedImages',
      documentId: 'd1',
      revision: 1,
      payload: {
        images: [{
          pageIndex: 0,
          bounds: { x: 1, y: 2, width: 3, height: 4 },
          format: 'png',
          bytes: imageBytes,
        }],
      },
    };
    const partialImageRequest: EngineRequest = {
      ...positionedImagesRequest,
      payload: {
        images: [{
          ...positionedImagesRequest.payload.images[0]!,
          bytes: sharedBackingBytes.subarray(1, 4),
        }],
      },
    };
    const positionedImagesResponse: EngineResponse = {
      requestId: 'r-images-result',
      operation: 'exportPositionedImages',
      ok: true,
      value: { bytes },
    };

    expect(transferListForRequest(openRequest)).toEqual([bytes]);
    expect(transferListForRequest(registerRequest)).toEqual([bytes]);
    expect(transferListForRequest(positionedImagesRequest)).toEqual([imageBytes.buffer]);
    expect(transferListForRequest(partialImageRequest)).toEqual([]);
    expect(sharedBackingBytes).toEqual(Uint8Array.of(0, 4, 5, 6, 0));
    expect(transferListForResponse(exportResponse)).toEqual([bytes]);
    expect(transferListForResponse(positionedImagesResponse)).toEqual([bytes]);
    const inventoryResponse: EngineResponse = {
      requestId: 'r-fonts',
      operation: 'inspectDocumentFonts',
      ok: true,
      value: [{ name: 'DejaVuSans', reason: 'embedded-not-reusable' }],
    };
    expect(structuredClone(inventoryResponse)).toEqual(inventoryResponse);
    expect(transferListForResponse(inventoryResponse)).toEqual([]);
    expect(
      transferListForRequest({
        requestId: 'r0',
        operation: 'ping',
        payload: null,
      }),
    ).toEqual([]);
  });

  it('round-trips authoritative page-space metadata', () => {
    const response: EngineResponse = {
      requestId: 'r-page',
      operation: 'analysePage',
      ok: true,
      value: {
        pageIndex: 0,
        pageSpace: {
          mediaBox: [0, 0, 612, 792],
          cropBox: [0, 0, 612, 792],
          rotate: 0,
          userUnit: 1,
        },
        spans: [],
        spanKeys: [],
        textLayout: {
          pageIndex: 0,
          lines: [],
          groups: [],
          decorationWarnings: [],
          eligibleSourceGlyphCount: 0,
        },
      },
    };

    expect(structuredClone(response)).toEqual(response);
  });
});
