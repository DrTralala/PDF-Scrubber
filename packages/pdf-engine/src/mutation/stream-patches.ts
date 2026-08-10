export type StreamPatch = Readonly<{
  startOffset: number;
  endOffset: number;
  bytes: Uint8Array;
}>;

export class StreamPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamPatchError';
  }
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function applyStreamPatches(
  original: Uint8Array,
  patches: readonly StreamPatch[],
): Uint8Array {
  const ordered = [...patches].sort((left, right) => left.startOffset - right.startOffset);
  for (const patch of ordered) {
    if (
      !Number.isSafeInteger(patch.startOffset) ||
      !Number.isSafeInteger(patch.endOffset) ||
      patch.startOffset < 0 ||
      patch.endOffset <= patch.startOffset ||
      patch.endOffset > original.byteLength
    ) {
      throw new StreamPatchError('Stream patch range is invalid');
    }
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1]!.endOffset > ordered[index]!.startOffset) {
      throw new StreamPatchError('Stream patches overlap');
    }
  }
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const patch of ordered) {
    parts.push(original.slice(cursor, patch.startOffset), patch.bytes.slice());
    cursor = patch.endOffset;
  }
  parts.push(original.slice(cursor));
  return concatenate(parts);
}
