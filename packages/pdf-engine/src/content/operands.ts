import type { EngineErrorDescriptor } from '../errors';
import type { SpanAddress } from '../model';
import type { PdfOperand, PdfStringOperand } from './tokeniser';

export type GlyphSourceMapping = Readonly<{
  glyphIndex: number;
  sourceCodeStart: number;
  sourceCodeEnd: number;
}>;

export type TextOperandRewrite =
  | Readonly<{
      kind: 'preserved';
      prefixOperandBytes: Uint8Array | null;
      suffixOperandBytes: Uint8Array | null;
    }>
  | Readonly<{ kind: 'expandRequired' }>
  | Readonly<{ kind: 'unsupported' }>;

type GlyphRange = SpanAddress['glyphRange'];

class TextOperandError extends Error implements EngineErrorDescriptor {
  readonly code: EngineErrorDescriptor['code'];

  constructor(code: EngineErrorDescriptor['code'], message: string) {
    super(message);
    this.name = 'TextOperandError';
    this.code = code;
  }
}

function textStrings(operand: PdfOperand): readonly PdfStringOperand[] {
  if (operand.kind === 'literalString' || operand.kind === 'hexString') return [operand];
  if (operand.kind !== 'array') {
    throw new TextOperandError(
      'UNSUPPORTED_DOCUMENT',
      'Text operand is neither a PDF string nor a TJ array',
    );
  }
  const strings: PdfStringOperand[] = [];
  for (const item of operand.items) {
    if (item.kind === 'literalString' || item.kind === 'hexString') strings.push(item);
    else if (item.kind !== 'number') {
      throw new TextOperandError(
        'UNSUPPORTED_DOCUMENT',
        'TJ array contains an item other than a string or number',
      );
    }
  }
  return strings;
}

