import { Encodings, Font, type IFontNames } from '@pdf-lib/standard-fonts';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  type PDFDocument,
} from 'pdf-lib';

import type { StreamPathSegment } from '../model';
import { type Matrix, IDENTITY } from '../geometry/matrix';
import {
  OBJECT_STORE_ANALYSIS_ACCESS,
  type ObjectStore,
} from '../pdf/object-store';
import { PdfEngineError, decodeStreamBytes } from '../pdf/stream-codecs';
import { parseToUnicodeCMap } from './cmap';

export type DecodedGlyph = Readonly<{
  sourceCodeStart: number;
  sourceCodeEnd: number;
  sourceCode: number;
  glyphId: number | null;
  unicode: string | null;
  advance: number;
}>;

export type FontResource = Readonly<{
  resourceName: string;
  subtype: string;
  baseFont: string;
  descriptorFontFamily: string | null;
  descriptorFontName: string | null;
  standard14: boolean;
  writingMode: 0 | 1;
  embedded: boolean;
  ascent: number;
  descent: number;
  fontWeight: number | null;
  italicAngle: number | null;
  decode(sourceCodes: Uint8Array): readonly DecodedGlyph[];
}>;

export type FormResource = Readonly<{
  resourceName: string;
  path: readonly StreamPathSegment[];
  matrix: Matrix;
  referenceCount: number;
}>;

type ResourceOwner = Readonly<{
  fonts: ReadonlyMap<string, FontResource>;
  forms: ReadonlyMap<string, FormResource>;
  xObjectNames: ReadonlySet<string>;
}>;

function refTag(reference: PDFRef): string {
  return `${reference.objectNumber}:${reference.generationNumber}`;
}

function streamPathKey(path: readonly StreamPathSegment[]): string {
  return path
    .map(({ kind, ref, resourceName }) =>
      `${kind}:${ref.objectNumber}:${ref.generationNumber}:${resourceName ?? '-'}`)
    .join('/');
}

function dictionaryForReference(document: PDFDocument, reference: PDFRef): PDFDict {
  const value = document.context.lookup(reference);
  if (value instanceof PDFRawStream) return value.dict;
  if (value instanceof PDFDict) return value;
  throw new PdfEngineError('MALFORMED_INPUT', 'Resource reference is not a dictionary');
}

function resourceDictionary(
  document: PDFDocument,
  pageIndex: number,
  path: readonly StreamPathSegment[],
): PDFDict | undefined {
  const form = path.at(-1);
  if (form?.kind === 'formXObject') {
    return dictionaryForReference(
      document,
      PDFRef.of(form.ref.objectNumber, form.ref.generationNumber),
    ).lookupMaybe(PDFName.of('Resources'), PDFDict);
  }
  return document.getPage(pageIndex).node.Resources();
}

function nameValue(dictionary: PDFDict, key: string): string | undefined {
  return dictionary.lookupMaybe(PDFName.of(key), PDFName)?.decodeText();
}

function numberValue(dictionary: PDFDict, key: string): number | undefined {
  return dictionary.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber();
}

function arrayNumbers(array: PDFArray | undefined): readonly number[] | undefined {
  if (array === undefined) return undefined;
  const values: number[] = [];
  for (let index = 0; index < array.size(); index += 1) {
    const value = array.lookupMaybe(index, PDFNumber)?.asNumber();
    if (value === undefined || !Number.isFinite(value)) return undefined;
    values.push(value);
  }
  return values;
}

function standardFontName(baseFont: string): IFontNames | undefined {
  const normalised = baseFont.replace(/^[A-Z]{6}\+/, '');
  const supported = [
    'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
    'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
    'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
    'Symbol', 'ZapfDingbats',
  ];
  return supported.includes(normalised) ? normalised as IFontNames : undefined;
}

export function isStandard14Font(baseFont: string): boolean {
  return standardFontName(baseFont) !== undefined;
}

function descriptorTextValue(
  descriptor: PDFDict | undefined,
  key: 'FontFamily' | 'FontName',
): string | null {
  if (descriptor === undefined) return null;
  const value = descriptor.lookup(PDFName.of(key));
  if (!(value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString)) {
    return null;
  }
  try {
    return value.decodeText();
  } catch {
    return null;
  }
}

function inferredFontWeight(baseFont: string, descriptor?: PDFDict): number | null {
  const descriptorWeight = descriptor === undefined ? undefined : numberValue(descriptor, 'FontWeight');
  if (descriptorWeight !== undefined && descriptorWeight > 0 && descriptorWeight <= 1000) {
    return descriptorWeight;
  }
  const normalised = baseFont.replace(/^[A-Z]{6}\+/, '').toLowerCase();
  if (normalised === 'unknown') return null;
  if (normalised.includes('black') || normalised.includes('heavy')) return 900;
  if (normalised.includes('bold') || normalised.includes('demi')) return 700;
  if (normalised.includes('light')) return 300;
  return 400;
}

