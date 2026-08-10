import type { EngineErrorCode, EngineErrorDescriptor } from '../errors';
import type { EngineLimits } from '../limits';

type OperandBase = Readonly<{
  startOffset: number;
  endOffset: number;
  rawBytes: Uint8Array;
}>;

export type PdfStringAtom = Readonly<{
  decodedStart: number;
  decodedEnd: number;
  rawStartOffset: number;
  rawEndOffset: number;
}>;

export type PdfStringOperand = OperandBase &
  Readonly<{
    kind: 'literalString' | 'hexString';
    value: Uint8Array;
    atoms: readonly PdfStringAtom[];
  }>;

export type PdfOperand =
  | (OperandBase & Readonly<{ kind: 'number'; value: number }>)
  | (OperandBase & Readonly<{ kind: 'name'; value: string }>)
  | (OperandBase & Readonly<{ kind: 'boolean'; value: boolean }>)
  | (OperandBase & Readonly<{ kind: 'null'; value: null }>)
  | PdfStringOperand
  | (OperandBase & Readonly<{ kind: 'array'; items: readonly PdfOperand[] }>)
  | (OperandBase &
      Readonly<{
        kind: 'dictionary';
        entries: readonly (readonly [Extract<PdfOperand, { kind: 'name' }>, PdfOperand])[];
      }>);

export type ContentOperation = Readonly<{
  index: number;
  operator: string;
  operands: readonly PdfOperand[];
  startOffset: number;
  endOffset: number;
  rawBytes: Uint8Array;
}>;

class ContentStreamError extends Error implements EngineErrorDescriptor {
  readonly code: EngineErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: EngineErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = 'ContentStreamError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const isWhitespace = (byte: number): boolean =>
  byte === 0x00 ||
  byte === 0x09 ||
  byte === 0x0a ||
  byte === 0x0c ||
  byte === 0x0d ||
  byte === 0x20;

const isDelimiter = (byte: number): boolean =>
  byte === 0x28 ||
  byte === 0x29 ||
  byte === 0x3c ||
  byte === 0x3e ||
  byte === 0x5b ||
  byte === 0x5d ||
  byte === 0x7b ||
  byte === 0x7d ||
  byte === 0x2f ||
  byte === 0x25;

const isHexDigit = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x41 && byte <= 0x46) ||
  (byte >= 0x61 && byte <= 0x66);

function hexValue(byte: number): number {
  if (byte <= 0x39) return byte - 0x30;
  if (byte <= 0x46) return byte - 0x41 + 10;
  return byte - 0x61 + 10;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let result = '';
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index]!;
    if (byte < 0x21 || byte > 0x7e) {
      throw new ContentStreamError(
        'MALFORMED_INPUT',
        'Content-stream keyword contains a non-ASCII byte',
        { offset: index },
      );
    }
    result += String.fromCharCode(byte);
  }
  return result;
}

