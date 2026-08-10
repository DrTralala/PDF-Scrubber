import fontkit from '@pdf-lib/fontkit';

import type { EngineErrorCode, EngineErrorDescriptor } from '../errors';
import { fingerprint } from '../fingerprint';
import {
  normaliseFontContainer,
  type FontOutlineFormat,
  type FontSourceFormat,
  type SfntTableRecord,
} from './font-container';

export type FontEmbeddingUsage =
  | 'installable'
  | 'editable'
  | 'preview-print'
  | 'restricted'
  | 'invalid';

export type FontEmbeddingRights = Readonly<{
  usage: FontEmbeddingUsage;
  documentEditingAllowed: boolean;
  subsettingAllowed: boolean;
  bitmapOnly: boolean;
}>;

export type FontInspection = Readonly<{
  sourceFormat: FontSourceFormat;
  outlineFormat: FontOutlineFormat;
  postscriptName: string | null;
  fullName: string | null;
  familyName: string | null;
  subfamilyName: string | null;
  version: string | null;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  capHeight: number;
  xHeight: number;
  underlinePosition: number | null;
  underlineThickness: number | null;
  strikeoutPosition: number | null;
  strikeoutThickness: number | null;
  italicAngle: number;
  weight: number;
  width: number;
  italic: boolean;
  numGlyphs: number;
  codePoints: readonly number[];
  metricsFingerprint: string;
  embedding: FontEmbeddingRights;
}>;

class FontInspectionError extends Error implements EngineErrorDescriptor {
  readonly code: EngineErrorCode;

  constructor(message: string) {
    super(message);
    this.name = 'FontInspectionError';
    this.code = 'FONT_UNAVAILABLE';
  }
}

function tableByTag(
  tables: readonly SfntTableRecord[],
  tag: string,
): SfntTableRecord | null {
  return tables.find((table) => table.tag === tag) ?? null;
}

function os2Values(
  bytes: Uint8Array,
  tables: readonly SfntTableRecord[],
): Readonly<{ weight: number; width: number; fsType: number }> {
  const table = tableByTag(tables, 'OS/2');
  if (table === null || table.length < 10) {
    return Object.freeze({ weight: 400, width: 5, fsType: 0 });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + table.offset, table.length);
  return Object.freeze({
    weight: view.getUint16(4),
    width: view.getUint16(6),
    fsType: view.getUint16(8),
  });
}

export type RawFontDecorationMetrics = Readonly<{
  underlinePosition: number | null;
  underlineThickness: number | null;
  strikeoutPosition: number | null;
  strikeoutThickness: number | null;
}>;

export function readFontDecorationMetrics(
  bytes: Uint8Array,
  tables: readonly SfntTableRecord[],
): RawFontDecorationMetrics {
  const post = tableByTag(tables, 'post');
  const os2 = tableByTag(tables, 'OS/2');
  const postAvailable = post !== null && post.length >= 12 &&
    post.offset >= 0 && post.offset + 12 <= bytes.byteLength;
  const os2Available = os2 !== null && os2.length >= 30 &&
    os2.offset >= 0 && os2.offset + 30 <= bytes.byteLength;
  const postView = postAvailable
    ? new DataView(bytes.buffer, bytes.byteOffset + post!.offset, post!.length)
    : null;
  const os2View = os2Available
    ? new DataView(bytes.buffer, bytes.byteOffset + os2!.offset, os2!.length)
    : null;
  return Object.freeze({
    underlinePosition: postView?.getInt16(8) ?? null,
    underlineThickness: postView?.getInt16(10) ?? null,
    strikeoutPosition: os2View?.getInt16(28) ?? null,
    strikeoutThickness: os2View?.getInt16(26) ?? null,
  });
}

