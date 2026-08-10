import fontkit from '@pdf-lib/fontkit';
import { PDFDict, PDFName, type PDFDocument, type PDFFont } from 'pdf-lib';

import type { EngineErrorCode, EngineErrorDescriptor } from '../errors';
import { fingerprint } from '../fingerprint';
import type { PdfObjectRef } from '../model';
import { normaliseFontContainer } from './font-container';
import type { FontDescriptor, FontMatchKind } from './font-registry';
import type { ShapedRun } from './harfbuzz-shaper';

export type SubstituteFontAsset = Readonly<{
  bytes: Uint8Array;
  family: string;
  version: string;
  licence: 'OFL-1.1';
  source: string;
}>;

export type EmbeddedFontPlan = Readonly<{
  font: PDFFont;
  fontName: string;
  fontRef: PdfObjectRef;
  encodedText: string;
  coveredCodePoints: readonly number[];
  subset: true;
  provenance: Readonly<Omit<SubstituteFontAsset, 'bytes'>>;
}>;

export type ResolvedFontAsset = Readonly<{
  descriptor: FontDescriptor;
  bytes: Uint8Array;
  matchKind: FontMatchKind;
}>;

export type ResolvedFontRunInput = Readonly<{
  text: string;
  shapedRun: ShapedRun;
}>;

export type EmbeddedResolvedFontPlan = Readonly<{
  font: PDFFont;
  fontName: string;
  fontRef: PdfObjectRef;
  encodedTexts: readonly string[];
  coveredCodePoints: readonly number[];
  subset: boolean;
  provenance: Readonly<{
    id: string;
    hash: string;
    source: FontDescriptor['source'];
    fileName: string | null;
    postscriptName: string | null;
    version: string | null;
    matchKind: FontMatchKind;
  }>;
}>;

class FontEmbeddingError extends Error implements EngineErrorDescriptor {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'FontEmbeddingError';
    this.code = code;
  }
}

function replacementCodePoints(text: string): readonly number[] {
  return Object.freeze([
    ...new Set([...text].map((character) => character.codePointAt(0)!)),
  ]);
}

function encodedGlyphCodes(encodedText: string, glyphCount: number): readonly string[] {
  const match = /^<([0-9A-F]+)>$/i.exec(encodedText);
  if (match === null || match[1]!.length !== glyphCount * 4) {
    throw new FontEmbeddingError(
      'INTERNAL_FAILURE',
      'Embedded subset encoding does not align with the shaped glyph run',
    );
  }
  return Object.freeze(Array.from(
    { length: glyphCount },
    (_, index) => match[1]!.slice(index * 4, index * 4 + 4).toUpperCase(),
  ));
}

function utf16BeHex(text: string): string {
  let result = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0xffff) {
      result += codePoint.toString(16).padStart(4, '0');
    } else {
      const value = codePoint - 0x10000;
      result += (0xd800 + (value >> 10)).toString(16).padStart(4, '0');
      result += (0xdc00 + (value & 0x3ff)).toString(16).padStart(4, '0');
    }
  }
  return result.toUpperCase();
}

function logicalTextByGlyph(text: string, shapedRun: ShapedRun): readonly string[] {
  const characters = [...text];
  const clusters = [...new Set(shapedRun.glyphs.map(({ cluster }) => cluster))]
    .sort((left, right) => left - right);
  if (clusters.some((cluster) => cluster < 0 || cluster >= characters.length)) {
    throw new FontEmbeddingError('INTERNAL_FAILURE', 'Shaped glyph cluster is outside replacement text');
  }
  const clusterText = new Map<number, string>();
  clusters.forEach((cluster, index) => {
    const end = clusters[index + 1] ?? characters.length;
    clusterText.set(cluster, characters.slice(cluster, end).join(''));
  });
  const finalGlyphForCluster = new Map<number, number>();
  shapedRun.glyphs.forEach(({ cluster }, index) => finalGlyphForCluster.set(cluster, index));
  return Object.freeze(shapedRun.glyphs.map(({ cluster }, index) =>
    finalGlyphForCluster.get(cluster) === index ? clusterText.get(cluster)! : '\ufeff'));
}

