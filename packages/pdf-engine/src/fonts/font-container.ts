import type { EngineErrorCode, EngineErrorDescriptor } from '../errors';
import { MAX_FONT_FACE_BYTES } from '../limits';

export type FontSourceFormat = 'truetype' | 'opentype' | 'woff1';
export type FontOutlineFormat = 'truetype' | 'cff';

export type SfntTableRecord = Readonly<{
  tag: string;
  offset: number;
  length: number;
}>;

export type NormalisedFontContainer = Readonly<{
  sourceFormat: FontSourceFormat;
  outlineFormat: FontOutlineFormat;
  sfntBytes: Uint8Array<ArrayBuffer>;
  tableTags: readonly string[];
  tables: readonly SfntTableRecord[];
}>;

class FontContainerError extends Error implements EngineErrorDescriptor {
  readonly code: EngineErrorCode;

  constructor(message: string) {
    super(message);
    this.name = 'FontContainerError';
    this.code = 'FONT_UNAVAILABLE';
  }
}

type WoffTable = Readonly<{
  tag: number;
  offset: number;
  compressedLength: number;
  originalLength: number;
  checksum: number;
}>;

const TRUE_TYPE_SIGNATURE = 0x00010000;
const OTTO_SIGNATURE = 0x4f54544f;
const TRUE_SIGNATURE = 0x74727565;
const TYP1_SIGNATURE = 0x74797031;
const WOFF1_SIGNATURE = 0x774f4646;
const WOFF2_SIGNATURE = 0x774f4632;
const COLLECTION_SIGNATURE = 0x74746366;
const MAX_TABLES = 4_096;
const VARIABLE_TABLES = new Set(['fvar', 'gvar', 'avar', 'HVAR', 'MVAR', 'VVAR']);
const COLOUR_TABLES = new Set(['COLR', 'CPAL', 'CBDT', 'CBLC', 'sbix', 'SVG ']);

function align4(value: number): number {
  return (value + 3) & ~3;
}

function ownedBytes(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const owned: Uint8Array<ArrayBuffer> = new Uint8Array(source.byteLength);
  owned.set(source);
  return owned;
}

