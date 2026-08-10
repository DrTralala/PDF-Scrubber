import type { EngineErrorCode, EngineErrorDescriptor } from '../errors';
import { normaliseFontContainer } from './font-container';

export type TextDirection = 'ltr' | 'rtl' | 'ttb' | 'btt';

export type ShapeTextInput = Readonly<{
  fontBytes: Uint8Array;
  text: string;
  direction?: TextDirection;
  script?: string;
  language?: string;
}>;

export type ShapedGlyph = Readonly<{
  glyphId: number;
  cluster: number;
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}>;

export type ShapedRun = Readonly<{
  glyphs: readonly ShapedGlyph[];
  direction: TextDirection;
  unitsPerEm: number;
}>;

class ShapingError extends Error implements EngineErrorDescriptor {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'ShapingError';
    this.code = code;
  }
}

function inferredDirection(text: string): TextDirection {
  return /\p{Script=Arabic}|\p{Script=Hebrew}/u.test(text) ? 'rtl' : 'ltr';
}

function codePointCluster(text: string, utf16Cluster: number): number {
  if (!Number.isSafeInteger(utf16Cluster) || utf16Cluster < 0) {
    throw new ShapingError('INTERNAL_FAILURE', 'HarfBuzz returned an invalid cluster');
  }

  let utf16Offset = 0;
  let codePointOffset = 0;
  for (const character of text) {
    if (utf16Offset >= utf16Cluster) return codePointOffset;
    utf16Offset += character.length;
    codePointOffset += 1;
  }
  if (utf16Offset === utf16Cluster) return codePointOffset;
  throw new ShapingError('INTERNAL_FAILURE', 'HarfBuzz cluster exceeds the input');
}

function finitePosition(value: number | undefined, field: string): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new ShapingError(
      'INTERNAL_FAILURE',
      `HarfBuzz returned an invalid ${field}`,
    );
  }
  return value;
}

export async function shapeText(input: ShapeTextInput): Promise<ShapedRun> {
  if (input.fontBytes.byteLength === 0) {
    throw new ShapingError('FONT_UNAVAILABLE', 'Font bytes are empty');
  }
  if (input.text.length === 0) {
    throw new ShapingError('MALFORMED_INPUT', 'Replacement text is empty');
  }

  const harfbuzz = await import('harfbuzzjs');
  const ownedBytes = (await normaliseFontContainer(input.fontBytes)).sfntBytes;
  const blob = new harfbuzz.Blob(ownedBytes.buffer);
  const face = new harfbuzz.Face(blob, 0);
  if (!Number.isSafeInteger(face.upem) || face.upem <= 0) {
    throw new ShapingError('FONT_UNAVAILABLE', 'Font units-per-em are invalid');
  }

  const font = new harfbuzz.Font(face);
  const buffer = new harfbuzz.Buffer();
  buffer.addText(input.text);
  buffer.guessSegmentProperties();

  const direction = input.direction ?? inferredDirection(input.text);
  const harfbuzzDirection = {
    ltr: harfbuzz.Direction.LTR,
    rtl: harfbuzz.Direction.RTL,
    ttb: harfbuzz.Direction.TTB,
    btt: harfbuzz.Direction.BTT,
  }[direction];
  buffer.setDirection(harfbuzzDirection);
  if (input.script !== undefined) buffer.setScript(input.script);
  if (input.language !== undefined) buffer.setLanguage(input.language);

  harfbuzz.shape(font, buffer);
  const glyphs = buffer.getGlyphInfosAndPositions().map((glyph) =>
    Object.freeze({
      glyphId: glyph.codepoint,
      cluster: codePointCluster(input.text, glyph.cluster),
      xAdvance: finitePosition(glyph.xAdvance, 'x advance'),
      yAdvance: finitePosition(glyph.yAdvance, 'y advance'),
      xOffset: finitePosition(glyph.xOffset, 'x offset'),
      yOffset: finitePosition(glyph.yOffset, 'y offset'),
    }),
  );

  if (glyphs.length === 0) {
    throw new ShapingError('FONT_UNAVAILABLE', 'Font produced no shaped glyphs');
  }

  return Object.freeze({
    glyphs: Object.freeze(glyphs),
    direction,
    unitsPerEm: face.upem,
  });
}