class ContentParser {
  private offset = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly limits: EngineLimits,
  ) {}

  parse(): ContentOperation[] {
    const operations: ContentOperation[] = [];
    let operands: PdfOperand[] = [];
    let operationStart: number | undefined;

    while (true) {
      this.skipSpaceAndComments();
      if (this.offset === this.bytes.length) break;
      operationStart ??= this.offset;

      const operand = this.tryParseOperand(0);
      if (operand !== undefined) {
        operands.push(operand);
        continue;
      }

      const operatorStart = this.offset;
      const operator = this.parseRegularToken();
      if (operator === 'BI') {
        throw new ContentStreamError(
          'UNSUPPORTED_DOCUMENT',
          'Inline images are not supported by the bounded content tokeniser',
          { offset: operatorStart },
        );
      }
      if (operations.length >= this.limits.maxOperationsPerStream) {
        throw new ContentStreamError(
          'RESOURCE_LIMIT',
          'Content stream exceeds the operation-count limit',
          { resource: 'operations', limit: this.limits.maxOperationsPerStream },
        );
      }
      const endOffset = this.offset;
      operations.push({
        index: operations.length,
        operator,
        operands,
        startOffset: operationStart,
        endOffset,
        rawBytes: this.bytes.slice(operationStart, endOffset),
      });
      operands = [];
      operationStart = undefined;
    }

    if (operands.length > 0) {
      throw new ContentStreamError(
        'MALFORMED_INPUT',
        'Content stream ends with operands but no operator',
        { offset: operationStart ?? this.offset },
      );
    }
    return operations;
  }

  private skipSpaceAndComments(): void {
    while (this.offset < this.bytes.length) {
      if (isWhitespace(this.bytes[this.offset]!)) {
        this.offset += 1;
        continue;
      }
      if (this.bytes[this.offset] !== 0x25) return;
      this.offset += 1;
      while (
        this.offset < this.bytes.length &&
        this.bytes[this.offset] !== 0x0a &&
        this.bytes[this.offset] !== 0x0d
      ) {
        this.offset += 1;
      }
    }
  }

  private tryParseOperand(depth: number): PdfOperand | undefined {
    const byte = this.bytes[this.offset]!;
    if (byte === 0x28) return this.parseLiteralString();
    if (byte === 0x3c) {
      return this.bytes[this.offset + 1] === 0x3c
        ? this.parseDictionary(depth + 1)
        : this.parseHexString();
    }
    if (byte === 0x5b) return this.parseArray(depth + 1);
    if (byte === 0x2f) return this.parseName();
    if (byte === 0x29 || byte === 0x5d || byte === 0x3e) {
      throw new ContentStreamError('MALFORMED_INPUT', 'Unexpected closing delimiter', {
        offset: this.offset,
      });
    }
    if (byte === 0x7b || byte === 0x7d) {
      throw new ContentStreamError('MALFORMED_INPUT', 'Unsupported content delimiter', {
        offset: this.offset,
      });
    }

    const startOffset = this.offset;
    const token = this.peekRegularToken();
    if (token === undefined) return undefined;
    if (token === 'true' || token === 'false') {
      this.offset += token.length;
      return this.withRaw(startOffset, {
        kind: 'boolean' as const,
        value: token === 'true',
      });
    }
    if (token === 'null') {
      this.offset += token.length;
      return this.withRaw(startOffset, { kind: 'null' as const, value: null });
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
      this.offset += token.length;
      return this.withRaw(startOffset, { kind: 'number' as const, value: Number(token) });
    }
    return undefined;
  }

  private parseArray(depth: number): Extract<PdfOperand, { kind: 'array' }> {
    this.assertDepth(depth);
    const startOffset = this.offset++;
    const items: PdfOperand[] = [];
    while (true) {
      this.skipSpaceAndComments();
      if (this.offset >= this.bytes.length) {
        throw new ContentStreamError('MALFORMED_INPUT', 'Unterminated PDF array', {
          offset: startOffset,
        });
      }
      if (this.bytes[this.offset] === 0x5d) {
        this.offset += 1;
        return this.withRaw(startOffset, { kind: 'array' as const, items });
      }
      const item = this.tryParseOperand(depth);
      if (item === undefined) {
        throw new ContentStreamError(
          'MALFORMED_INPUT',
          'PDF array contains a non-operand token',
          { offset: this.offset },
        );
      }
      items.push(item);
    }
  }

  private parseDictionary(
    depth: number,
  ): Extract<PdfOperand, { kind: 'dictionary' }> {
    this.assertDepth(depth);
    const startOffset = this.offset;
    this.offset += 2;
    const entries: Array<
      readonly [Extract<PdfOperand, { kind: 'name' }>, PdfOperand]
    > = [];
    while (true) {
      this.skipSpaceAndComments();
      if (
        this.bytes[this.offset] === 0x3e &&
        this.bytes[this.offset + 1] === 0x3e
      ) {
        this.offset += 2;
        return this.withRaw(startOffset, {
          kind: 'dictionary' as const,
          entries,
        });
      }
      if (this.offset >= this.bytes.length) {
        throw new ContentStreamError('MALFORMED_INPUT', 'Unterminated PDF dictionary', {
          offset: startOffset,
        });
      }
      if (this.bytes[this.offset] !== 0x2f) {
        throw new ContentStreamError('MALFORMED_INPUT', 'PDF dictionary key is not a name', {
          offset: this.offset,
        });
      }
      const key = this.parseName();
      this.skipSpaceAndComments();
      const value = this.tryParseOperand(depth);
      if (value === undefined) {
        throw new ContentStreamError('MALFORMED_INPUT', 'PDF dictionary value is absent', {
          offset: this.offset,
        });
      }
      entries.push([key, value]);
    }
  }

  private parseName(): Extract<PdfOperand, { kind: 'name' }> {
    const startOffset = this.offset++;
    const decoded: number[] = [];
    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset]!;
      if (isWhitespace(byte) || isDelimiter(byte)) break;
      if (byte === 0x23) {
        const high = this.bytes[this.offset + 1];
        const low = this.bytes[this.offset + 2];
        if (high === undefined || low === undefined || !isHexDigit(high) || !isHexDigit(low)) {
          throw new ContentStreamError('MALFORMED_INPUT', 'Invalid hexadecimal escape in name', {
            offset: this.offset,
          });
        }
        decoded.push((hexValue(high) << 4) | hexValue(low));
        this.offset += 3;
      } else {
        decoded.push(byte);
        this.offset += 1;
      }
    }
    return this.withRaw(startOffset, {
      kind: 'name' as const,
      value: String.fromCharCode(...decoded),
    });
  }

  private parseLiteralString(): PdfStringOperand {
    const startOffset = this.offset++;
    const decoded: number[] = [];
    const atoms: PdfStringAtom[] = [];
    let nesting = 1;

    while (this.offset < this.bytes.length) {
      const atomStart = this.offset;
      let byte = this.bytes[this.offset++]!;
      if (byte === 0x29) {
        nesting -= 1;
        if (nesting === 0) {
          return this.stringWithRaw(startOffset, 'literalString', decoded, atoms);
        }
      } else if (byte === 0x28) {
        nesting += 1;
        this.assertDepth(nesting);
      } else if (byte === 0x5c) {
        if (this.offset >= this.bytes.length) {
          throw new ContentStreamError('MALFORMED_INPUT', 'Truncated literal-string escape', {
            offset: atomStart,
          });
        }
        byte = this.bytes[this.offset++]!;
        if (byte === 0x0d || byte === 0x0a) {
          if (byte === 0x0d && this.bytes[this.offset] === 0x0a) this.offset += 1;
          continue;
        }
        const escaped = new Map<number, number>([
          [0x6e, 0x0a],
          [0x72, 0x0d],
          [0x74, 0x09],
          [0x62, 0x08],
          [0x66, 0x0c],
        ]).get(byte);
        if (escaped !== undefined) byte = escaped;
        else if (byte >= 0x30 && byte <= 0x37) {
          let octal = byte - 0x30;
          let digits = 1;
          while (
            digits < 3 &&
            this.bytes[this.offset] !== undefined &&
            this.bytes[this.offset]! >= 0x30 &&
            this.bytes[this.offset]! <= 0x37
          ) {
            octal = octal * 8 + (this.bytes[this.offset++]! - 0x30);
            digits += 1;
          }
          byte = octal & 0xff;
        }
      } else if (byte === 0x0d) {
        if (this.bytes[this.offset] === 0x0a) this.offset += 1;
        byte = 0x0a;
      }

      const decodedStart = decoded.length;
      decoded.push(byte);
      atoms.push({
        decodedStart,
        decodedEnd: decodedStart + 1,
        rawStartOffset: atomStart,
        rawEndOffset: this.offset,
      });
    }

    throw new ContentStreamError('MALFORMED_INPUT', 'Unterminated literal string', {
      offset: startOffset,
    });
  }

  private parseHexString(): PdfStringOperand {
    const startOffset = this.offset++;
    const decoded: number[] = [];
    const atoms: PdfStringAtom[] = [];
    let highNibble: { value: number; offset: number } | undefined;

    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset]!;
      if (byte === 0x3e) {
        if (highNibble !== undefined) {
          const decodedStart = decoded.length;
          decoded.push(highNibble.value << 4);
          atoms.push({
            decodedStart,
            decodedEnd: decodedStart + 1,
            rawStartOffset: highNibble.offset,
            rawEndOffset: this.offset,
          });
        }
        this.offset += 1;
        return this.stringWithRaw(startOffset, 'hexString', decoded, atoms);
      }
      if (isWhitespace(byte)) {
        this.offset += 1;
        continue;
      }
      if (!isHexDigit(byte)) {
        throw new ContentStreamError('MALFORMED_INPUT', 'Invalid hexadecimal string digit', {
          offset: this.offset,
        });
      }
      if (highNibble === undefined) {
        highNibble = { value: hexValue(byte), offset: this.offset };
      } else {
        const decodedStart = decoded.length;
        decoded.push((highNibble.value << 4) | hexValue(byte));
        atoms.push({
          decodedStart,
          decodedEnd: decodedStart + 1,
          rawStartOffset: highNibble.offset,
          rawEndOffset: this.offset + 1,
        });
        highNibble = undefined;
      }
      this.offset += 1;
    }

    throw new ContentStreamError('MALFORMED_INPUT', 'Unterminated hexadecimal string', {
      offset: startOffset,
    });
  }

  private stringWithRaw(
    startOffset: number,
    kind: PdfStringOperand['kind'],
    decoded: number[],
    atoms: PdfStringAtom[],
  ): PdfStringOperand {
    return this.withRaw(startOffset, {
      kind,
      value: Uint8Array.from(decoded),
      atoms,
    });
  }

  private peekRegularToken(): string | undefined {
    let end = this.offset;
    while (
      end < this.bytes.length &&
      !isWhitespace(this.bytes[end]!) &&
      !isDelimiter(this.bytes[end]!)
    ) {
      end += 1;
    }
    if (end === this.offset) return undefined;
    return ascii(this.bytes, this.offset, end);
  }

  private parseRegularToken(): string {
    const token = this.peekRegularToken();
    if (token === undefined) {
      throw new ContentStreamError('MALFORMED_INPUT', 'Expected a content operator', {
        offset: this.offset,
      });
    }
    this.offset += token.length;
    return token;
  }

  private assertDepth(depth: number): void {
    if (depth > this.limits.maxNestingDepth) {
      throw new ContentStreamError('RESOURCE_LIMIT', 'Operand nesting exceeds the limit', {
        resource: 'nestingDepth',
        limit: this.limits.maxNestingDepth,
      });
    }
  }

  private withRaw<T extends Readonly<Record<string, unknown>>>(
    startOffset: number,
    value: T,
  ): T & OperandBase {
    return {
      ...value,
      startOffset,
      endOffset: this.offset,
      rawBytes: this.bytes.slice(startOffset, this.offset),
    };
  }
}

export function tokeniseContentStream(
  bytes: Uint8Array,
  limits: EngineLimits,
): ContentOperation[] {
  if (!Number.isSafeInteger(limits.maxOperationsPerStream) || limits.maxOperationsPerStream < 0) {
    throw new ContentStreamError('RESOURCE_LIMIT', 'Invalid operation-count limit');
  }
  if (!Number.isSafeInteger(limits.maxNestingDepth) || limits.maxNestingDepth < 0) {
    throw new ContentStreamError('RESOURCE_LIMIT', 'Invalid operand-nesting limit');
  }
  if (
    !Number.isSafeInteger(limits.maxDecodedStreamBytes) ||
    limits.maxDecodedStreamBytes < 0
  ) {
    throw new ContentStreamError('RESOURCE_LIMIT', 'Invalid decoded-stream byte limit');
  }
  if (bytes.byteLength > limits.maxDecodedStreamBytes) {
    throw new ContentStreamError('RESOURCE_LIMIT', 'Decoded content stream exceeds the byte limit', {
      resource: 'decodedStreamBytes',
      limit: limits.maxDecodedStreamBytes,
      observedBytes: bytes.byteLength,
    });
  }
  return new ContentParser(bytes, limits).parse();
}