function installLogicalToUnicode(
  document: PDFDocument,
  font: PDFFont,
  glyphCodes: readonly string[],
  logicalText: readonly string[],
): void {
  const mappings = new Map<string, string>();
  glyphCodes.forEach((code, index) => {
    const unicode = utf16BeHex(logicalText[index]!);
    const existing = mappings.get(code);
    if (existing !== undefined && existing !== unicode) {
      throw new FontEmbeddingError(
        'FONT_UNAVAILABLE',
        'One subset glyph cannot represent conflicting replacement text',
      );
    }
    mappings.set(code, unicode);
  });
  const entries = [...mappings].sort(([left], [right]) => left.localeCompare(right));
  const blocks: string[] = [];
  for (let offset = 0; offset < entries.length; offset += 100) {
    const block = entries.slice(offset, offset + 100);
    blocks.push(`${block.length} beginbfchar`);
    blocks.push(...block.map(([code, unicode]) => `<${code}> <${unicode}>`));
    blocks.push('endbfchar');
  }
  const cmap = `/CIDInit /ProcSet findresource begin\n`
    + `12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n`
    + `/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n`
    + `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n`
    + `${blocks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const dictionary = document.context.lookup(font.ref, PDFDict);
  dictionary.set(
    PDFName.of('ToUnicode'),
    document.context.register(document.context.flateStream(cmap)),
  );
}

export async function embedSubstituteFont(
  document: PDFDocument,
  shapedRun: ShapedRun,
  text: string,
  asset: SubstituteFontAsset,
): Promise<EmbeddedFontPlan> {
  if (text.length === 0 || shapedRun.glyphs.length === 0) {
    throw new FontEmbeddingError(
      'MALFORMED_INPUT',
      'Replacement text and shaped glyphs are required',
    );
  }
  if (asset.bytes.byteLength === 0) {
    throw new FontEmbeddingError('FONT_UNAVAILABLE', 'Font bytes are empty');
  }

  let parsedFont: ReturnType<typeof fontkit.create>;
  try {
    parsedFont = fontkit.create(asset.bytes);
  } catch {
    throw new FontEmbeddingError('FONT_UNAVAILABLE', 'Font bytes cannot be parsed');
  }

  const normalisedText = text.normalize('NFC');
  const coveredCodePoints = replacementCodePoints(normalisedText);
  const missing = coveredCodePoints.filter(
    (codePoint) => !parsedFont.hasGlyphForCodePoint(codePoint),
  );
  if (missing.length > 0) {
    throw new FontEmbeddingError(
      'FONT_UNAVAILABLE',
      `Substitute font does not cover code point U+${missing[0]!.toString(16).toUpperCase()}`,
    );
  }
  if (shapedRun.glyphs.some(({ glyphId }) => glyphId === 0)) {
    throw new FontEmbeddingError(
      'FONT_UNAVAILABLE',
      'Shaped replacement contains the missing-glyph identifier',
    );
  }

  document.registerFontkit(fontkit);
  const font = await document.embedFont(asset.bytes, { subset: true });
  const encodedText = font.encodeText(normalisedText).toString();
  const glyphCodes = encodedGlyphCodes(encodedText, shapedRun.glyphs.length);
  const fontkitGlyphs = parsedFont.layout(normalisedText).glyphs;
  if (fontkitGlyphs.length !== shapedRun.glyphs.length
      || fontkitGlyphs.some((glyph, index) => glyph.id !== shapedRun.glyphs[index]!.glyphId)) {
    throw new FontEmbeddingError(
      'FONT_UNAVAILABLE',
      'Substitute font layout does not match the shaped glyph run',
    );
  }
  await font.embed();
  installLogicalToUnicode(
    document,
    font,
    glyphCodes,
    logicalTextByGlyph(normalisedText, shapedRun),
  );

  return Object.freeze({
    font,
    fontName: font.name,
    fontRef: Object.freeze({
      objectNumber: font.ref.objectNumber,
      generationNumber: font.ref.generationNumber,
    }),
    encodedText,
    coveredCodePoints,
    subset: true,
    provenance: Object.freeze({
      family: asset.family,
      version: asset.version,
      licence: asset.licence,
      source: asset.source,
    }),
  });
}

export async function embedResolvedFontRuns(
  document: PDFDocument,
  runs: readonly ResolvedFontRunInput[],
  asset: ResolvedFontAsset,
): Promise<EmbeddedResolvedFontPlan> {
  if (runs.length === 0) {
    throw new FontEmbeddingError('MALFORMED_INPUT', 'At least one resolved font run is required');
  }
  if (asset.bytes.byteLength === 0) {
    throw new FontEmbeddingError('FONT_UNAVAILABLE', 'Font bytes are empty');
  }
  if (await fingerprint(asset.bytes) !== asset.descriptor.hash) {
    throw new FontEmbeddingError('STALE_REVISION', 'Resolved font bytes do not match their descriptor');
  }
  if (!asset.descriptor.inspection.embedding.documentEditingAllowed) {
    throw new FontEmbeddingError(
      'FONT_EMBEDDING_PROHIBITED',
      'Resolved font does not permit edited-document embedding',
    );
  }

  const normalised = await normaliseFontContainer(asset.bytes);
  let parsedFont: ReturnType<typeof fontkit.create>;
  try {
    parsedFont = fontkit.create(normalised.sfntBytes);
  } catch {
    throw new FontEmbeddingError('FONT_UNAVAILABLE', 'Font bytes cannot be parsed');
  }

  const normalisedRuns = runs.map(({ text, shapedRun }) => {
    const normalisedText = text.normalize('NFC');
    if (normalisedText.length === 0 || shapedRun.glyphs.length === 0) {
      throw new FontEmbeddingError(
        'MALFORMED_INPUT',
        'Resolved replacement text and shaped glyphs are required',
      );
    }
    const coveredCodePoints = replacementCodePoints(normalisedText);
    const missing = coveredCodePoints.find((codePoint) => !parsedFont.hasGlyphForCodePoint(codePoint));
    if (missing !== undefined) {
      throw new FontEmbeddingError(
        'FONT_UNAVAILABLE',
        `Resolved font does not cover code point U+${missing.toString(16).toUpperCase()}`,
      );
    }
    if (shapedRun.glyphs.some(({ glyphId }) => glyphId === 0)) {
      throw new FontEmbeddingError(
        'FONT_UNAVAILABLE',
        'Shaped replacement contains the missing-glyph identifier',
      );
    }
    const fontkitGlyphs = parsedFont.layout(normalisedText).glyphs;
    if (
      fontkitGlyphs.length !== shapedRun.glyphs.length ||
      fontkitGlyphs.some((glyph, index) => glyph.id !== shapedRun.glyphs[index]!.glyphId)
    ) {
      throw new FontEmbeddingError(
        'FONT_UNAVAILABLE',
        'Resolved font layout does not match the shaped glyph run',
      );
    }
    return Object.freeze({ normalisedText, shapedRun, coveredCodePoints });
  });

  document.registerFontkit(fontkit);
  const subset = asset.descriptor.inspection.embedding.subsettingAllowed;
  const font = await document.embedFont(normalised.sfntBytes, { subset });
  const encodedTexts = normalisedRuns.map(({ normalisedText }) =>
    font.encodeText(normalisedText).toString());
  const glyphCodes = normalisedRuns.flatMap(({ shapedRun }, index) =>
    encodedGlyphCodes(encodedTexts[index]!, shapedRun.glyphs.length));
  const logicalText = normalisedRuns.flatMap(({ normalisedText, shapedRun }) =>
    logicalTextByGlyph(normalisedText, shapedRun));
  await font.embed();
  installLogicalToUnicode(document, font, glyphCodes, logicalText);

  return Object.freeze({
    font,
    fontName: font.name,
    fontRef: Object.freeze({
      objectNumber: font.ref.objectNumber,
      generationNumber: font.ref.generationNumber,
    }),
    encodedTexts: Object.freeze(encodedTexts),
    coveredCodePoints: Object.freeze([
      ...new Set(normalisedRuns.flatMap(({ coveredCodePoints }) => coveredCodePoints)),
    ]),
    subset,
    provenance: Object.freeze({
      id: asset.descriptor.id,
      hash: asset.descriptor.hash,
      source: asset.descriptor.source,
      fileName: asset.descriptor.fileName,
      postscriptName: asset.descriptor.inspection.postscriptName,
      version: asset.descriptor.inspection.version,
      matchKind: asset.matchKind,
    }),
  });
}