export function decodeTextOperand(operand: PdfOperand): Uint8Array {
  const strings = textStrings(operand);
  const length = strings.reduce((total, item) => total + item.value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const item of strings) {
    result.set(item.value, offset);
    offset += item.value.length;
  }
  return result;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function sliceString(
  operand: PdfStringOperand,
  codeStart: number,
  codeEnd: number,
): Uint8Array | null {
  if (codeStart === codeEnd) return null;
  if (
    codeStart < 0 ||
    codeEnd > operand.value.length ||
    codeStart > codeEnd ||
    operand.atoms.length !== operand.value.length
  ) {
    return null;
  }
  const first = operand.atoms[codeStart];
  const last = operand.atoms[codeEnd - 1];
  if (first === undefined || last === undefined) return null;

  const relativeStart = first.rawStartOffset - operand.startOffset;
  const relativeEnd = last.rawEndOffset - operand.startOffset;
  const opening = operand.kind === 'literalString' ? 0x28 : 0x3c;
  const closing = operand.kind === 'literalString' ? 0x29 : 0x3e;
  return concatenate([
    Uint8Array.of(opening),
    operand.rawBytes.slice(relativeStart, relativeEnd),
    Uint8Array.of(closing),
  ]);
}

function validateMapping(
  mapping: readonly GlyphSourceMapping[],
  codeLength: number,
  selectedGlyphRange: GlyphRange,
): 'valid' | 'overlap' | 'invalid' {
  if (
    mapping.length === 0 ||
    !Number.isSafeInteger(selectedGlyphRange.start) ||
    !Number.isSafeInteger(selectedGlyphRange.end) ||
    selectedGlyphRange.start < 0 ||
    selectedGlyphRange.end > mapping.length ||
    selectedGlyphRange.start >= selectedGlyphRange.end
  ) {
    return 'invalid';
  }

  let previousEnd = 0;
  for (let index = 0; index < mapping.length; index += 1) {
    const item = mapping[index]!;
    if (
      item.glyphIndex !== index ||
      !Number.isSafeInteger(item.sourceCodeStart) ||
      !Number.isSafeInteger(item.sourceCodeEnd) ||
      item.sourceCodeStart < 0 ||
      item.sourceCodeEnd > codeLength ||
      item.sourceCodeStart >= item.sourceCodeEnd
    ) {
      return 'invalid';
    }
    if (item.sourceCodeStart < previousEnd) return 'overlap';
    if (item.sourceCodeStart !== previousEnd) return 'invalid';
    previousEnd = item.sourceCodeEnd;
  }
  return previousEnd === codeLength ? 'valid' : 'invalid';
}

function arraySlices(
  operand: Extract<PdfOperand, { kind: 'array' }>,
  selectedCodeStart: number,
  selectedCodeEnd: number,
): { prefix: Uint8Array | null; suffix: Uint8Array | null } | undefined {
  const prefix: Uint8Array[] = [];
  const suffix: Uint8Array[] = [];
  let codeOffset = 0;

  for (const item of operand.items) {
    if (item.kind === 'number') {
      if (codeOffset <= selectedCodeStart) prefix.push(item.rawBytes);
      else if (codeOffset >= selectedCodeEnd) suffix.push(item.rawBytes);
      continue;
    }
    if (item.kind !== 'literalString' && item.kind !== 'hexString') return undefined;

    const itemStart = codeOffset;
    const itemEnd = itemStart + item.value.length;
    const prefixEnd = Math.min(itemEnd, selectedCodeStart);
    if (prefixEnd > itemStart) {
      const sliced = sliceString(item, 0, prefixEnd - itemStart);
      if (sliced === null) return undefined;
      prefix.push(sliced);
    }
    const suffixStart = Math.max(itemStart, selectedCodeEnd);
    if (suffixStart < itemEnd) {
      const sliced = sliceString(item, suffixStart - itemStart, item.value.length);
      if (sliced === null) return undefined;
      suffix.push(sliced);
    }
    codeOffset = itemEnd;
  }

  const wrap = (parts: readonly Uint8Array[]): Uint8Array | null =>
    parts.length === 0
      ? null
      : concatenate([
          Uint8Array.of(0x5b),
          ...parts.flatMap((part, index) =>
            index === 0 ? [part] : [Uint8Array.of(0x20), part],
          ),
          Uint8Array.of(0x5d),
        ]);
  return { prefix: wrap(prefix), suffix: wrap(suffix) };
}

export function rewriteTextOperand(
  operand: PdfOperand,
  glyphSourceMapping: readonly GlyphSourceMapping[],
  selectedGlyphRange: GlyphRange,
): TextOperandRewrite {
  let decoded: Uint8Array;
  try {
    decoded = decodeTextOperand(operand);
  } catch {
    return { kind: 'unsupported' };
  }

  const mappingState = validateMapping(
    glyphSourceMapping,
    decoded.length,
    selectedGlyphRange,
  );
  if (mappingState === 'overlap') return { kind: 'expandRequired' };
  if (mappingState === 'invalid') return { kind: 'unsupported' };

  const selectedCodeStart = glyphSourceMapping[selectedGlyphRange.start]!.sourceCodeStart;
  const selectedCodeEnd = glyphSourceMapping[selectedGlyphRange.end - 1]!.sourceCodeEnd;

  if (operand.kind === 'literalString' || operand.kind === 'hexString') {
    const prefixOperandBytes = sliceString(operand, 0, selectedCodeStart);
    const suffixOperandBytes = sliceString(operand, selectedCodeEnd, decoded.length);
    if (
      (selectedCodeStart > 0 && prefixOperandBytes === null) ||
      (selectedCodeEnd < decoded.length && suffixOperandBytes === null)
    ) {
      return { kind: 'unsupported' };
    }
    return { kind: 'preserved', prefixOperandBytes, suffixOperandBytes };
  }

  if (operand.kind === 'array') {
    const slices = arraySlices(operand, selectedCodeStart, selectedCodeEnd);
    if (slices === undefined) return { kind: 'unsupported' };
    return {
      kind: 'preserved',
      prefixOperandBytes: slices.prefix,
      suffixOperandBytes: slices.suffix,
    };
  }
  return { kind: 'unsupported' };
}