function inferredItalicAngle(baseFont: string, descriptor?: PDFDict): number | null {
  const descriptorAngle = descriptor === undefined ? undefined : numberValue(descriptor, 'ItalicAngle');
  if (descriptorAngle !== undefined) return descriptorAngle;
  const normalised = baseFont.replace(/^[A-Z]{6}\+/, '').toLowerCase();
  if (normalised === 'unknown') return null;
  return normalised.includes('italic') || normalised.includes('oblique') ? -12 : 0;
}

function standardFontDecoder(
  resourceName: string,
  subtype: string,
  baseFont: string,
): FontResource {
  const fontName = standardFontName(baseFont);
  if (fontName === undefined) {
    throw new PdfEngineError('MALFORMED_INPUT', 'Requested font is not Standard 14');
  }
  const metrics = Font.load(fontName);
  const encoding = fontName === 'Symbol'
    ? Encodings.Symbol
    : fontName === 'ZapfDingbats'
      ? Encodings.ZapfDingbats
      : Encodings.WinAnsi;
  const byCode = new Map<number, { unicode: string; glyphName: string }>();
  for (const codePoint of encoding.supportedCodePoints) {
    const encoded = encoding.encodeUnicodeCodePoint(codePoint);
    byCode.set(encoded.code, {
      unicode: String.fromCodePoint(codePoint),
      glyphName: encoded.name,
    });
  }
  const [fontBottom, , , fontTop] = metrics.FontBBox;
  return Object.freeze({
    resourceName,
    subtype,
    baseFont,
    descriptorFontFamily: null,
    descriptorFontName: null,
    standard14: true,
    writingMode: 0 as const,
    embedded: false,
    ascent: metrics.Ascender ?? fontTop,
    descent: metrics.Descender ?? fontBottom,
    fontWeight: inferredFontWeight(baseFont),
    italicAngle: inferredItalicAngle(baseFont),
    decode(sourceCodes: Uint8Array): readonly DecodedGlyph[] {
      return Object.freeze(Array.from(sourceCodes, (sourceCode, index) => {
        const mapping = byCode.get(sourceCode);
        return Object.freeze({
          sourceCodeStart: index,
          sourceCodeEnd: index + 1,
          sourceCode,
          glyphId: sourceCode,
          unicode: mapping?.unicode ?? null,
          advance: mapping === undefined ? 0 : (metrics.getWidthOfGlyph(mapping.glyphName) ?? 0),
        });
      }));
    },
  });
}

async function simpleFontDecoder(
  document: PDFDocument,
  resourceName: string,
  subtype: string,
  dictionary: PDFDict,
  baseFont: string,
  maxDecodedStreamBytes: number,
): Promise<FontResource> {
  const firstCharacter = numberValue(dictionary, 'FirstChar') ?? 0;
  const widthValues = arrayNumbers(dictionary.lookupMaybe(PDFName.of('Widths'), PDFArray)) ?? [];
  const widths = new Map<number, number>(
    widthValues.map((width, index) => [firstCharacter + index, width]),
  );
  const descriptor = dictionary.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  const defaultWidth = descriptor === undefined
    ? 0
    : numberValue(descriptor, 'MissingWidth') ?? 0;
  const toUnicodeValue = dictionary.get(PDFName.of('ToUnicode'));
  const resolvedToUnicode = toUnicodeValue === undefined
    ? undefined
    : document.context.lookup(toUnicodeValue);
  const unicode = resolvedToUnicode instanceof PDFRawStream
    ? parseToUnicodeCMap(await decodeStreamBytes(resolvedToUnicode, maxDecodedStreamBytes))
    : undefined;
  const embedded = descriptor !== undefined && ['FontFile', 'FontFile2', 'FontFile3'].some(
    (key) => descriptor.get(PDFName.of(key)) !== undefined,
  );
  return Object.freeze({
    resourceName,
    subtype,
    baseFont,
    descriptorFontFamily: descriptorTextValue(descriptor, 'FontFamily'),
    descriptorFontName: descriptorTextValue(descriptor, 'FontName'),
    standard14: false,
    writingMode: 0 as const,
    embedded,
    ascent: descriptor === undefined ? 1000 : numberValue(descriptor, 'Ascent') ?? 1000,
    descent: descriptor === undefined ? 0 : numberValue(descriptor, 'Descent') ?? 0,
    fontWeight: inferredFontWeight(baseFont, descriptor),
    italicAngle: inferredItalicAngle(baseFont, descriptor),
    decode(sourceCodes: Uint8Array): readonly DecodedGlyph[] {
      return Object.freeze(Array.from(sourceCodes, (sourceCode, index) => Object.freeze({
        sourceCodeStart: index,
        sourceCodeEnd: index + 1,
        sourceCode,
        glyphId: sourceCode,
        unicode: unicode?.decode(Uint8Array.of(sourceCode)) ?? null,
        advance: widths.get(sourceCode) ?? defaultWidth,
      })));
    },
  });
}