function embeddingRights(fsType: number): FontEmbeddingRights {
  const restricted = (fsType & 0x0002) !== 0;
  const previewPrint = (fsType & 0x0004) !== 0;
  const editable = (fsType & 0x0008) !== 0;
  const usageCount = Number(restricted) + Number(previewPrint) + Number(editable);
  const usage: FontEmbeddingUsage = usageCount > 1
    ? 'invalid'
    : restricted
      ? 'restricted'
      : previewPrint
        ? 'preview-print'
        : editable
          ? 'editable'
          : 'installable';
  const bitmapOnly = (fsType & 0x0200) !== 0;
  return Object.freeze({
    usage,
    documentEditingAllowed:
      !bitmapOnly && (usage === 'installable' || usage === 'editable'),
    subsettingAllowed: (fsType & 0x0100) === 0,
    bitmapOnly,
  });
}

function finiteMetric(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new FontInspectionError(`Font ${name} metric is invalid`);
  }
  return value;
}

function optionalHeightMetric(
  value: number | undefined,
  font: ReturnType<typeof fontkit.create>,
  codePoint: number,
  fallback: number,
  name: string,
): number {
  if (Number.isFinite(value)) return value!;
  if (font.characterSet.includes(codePoint)) {
    const glyphTop = font.glyphForCodePoint(codePoint).bbox.maxY;
    if (Number.isFinite(glyphTop) && glyphTop > 0) return glyphTop;
  }
  return finiteMetric(fallback, name);
}

export async function inspectFont(source: Uint8Array): Promise<FontInspection> {
  const container = await normaliseFontContainer(source);
  let font: ReturnType<typeof fontkit.create>;
  try {
    font = fontkit.create(container.sfntBytes);
  } catch {
    throw new FontInspectionError('Font bytes cannot be parsed');
  }
  if (!Number.isSafeInteger(font.unitsPerEm) || font.unitsPerEm <= 0) {
    throw new FontInspectionError('Font units-per-em are invalid');
  }
  if (!Number.isSafeInteger(font.numGlyphs) || font.numGlyphs <= 0) {
    throw new FontInspectionError('Font glyph count is invalid');
  }

  const os2 = os2Values(container.sfntBytes, container.tables);
  const decorationMetrics = readFontDecorationMetrics(
    container.sfntBytes,
    container.tables,
  );
  const codePoints = Object.freeze(
    [...new Set(font.characterSet)]
      .filter((value) => Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff)
      .sort((left, right) => left - right),
  );
  const italicAngle = finiteMetric(font.italicAngle, 'italic angle');
  const italic = Boolean(font.head?.macStyle?.italic)
    || italicAngle !== 0
    || /italic|oblique/i.test(font.subfamilyName ?? '');
  const ascent = finiteMetric(font.ascent, 'ascent');
  const capHeight = optionalHeightMetric(
    font.capHeight,
    font,
    'H'.codePointAt(0)!,
    ascent,
    'capital height',
  );
  const metrics = Object.freeze({
    unitsPerEm: font.unitsPerEm,
    ascent,
    descent: finiteMetric(font.descent, 'descent'),
    lineGap: finiteMetric(font.lineGap, 'line gap'),
    capHeight,
    xHeight: optionalHeightMetric(
      font.xHeight,
      font,
      'x'.codePointAt(0)!,
      capHeight / 2,
      'x-height',
    ),
    ...decorationMetrics,
    italicAngle,
    weight: os2.weight,
    width: os2.width,
  });
  const metricsFingerprint = await fingerprint(
    new TextEncoder().encode(JSON.stringify(metrics)),
  );

  return Object.freeze({
    sourceFormat: container.sourceFormat,
    outlineFormat: container.outlineFormat,
    postscriptName: font.postscriptName,
    fullName: font.fullName,
    familyName: font.familyName,
    subfamilyName: font.subfamilyName,
    version: font.version,
    ...metrics,
    italic,
    numGlyphs: font.numGlyphs,
    codePoints,
    metricsFingerprint,
    embedding: embeddingRights(os2.fsType),
  });
}