function uint32Tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function parseSfntTables(bytes: Uint8Array<ArrayBuffer>): readonly SfntTableRecord[] {
  if (bytes.byteLength < 12) {
    throw new FontContainerError('SFNT header is truncated');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableCount = view.getUint16(4);
  if (
    tableCount === 0
    || tableCount > MAX_TABLES
    || 12 + tableCount * 16 > bytes.byteLength
  ) {
    throw new FontContainerError('SFNT table directory is invalid');
  }

  const tags = new Set<string>();
  const tables: SfntTableRecord[] = [];
  for (let index = 0; index < tableCount; index += 1) {
    const directoryOffset = 12 + index * 16;
    const tag = uint32Tag(bytes, directoryOffset);
    const offset = view.getUint32(directoryOffset + 8);
    const length = view.getUint32(directoryOffset + 12);
    if (
      tags.has(tag)
      || length === 0
      || offset > bytes.byteLength
      || length > bytes.byteLength - offset
    ) {
      throw new FontContainerError('SFNT table directory is invalid');
    }
    tags.add(tag);
    tables.push(Object.freeze({ tag, offset, length }));
  }
  return Object.freeze(tables);
}

function outlineFormat(tags: ReadonlySet<string>): FontOutlineFormat {
  const hasTrueType = tags.has('glyf') && tags.has('loca');
  const hasCff = tags.has('CFF ') || tags.has('CFF2');
  if (hasTrueType === hasCff) {
    throw new FontContainerError('Font outline tables are unsupported or ambiguous');
  }
  return hasTrueType ? 'truetype' : 'cff';
}

function validateSupportedTables(tags: ReadonlySet<string>): void {
  const variable = [...VARIABLE_TABLES].find((tag) => tags.has(tag));
  if (variable !== undefined) {
    throw new FontContainerError(`Font uses unsupported variable table ${variable}`);
  }
  const colour = [...COLOUR_TABLES].find((tag) => tags.has(tag));
  if (colour !== undefined) {
    throw new FontContainerError(`Font uses unsupported colour table ${colour}`);
  }
}

async function inflateTable(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([ownedBytes(bytes)]).stream().pipeThrough(
    new DecompressionStream('deflate'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeWoff1(source: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (source.byteLength < 44) {
    throw new FontContainerError('WOFF header is truncated');
  }
  const input = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const flavour = input.getUint32(4);
  const declaredLength = input.getUint32(8);
  const tableCount = input.getUint16(12);
  const totalSfntSize = input.getUint32(16);
  if (
    declaredLength !== source.byteLength
    || tableCount === 0
    || tableCount > MAX_TABLES
    || 44 + tableCount * 20 > source.byteLength
    || totalSfntSize > MAX_FONT_FACE_BYTES
    || totalSfntSize < 12 + tableCount * 16
  ) {
    throw new FontContainerError('WOFF header is invalid');
  }

  const tables: WoffTable[] = [];
  for (let index = 0; index < tableCount; index += 1) {
    const entry = 44 + index * 20;
    const table = Object.freeze({
      tag: input.getUint32(entry),
      offset: input.getUint32(entry + 4),
      compressedLength: input.getUint32(entry + 8),
      originalLength: input.getUint32(entry + 12),
      checksum: input.getUint32(entry + 16),
    });
    if (
      table.originalLength === 0
      || table.compressedLength === 0
      || table.compressedLength > table.originalLength
      || table.offset > source.byteLength
      || table.compressedLength > source.byteLength - table.offset
    ) {
      throw new FontContainerError('WOFF table directory is invalid');
    }
    tables.push(table);
  }

  const output: Uint8Array<ArrayBuffer> = new Uint8Array(totalSfntSize);
  const header = new DataView(output.buffer);
  const highestPowerOfTwo = 2 ** Math.floor(Math.log2(tableCount));
  header.setUint32(0, flavour);
  header.setUint16(4, tableCount);
  header.setUint16(6, highestPowerOfTwo * 16);
  header.setUint16(8, Math.log2(highestPowerOfTwo));
  header.setUint16(10, tableCount * 16 - highestPowerOfTwo * 16);

  let outputOffset = 12 + tableCount * 16;
  for (let index = 0; index < tables.length; index += 1) {
    const table = tables[index]!;
    const encoded = source.slice(table.offset, table.offset + table.compressedLength);
    let decoded: Uint8Array;
    try {
      decoded = table.compressedLength === table.originalLength
        ? encoded
        : await inflateTable(encoded);
    } catch {
      throw new FontContainerError('WOFF table cannot be decompressed');
    }
    if (decoded.byteLength !== table.originalLength) {
      throw new FontContainerError('WOFF table length is invalid');
    }

    const directoryOffset = 12 + index * 16;
    header.setUint32(directoryOffset, table.tag);
    header.setUint32(directoryOffset + 4, table.checksum);
    header.setUint32(directoryOffset + 8, outputOffset);
    header.setUint32(directoryOffset + 12, table.originalLength);
    output.set(decoded, outputOffset);
    outputOffset += align4(table.originalLength);
  }
  if (outputOffset !== totalSfntSize) {
    throw new FontContainerError('WOFF SFNT size is inconsistent');
  }
  return output;
}

export async function normaliseFontContainer(
  source: Uint8Array,
): Promise<NormalisedFontContainer> {
  if (source.byteLength > MAX_FONT_FACE_BYTES) {
    throw new FontContainerError('Font exceeds the per-face byte limit');
  }
  if (source.byteLength < 4) {
    throw new FontContainerError('Unsupported font signature');
  }

  const input = ownedBytes(source);
  const signature = new DataView(input.buffer).getUint32(0);
  if (signature === WOFF2_SIGNATURE) {
    throw new FontContainerError('WOFF2 fonts are not supported');
  }
  if (signature === COLLECTION_SIGNATURE) {
    throw new FontContainerError('OpenType font collections are not supported');
  }

  let sourceFormat: FontSourceFormat;
  let sfntBytes: Uint8Array<ArrayBuffer>;
  if (signature === WOFF1_SIGNATURE) {
    sourceFormat = 'woff1';
    sfntBytes = await decodeWoff1(input);
  } else if (
    signature === TRUE_TYPE_SIGNATURE
    || signature === TRUE_SIGNATURE
    || signature === TYP1_SIGNATURE
  ) {
    sourceFormat = 'truetype';
    sfntBytes = input;
  } else if (signature === OTTO_SIGNATURE) {
    sourceFormat = 'opentype';
    sfntBytes = input;
  } else {
    throw new FontContainerError('Unsupported font signature');
  }

  const tables = parseSfntTables(sfntBytes);
  const tableTags = Object.freeze(tables.map(({ tag }) => tag));
  const tags = new Set(tableTags);
  validateSupportedTables(tags);
  const outlines = outlineFormat(tags);
  if (sourceFormat === 'opentype' && outlines !== 'cff') {
    throw new FontContainerError('OpenType font does not contain supported CFF outlines');
  }

  return Object.freeze({
    sourceFormat,
    outlineFormat: outlines,
    sfntBytes,
    tableTags,
    tables,
  });
}
