import type { FontDescriptor, FontSourceKind } from '@pdf-editor/pdf-engine';
import type {
  AnalysePageResult,
  ApplyRichReplacementResult,
  ApplyReplacementResult,
  InspectDocumentFontsResult,
  OpenDocumentResult,
  RichReplacementPayload,
  RichReplacementPreconditions,
  RichReplacementPreviewResult,
  ReplacementPayload,
  ReplacementPreconditions,
  ReplacementPreviewResult,
  ValidationEvidence,
} from '@pdf-editor/worker-protocol';

import type { EngineTransport } from './worker-client';

export type ValidatedApplyResult = Readonly<{
  revision: number;
  candidateHash: string;
  bytes: Uint8Array;
}>;

export class ValidationRejectedError extends Error {
  constructor(readonly checks: readonly string[]) {
    super('Runtime validation rejected the replacement');
    this.name = 'ValidationRejectedError';
  }
}

export class ProductEngineClient {
  #documentId: string | null = null;
  #revision: number | null = null;

  constructor(private readonly transport: EngineTransport) {}

  get revision(): number | null {
    return this.#revision;
  }

  async open(bytes: Uint8Array): Promise<OpenDocumentResult> {
    const ownedBytes = new Uint8Array(bytes);
    const result = await this.transport.request<OpenDocumentResult>(
      'openDocument',
      { bytes: ownedBytes.buffer },
      [ownedBytes.buffer],
      {},
    );
    this.#documentId = result.documentId;
    this.#revision = result.revision;
    return result;
  }

  analysePage(pageIndex: number): Promise<AnalysePageResult> {
    const { documentId, revision } = this.#session();
    return this.transport.request<AnalysePageResult>(
      'analysePage',
      { pageIndex },
      [],
      { documentId, revision },
    );
  }

  inspectDocumentFonts(): Promise<InspectDocumentFontsResult> {
    const { documentId, revision } = this.#session();
    return this.transport.request<InspectDocumentFontsResult>(
      'inspectDocumentFonts',
      null,
      [],
      { documentId, revision },
    );
  }

  registerFont(
    source: Extract<FontSourceKind, 'local' | 'upload'>,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<FontDescriptor> {
    const ownedBytes = new Uint8Array(bytes);
    return this.transport.request<FontDescriptor>(
      'registerFont',
      { source, fileName, bytes: ownedBytes.buffer },
      [ownedBytes.buffer],
      {},
    );
  }

  previewReplacement(
    spanKey: string,
    replacement: string,
    acceptSubstitution: boolean,
  ): Promise<ReplacementPreviewResult> {
    const { documentId, revision } = this.#session();
    return this.transport.request<ReplacementPreviewResult>(
      'previewReplacement',
      { spanKey, replacement, acceptSubstitution },
      [],
      { documentId, revision },
    );
  }

  async applyValidated(
    input: ReplacementPayload & Readonly<{
      preconditions: ReplacementPreconditions;
    }>,
  ): Promise<ValidatedApplyResult> {
    const { documentId, revision } = this.#session();
    const { preconditions, ...payload } = input;
    const applied = await this.transport.request<ApplyReplacementResult>(
      'applyReplacement',
      payload,
      [],
      { documentId, revision, preconditions },
    );

    const validation = await this.transport.request<ValidationEvidence>(
      'validateCandidate',
      { candidateId: applied.candidateId },
      [],
      { documentId, revision },
    );
    if (!validation.valid || validation.candidateHash !== applied.candidateHash) {
      const checks = validation.candidateHash === applied.candidateHash
        ? validation.checks
        : [...validation.checks, 'candidate-hash-mismatch'];
      throw new ValidationRejectedError(checks);
    }
    if (validation.revision !== applied.revision) {
      throw new ValidationRejectedError([...validation.checks, 'candidate-revision-mismatch']);
    }
    this.#revision = validation.revision;

    const exported = await this.transport.request<Readonly<{ bytes: ArrayBuffer }>>(
      'exportDocument',
      null,
      [],
      {
        documentId,
        revision: validation.revision,
        preconditions: { validatedCandidateHash: applied.candidateHash },
      },
    );
    return {
      revision: applied.revision,
      candidateHash: applied.candidateHash,
      bytes: new Uint8Array(new Uint8Array(exported.bytes)),
    };
  }

  previewRichReplacement(
    payload: RichReplacementPayload,
  ): Promise<RichReplacementPreviewResult> {
    const { documentId, revision } = this.#session();
    return this.transport.request<RichReplacementPreviewResult>(
      'previewRichReplacement',
      payload,
      [],
      { documentId, revision },
    );
  }

  async applyRichValidated(
    payload: RichReplacementPayload,
    preconditions: RichReplacementPreconditions,
  ): Promise<ValidatedApplyResult> {
    const { documentId, revision } = this.#session();
    const applied = await this.transport.request<ApplyRichReplacementResult>(
      'applyRichReplacement',
      payload,
      [],
      { documentId, revision, preconditions },
    );
    const validation = await this.transport.request<ValidationEvidence>(
      'validateCandidate',
      { candidateId: applied.candidateId },
      [],
      { documentId, revision },
    );
    if (
      !validation.valid ||
      validation.candidateHash !== applied.candidateHash ||
      validation.revision !== applied.revision
    ) {
      throw new ValidationRejectedError(validation.checks);
    }
    this.#revision = validation.revision;
    const exported = await this.transport.request<Readonly<{ bytes: ArrayBuffer }>>(
      'exportDocument',
      null,
      [],
      {
        documentId,
        revision: validation.revision,
        preconditions: { validatedCandidateHash: applied.candidateHash },
      },
    );
    return Object.freeze({
      revision: validation.revision,
      candidateHash: applied.candidateHash,
      bytes: new Uint8Array(exported.bytes.slice(0)),
    });
  }

  async close(): Promise<void> {
    if (this.#documentId === null || this.#revision === null) return;
    const documentId = this.#documentId;
    const revision = this.#revision;
    await this.transport.request<null>(
      'closeDocument',
      null,
      [],
      { documentId, revision },
    );
    this.#documentId = null;
    this.#revision = null;
  }

  terminate(): void {
    this.transport.terminate();
    this.#documentId = null;
    this.#revision = null;
  }

  #session(): Readonly<{ documentId: string; revision: number }> {
    if (this.#documentId === null || this.#revision === null) {
      throw new Error('No PDF document is open');
    }
    return { documentId: this.#documentId, revision: this.#revision };
  }
}
