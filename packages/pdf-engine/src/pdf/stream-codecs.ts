import {
  PDFArray,
  PDFName,
  PDFNumber,
  type PDFRawStream,
} from 'pdf-lib';

import type { EngineErrorCode, EngineErrorDescriptor } from '../errors';

export class PdfEngineError extends Error implements EngineErrorDescriptor {
  readonly code: EngineErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: EngineErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = 'PdfEngineError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function checkedLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new PdfEngineError(
      'INTERNAL_FAILURE',
      'Decoded stream byte limit must be a non-negative safe integer',
    );
  }
}

function copyWithinLimit(bytes: Uint8Array, limit: number): Uint8Array {
  if (bytes.byteLength > limit) {
    throw new PdfEngineError('RESOURCE_LIMIT', 'Decoded stream exceeds byte limit', {
      resource: 'decodedStreamBytes',
      limit,
      observedBytes: bytes.byteLength,
    });
  }
  return new Uint8Array(bytes);
}

async function decodeFlateBounded(
  encodedBytes: Uint8Array,
  limit: number,
): Promise<Uint8Array> {
  const ownedBytes = new Uint8Array(encodedBytes);
  const source = new Blob([ownedBytes]).stream();
  const reader = source
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      length += chunk.byteLength;
      if (length > limit) {
        await reader.cancel('Decoded stream exceeds byte limit');
        throw new PdfEngineError(
          'RESOURCE_LIMIT',
          'Decoded stream exceeds byte limit',
          { resource: 'decodedStreamBytes', limit, observedBytes: length },
        );
      }
      chunks.push(new Uint8Array(chunk));
    }
  } catch (error) {
    if (error instanceof PdfEngineError) throw error;
    throw new PdfEngineError('MALFORMED_INPUT', 'Flate stream cannot be decoded');
  } finally {
    reader.releaseLock();
  }

  const decoded = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    decoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoded;
}

export async function decodeStreamBytes(
  stream: PDFRawStream,
  maxDecodedStreamBytes: number,
): Promise<Uint8Array> {
  checkedLimit(maxDecodedStreamBytes);

  const declaredDecodedLength = stream.dict.lookupMaybe(
    PDFName.of('M0DecodedLength'),
    PDFNumber,
  );
  if (
    declaredDecodedLength !== undefined &&
    declaredDecodedLength.asNumber() > maxDecodedStreamBytes
  ) {
    throw new PdfEngineError(
      'RESOURCE_LIMIT',
      'Declared decoded stream size exceeds byte limit',
      {
        resource: 'decodedStreamBytes',
        limit: maxDecodedStreamBytes,
        declaredBytes: declaredDecodedLength.asNumber(),
      },
    );
  }

  const filter = stream.dict.get(PDFName.of('Filter'));
  if (filter === undefined) {
    return copyWithinLimit(stream.contents, maxDecodedStreamBytes);
  }
  if (filter instanceof PDFArray) {
    throw new PdfEngineError(
      'UNSUPPORTED_DOCUMENT',
      'PDF stream filter chains are not supported in M0',
    );
  }
  if (!(filter instanceof PDFName) || filter.asString() !== '/FlateDecode') {
    throw new PdfEngineError(
      'UNSUPPORTED_DOCUMENT',
      'PDF stream filter is not supported in M0',
      { filter: filter.toString() },
    );
  }

  return decodeFlateBounded(stream.contents, maxDecodedStreamBytes);
}