function cidWidths(descendant: PDFDict): ReadonlyMap<number, number> {
  const widths = new Map<number, number>();
  const values = descendant.lookupMaybe(PDFName.of('W'), PDFArray);
  if (values === undefined) return widths;
  let index = 0;
  while (index < values.size()) {
    const first = values.lookupMaybe(index, PDFNumber)?.asNumber();
    if (first === undefined) break;
    const secondArray = values.lookupMaybe(index + 1, PDFArray);
    if (secondArray !== undefined) {
      for (let item = 0; item < secondArray.size(); item += 1) {
        const width = secondArray.lookupMaybe(item, PDFNumber)?.asNumber();
        if (width !== undefined) widths.set(first + item, width);
      }
      index += 2;
      continue;
    }
    const last = values.lookupMaybe(index + 1, PDFNumber)?.asNumber();
    const width = values.lookupMaybe(index + 2, PDFNumber)?.asNumber();
    if (last === undefined || width === undefined) break;
    for (let code = first; code <= last; code += 1) widths.set(code, width);
    index += 3;
  }
  return widths;
}

async function type0FontDecoder(
  document: PDFDocument,
  resourceName: string,
  dictionary: PDFDict,
  baseFont: string,
  maxDecodedStreamBytes: number,
): Promise<FontResource> {
  const descendants = dictionary.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
  const descendant = descendants?.lookupMaybe(0, PDFDict);
  if (descendant === undefined) {
    throw new PdfEngineError('MALFORMED_INPUT', 'Type0 font lacks a descendant font');
  }
  const toUnicodeValue = dictionary.get(PDFName.of('ToUnicode'));
  const resolvedToUnicode = toUnicodeValue === undefined
    ? undefined
    : document.context.lookup(toUnicodeValue);
  const toUnicode = resolvedToUnicode instanceof PDFRawStream ? resolvedToUnicode : undefined;
  const unicode = toUnicode === undefined
    ? undefined
    : parseToUnicodeCMap(await decodeStreamBytes(toUnicode, maxDecodedStreamBytes));
  const widths = cidWidths(descendant);
  const defaultWidth = numberValue(descendant, 'DW') ?? 1000;
  const descriptor = descendant.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  const embedded = descriptor !== undefined && ['FontFile', 'FontFile2', 'FontFile3'].some(
    (key) => descriptor.get(PDFName.of(key)) !== undefined,
  );
  const encoding = nameValue(dictionary, 'Encoding');
  const writingMode = encoding?.endsWith('-V') === true ? 1 : 0;
  void document;
  return Object.freeze({
    resourceName,
    subtype: 'Type0',
    baseFont,
    descriptorFontFamily: descriptorTextValue(descriptor, 'FontFamily'),
    descriptorFontName: descriptorTextValue(descriptor, 'FontName'),
    standard14: false,
    writingMode,
    embedded,
    ascent: descriptor === undefined ? 1000 : numberValue(descriptor, 'Ascent') ?? 1000,
    descent: descriptor === undefined ? 0 : numberValue(descriptor, 'Descent') ?? 0,
    fontWeight: inferredFontWeight(baseFont, descriptor),
    italicAngle: inferredItalicAngle(baseFont, descriptor),
    decode(sourceCodes: Uint8Array): readonly DecodedGlyph[] {
      if (sourceCodes.length % 2 !== 0) {
        throw new PdfEngineError('UNSUPPORTED_DOCUMENT', 'Identity Type0 source code is truncated');
      }
      const glyphs: DecodedGlyph[] = [];
      for (let offset = 0; offset < sourceCodes.length; offset += 2) {
        const code = sourceCodes[offset]! * 256 + sourceCodes[offset + 1]!;
        glyphs.push(Object.freeze({
          sourceCodeStart: offset,
          sourceCodeEnd: offset + 2,
          sourceCode: code,
          glyphId: code,
          unicode: unicode?.decode(sourceCodes.slice(offset, offset + 2)) ?? null,
          advance: widths.get(code) ?? defaultWidth,
        }));
      }
      return Object.freeze(glyphs);
    },
  });
}

