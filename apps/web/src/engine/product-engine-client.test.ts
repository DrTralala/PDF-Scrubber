import type {
  EngineOperation,
  ReplacementPreconditions,
} from '@pdf-editor/worker-protocol';
import { describe, expect, it } from 'vitest';

import { ProductEngineClient } from './product-engine-client';
import type { EngineTransport, RequestEnvelope } from './worker-client';

class ScriptedTransport implements EngineTransport {
  readonly calls: Array<{
    operation: EngineOperation;
    payload: unknown;
    transfer: Transferable[];
    envelope: RequestEnvelope;
  }> = [];

  constructor(private readonly replies: unknown[]) {}

  async request<T>(
    operation: EngineOperation,
    payload: unknown,
    transfer: Transferable[],
    envelope: RequestEnvelope,
  ): Promise<T> {
    this.calls.push({ operation, payload, transfer, envelope });
    return this.replies.shift() as T;
  }

  terminate(): void {}
}

const preconditions: ReplacementPreconditions = {
  spanKey: 'span',
  expectedOperatorDigest: 'op',
  expectedGlyphText: 'Old',
  expectedNormalisedReplacement: 'New',
  expectedSubstitutionAccepted: true,
};

describe('ProductEngineClient', () => {
  it('requests document fonts with the current revision and no transferables', async () => {
    const fonts = [{ name: 'DejaVuSans', reason: 'embedded-not-reusable' }] as const;
    const transport = new ScriptedTransport([
      { documentId: 'd1', fingerprint: 'abc', revision: 0, fonts: [] },
      fonts,
    ]);
    const client = new ProductEngineClient(transport);
    await client.open(Uint8Array.of(1));

    await expect(client.inspectDocumentFonts()).resolves.toEqual(fonts);
    expect(transport.calls[1]).toEqual({
      operation: 'inspectDocumentFonts',
      payload: null,
      transfer: [],
      envelope: { documentId: 'd1', revision: 0 },
    });
  });

  it('copies source bytes and completes the atomic apply, validate, and export sequence', async () => {
    const exported = new Uint8Array([9, 8, 7]).buffer;
    const transport = new ScriptedTransport([
      { documentId: 'd1', fingerprint: 'abc', revision: 0, fonts: [] },
      { candidateId: 'pending-1', revision: 1, candidateHash: 'candidate' },
      { candidateId: 'pending-1', candidateHash: 'candidate', valid: true, checks: ['ok'], revision: 1 },
      { bytes: exported },
    ]);
    const client = new ProductEngineClient(transport);
    const source = new Uint8Array([1, 2, 3]);

    await client.open(source);

    expect(source).toEqual(Uint8Array.of(1, 2, 3));
    const openPayload = transport.calls[0]!.payload as { bytes: ArrayBuffer };
    expect(openPayload.bytes).not.toBe(source.buffer);
    expect(transport.calls[0]!.transfer).toEqual([openPayload.bytes]);

    const result = await client.applyValidated({
      spanKey: 'span',
      replacement: 'New',
      acceptSubstitution: true,
      preconditions,
    });

    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'openDocument',
      'applyReplacement',
      'validateCandidate',
      'exportDocument',
    ]);
    expect(result).toEqual({
      revision: 1,
      candidateHash: 'candidate',
      bytes: new Uint8Array([9, 8, 7]),
    });
    expect(result.bytes.buffer).not.toBe(exported);
    expect(client.revision).toBe(1);
  });

  it('never exports a candidate rejected by runtime validation', async () => {
    const transport = new ScriptedTransport([
      { documentId: 'd1', fingerprint: 'abc', revision: 0, fonts: [] },
      { candidateId: 'pending-1', revision: 1, candidateHash: 'bad' },
      {
        candidateId: 'pending-1',
        candidateHash: 'bad',
        valid: false,
        checks: ['old-text-present'],
        revision: 0,
      },
    ]);
    const client = new ProductEngineClient(transport);
    await client.open(Uint8Array.of(1));

    await expect(client.applyValidated({
      spanKey: 'span',
      replacement: 'New',
      acceptSubstitution: true,
      preconditions,
    })).rejects.toMatchObject({
      name: 'ValidationRejectedError',
      checks: ['old-text-present'],
    });

    expect(client.revision).toBe(0);
    expect(transport.calls.map(({ operation }) => operation)).not.toContain('exportDocument');
  });

  it('rejects validation evidence for a different candidate', async () => {
    const transport = new ScriptedTransport([
      { documentId: 'd1', fingerprint: 'abc', revision: 0, fonts: [] },
      { candidateId: 'pending-1', revision: 1, candidateHash: 'candidate' },
      {
        candidateId: 'pending-1',
        candidateHash: 'different',
        valid: true,
        checks: ['ok'],
        revision: 0,
      },
    ]);
    const client = new ProductEngineClient(transport);
    await client.open(Uint8Array.of(1));

    await expect(client.applyValidated({
      spanKey: 'span',
      replacement: 'New',
      acceptSubstitution: true,
      preconditions,
    })).rejects.toMatchObject({ name: 'ValidationRejectedError' });
    expect(transport.calls.map(({ operation }) => operation)).not.toContain('exportDocument');
    expect(client.revision).toBe(0);
  });

  it('copies and transfers registered font bytes', async () => {
    const transport = new ScriptedTransport([{
      id: 'font:abc',
      hash: 'abc',
      source: 'upload',
      fileName: 'font.ttf',
      byteLength: 3,
      inspection: {},
    }]);
    const client = new ProductEngineClient(transport);
    const source = Uint8Array.of(1, 2, 3);

    await client.registerFont('upload', 'font.ttf', source);

    const call = transport.calls[0]!;
    const payload = call.payload as { bytes: ArrayBuffer };
    expect(call.operation).toBe('registerFont');
    expect(call.transfer).toEqual([payload.bytes]);
    expect(payload.bytes).not.toBe(source.buffer);
    expect(source).toEqual(Uint8Array.of(1, 2, 3));
  });

  it('previews and atomically validates rich replacements', async () => {
    const richPayload = {
      selection: { lineKey: 'line-1', anchorGlyphIndex: 0, focusGlyphIndex: 2 },
      runs: [],
      allowedRegion: { x: 1, y: 2, width: 30, height: 10 },
      substitutionConsents: [],
    };
    const richPreconditions = {
      selectionKey: 'selection-1',
      expectedCommandHash: 'command-1',
      slices: [],
      decorations: [],
    };
    const transport = new ScriptedTransport([
      { documentId: 'd1', fingerprint: 'abc', revision: 0, fonts: [] },
      {
        commandHash: 'command-1',
        nextRevision: 1,
        selectionKey: 'selection-1',
        replacement: 'New',
        preconditions: richPreconditions,
      },
      {
        candidateId: 'pending-1',
        revision: 1,
        candidateHash: 'candidate',
        commandHash: 'command-1',
        fontResourceNames: ['M0R_abc_0'],
        replacementBounds: richPayload.allowedRegion,
      },
      {
        candidateId: 'pending-1',
        candidateHash: 'candidate',
        valid: true,
        checks: ['ok'],
        revision: 1,
      },
      { bytes: Uint8Array.of(7, 8, 9).buffer },
    ]);
    const client = new ProductEngineClient(transport);
    await client.open(Uint8Array.of(1));

    const preview = await client.previewRichReplacement(richPayload);
    const result = await client.applyRichValidated(richPayload, preview.preconditions);

    expect(transport.calls.map(({ operation }) => operation)).toEqual([
      'openDocument',
      'previewRichReplacement',
      'applyRichReplacement',
      'validateCandidate',
      'exportDocument',
    ]);
    expect(result).toMatchObject({ revision: 1, candidateHash: 'candidate' });
    expect(client.revision).toBe(1);
  });
});