async function buildFont(
  document: PDFDocument,
  resourceName: string,
  value: unknown,
  maxDecodedStreamBytes: number,
): Promise<FontResource> {
  const dictionary = value instanceof PDFRef
    ? dictionaryForReference(document, value)
    : value instanceof PDFDict
      ? value
      : undefined;
  if (dictionary === undefined) {
    throw new PdfEngineError('MALFORMED_INPUT', 'Font resource is not a dictionary');
  }
  const subtype = nameValue(dictionary, 'Subtype') ?? 'Unknown';
  const baseFont = nameValue(dictionary, 'BaseFont') ?? 'Unknown';
  if (subtype === 'Type0') {
    return type0FontDecoder(
      document,
      resourceName,
      dictionary,
      baseFont,
      maxDecodedStreamBytes,
    );
  }
  return standardFontName(baseFont) === undefined
    ? simpleFontDecoder(
        document,
        resourceName,
        subtype,
        dictionary,
        baseFont,
        maxDecodedStreamBytes,
      )
    : standardFontDecoder(resourceName, subtype, baseFont);
}

function formMatrix(dictionary: PDFDict): Matrix {
  const values = arrayNumbers(dictionary.lookupMaybe(PDFName.of('Matrix'), PDFArray));
  if (values === undefined) return IDENTITY;
  if (values.length !== 6) {
    throw new PdfEngineError('MALFORMED_INPUT', 'Form Matrix must contain six numbers');
  }
  return Object.freeze(values) as Matrix;
}

export class ResourceIndex {
  readonly #owners: ReadonlyMap<string, ResourceOwner>;

  private constructor(owners: ReadonlyMap<string, ResourceOwner>) {
    this.#owners = owners;
  }

  static async build(store: ObjectStore, pageIndex: number): Promise<ResourceIndex> {
    const { document, limits } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
    const streams = store.listPageStreams(pageIndex);
    const owners = new Map<string, ResourceOwner>();
    for (const stream of streams) {
      const resources = resourceDictionary(document, pageIndex, stream.path);
      const fonts = new Map<string, FontResource>();
      const fontDictionary = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
      if (fontDictionary !== undefined) {
        for (const [name, value] of fontDictionary.entries()) {
          const resourceName = name.decodeText();
          fonts.set(
            resourceName,
            await buildFont(document, resourceName, value, limits.maxDecodedStreamBytes),
          );
        }
      }

      const forms = new Map<string, FormResource>();
      const xObjectNames = new Set<string>();
      const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (xObjects !== undefined) {
        for (const [name, value] of xObjects.entries()) {
          const resourceName = name.decodeText();
          xObjectNames.add(resourceName);
          if (!(value instanceof PDFRef)) continue;
          const dictionary = dictionaryForReference(document, value);
          if (nameValue(dictionary, 'Subtype') !== 'Form') continue;
          const child = streams.find(({ path }) => {
            const segment = path.at(-1);
            return path.length === stream.path.length + 1 &&
              streamPathKey(path.slice(0, -1)) === streamPathKey(stream.path) &&
              segment?.resourceName === resourceName &&
              segment.ref.objectNumber === value.objectNumber &&
              segment.ref.generationNumber === value.generationNumber;
          });
          if (child === undefined) continue;
          forms.set(resourceName, Object.freeze({
            resourceName,
            path: child.path,
            matrix: formMatrix(dictionary),
            referenceCount: child.referenceCount,
          }));
        }
      }
      owners.set(streamPathKey(stream.path), Object.freeze({ fonts, forms, xObjectNames }));
    }
    return new ResourceIndex(owners);
  }

  #owner(path: readonly StreamPathSegment[]): ResourceOwner {
    const owner = this.#owners.get(streamPathKey(path));
    if (owner === undefined) {
      throw new PdfEngineError('MALFORMED_INPUT', 'Resource path is not indexed');
    }
    return owner;
  }

  fontNames(path: readonly StreamPathSegment[]): readonly string[] {
    return Object.freeze([...this.#owner(path).fonts.keys()].sort());
  }

  font(path: readonly StreamPathSegment[], resourceName: string): FontResource {
    const font = this.#owner(path).fonts.get(resourceName);
    if (font === undefined) {
      throw new PdfEngineError('UNSUPPORTED_DOCUMENT', 'Font resource does not resolve', {
        resourceName,
      });
    }
    return font;
  }

  formNames(path: readonly StreamPathSegment[]): readonly string[] {
    return Object.freeze([...this.#owner(path).forms.keys()].sort());
  }

  form(path: readonly StreamPathSegment[], resourceName: string): FormResource | null {
    const owner = this.#owner(path);
    const form = owner.forms.get(resourceName);
    if (form === undefined) {
      if (owner.xObjectNames.has(resourceName)) return null;
      throw new PdfEngineError('UNSUPPORTED_DOCUMENT', 'Form resource does not resolve', {
        resourceName,
      });
    }
    return form;
  }
}
