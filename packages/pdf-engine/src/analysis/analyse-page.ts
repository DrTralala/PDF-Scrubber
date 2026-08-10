import { PDFName, PDFNumber } from 'pdf-lib';

import { decodeTextOperand } from '../content/operands';
import { parseControlledRedraw, type ControlledRedraw } from '../content/controlled-redraw';
import { classifyBaseline } from '../classification/classify';
import type { ContentOperation, PdfOperand } from '../content/tokeniser';
import { tokeniseContentStream } from '../content/tokeniser';
import {
  IDENTITY,
  multiply,
  transformPoint,
  type Matrix,
  type Point,
} from '../geometry/matrix';
import { pdfToCanonical, type PageBox, type PageSpace } from '../geometry/page-space';
import type {
  AnalysedGlyph,
  AnalysedPage,
  AnalysedSpan,
  CanonicalBounds,
  EffectiveTextStyle,
  PdfColour,
  PdfObjectRef,
  SourceDecorationGraphic,
  StreamPathSegment,
} from '../model';
import { DEFAULT_TEXT_DECORATIONS } from '../model';
import {
  OBJECT_STORE_ANALYSIS_ACCESS,
  type ObjectStore,
} from '../pdf/object-store';
import { PdfEngineError } from '../pdf/stream-codecs';
import { parseDecorationGraphics } from './decoration-graphics';
import { ResourceIndex, type DecodedGlyph, type FontResource } from './resources';
import {
  advanceTextMatrix,
  applyTextStateOperation,
  createTextState,
  type TextState,
} from './text-state';

type GraphicsState = Readonly<{
  ctm: Matrix;
  text: TextState;
  fillColour: PdfColour;
  strokeColour: PdfColour;
}>;

type AnalysisCursor = Readonly<{
  state: GraphicsState;
  stack: readonly GraphicsState[];
}>;

function pdfReference(objectNumber: number, generationNumber: number): PdfObjectRef {
  return Object.freeze({ objectNumber, generationNumber });
}

function pageSpace(store: ObjectStore, pageIndex: number): PageSpace {
  const { document } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const page = document.getPage(pageIndex);
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const userUnit = page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber)?.asNumber() ?? 1;
  const mediaBox: PageBox = Object.freeze([
    media.x,
    media.y,
    media.x + media.width,
    media.y + media.height,
  ]);
  const cropBox: PageBox = Object.freeze([
    crop.x,
    crop.y,
    crop.x + crop.width,
    crop.y + crop.height,
  ]);
  return Object.freeze({
    mediaBox,
    cropBox,
    rotate: page.getRotation().angle,
    userUnit,
  });
}

function numberOperand(operation: ContentOperation, index: number): number {
  const operand = operation.operands[index];
  if (operand?.kind !== 'number' || !Number.isFinite(operand.value)) {
    throw new PdfEngineError(
      'UNSUPPORTED_DOCUMENT',
      `${operation.operator} requires a finite numeric operand`,
    );
  }
  return operand.value;
}

function nameOperand(operation: ContentOperation, index: number): string {
  const operand = operation.operands[index];
  if (operand?.kind !== 'name') {
    throw new PdfEngineError(
      'UNSUPPORTED_DOCUMENT',
      `${operation.operator} requires a name operand`,
    );
  }
  return operand.value;
}

function textOperand(operation: ContentOperation): PdfOperand {
  const index = operation.operator === '"' ? 2 : 0;
  const operand = operation.operands[index];
  if (operand === undefined) {
    throw new PdfEngineError(
      'UNSUPPORTED_DOCUMENT',
      `${operation.operator} lacks its text operand`,
    );
  }
  return operand;
}

function adjustmentAdvance(
  operand: PdfOperand,
  fontSize: number,
  horizontalScaling: number,
): number {
  if (operand.kind !== 'array') return 0;
  return operand.items.reduce(
    (total, item) => item.kind === 'number'
      ? total - item.value / 1000 * fontSize * horizontalScaling
      : total,
    0,
  );
}

function colour(
  colourSpace: PdfColour['colourSpace'],
  components: readonly number[],
): PdfColour {
  return Object.freeze({
    colourSpace,
    components: Object.freeze([...components]),
  });
}

const BLACK = colour('DeviceGray', [0]);

function colourComponents(operation: ContentOperation, count: number): readonly number[] {
  if (operation.operands.length !== count) {
    throw new PdfEngineError(
      'MALFORMED_INPUT',
      `${operation.operator} requires ${count} colour components`,
    );
  }
  return Object.freeze(operation.operands.map((_operand, index) => numberOperand(operation, index)));
}

function applyDeviceColourOperation(
  state: GraphicsState,
  operation: ContentOperation,
): GraphicsState | null {
  switch (operation.operator) {
    case 'g':
      return Object.freeze({
        ...state,
        fillColour: colour('DeviceGray', colourComponents(operation, 1)),
      });
    case 'G':
      return Object.freeze({
        ...state,
        strokeColour: colour('DeviceGray', colourComponents(operation, 1)),
      });
    case 'rg':
      return Object.freeze({
        ...state,
        fillColour: colour('DeviceRGB', colourComponents(operation, 3)),
      });
    case 'RG':
      return Object.freeze({
        ...state,
        strokeColour: colour('DeviceRGB', colourComponents(operation, 3)),
      });
    case 'k':
      return Object.freeze({
        ...state,
        fillColour: colour('DeviceCMYK', colourComponents(operation, 4)),
      });
    case 'K':
      return Object.freeze({
        ...state,
        strokeColour: colour('DeviceCMYK', colourComponents(operation, 4)),
      });
    default:
      return null;
  }
}

function glyphAdvance(
  glyph: DecodedGlyph,
  font: FontResource,
  state: TextState,
  includeTextSpacing = true,
): number {
  const textSpacing = includeTextSpacing
    ? state.characterSpacing
      + (glyph.unicode === ' ' || glyph.sourceCode === 0x20
        ? state.wordSpacing
        : 0)
    : 0;
  return (glyph.advance / 1000 * state.fontSize + textSpacing)
    * state.horizontalScaling;
}

function immutablePoint(point: Point): Point {
  return Object.freeze([...point]) as Point;
}

function boundsFromCorners(corners: readonly Point[]): CanonicalBounds {
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return Object.freeze({
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  });
}

type GlyphPlacement = Readonly<{
  glyph: DecodedGlyph;
  advance: number;
  offset: number;
}>;

function glyphPlacements(
  operand: PdfOperand,
  decoded: readonly DecodedGlyph[],
  advances: readonly number[],
  fontSize: number,
  horizontalScaling: number,
): readonly GlyphPlacement[] {
  const placements: GlyphPlacement[] = [];
  let glyphIndex = 0;
  let cursor = 0;
  let codeOffset = 0;
  const appendString = (length: number): void => {
    const itemEnd = codeOffset + length;
    while (glyphIndex < decoded.length) {
      const glyph = decoded[glyphIndex]!;
      if (glyph.sourceCodeStart >= itemEnd) break;
      if (glyph.sourceCodeStart < codeOffset || glyph.sourceCodeEnd > itemEnd) {
        throw new PdfEngineError(
          'UNSUPPORTED_DOCUMENT',
          'A decoded glyph crosses a PDF string boundary',
        );
      }
      const advance = advances[glyphIndex]!;
      placements.push(Object.freeze({ glyph, advance, offset: cursor }));
      cursor += advance;
      glyphIndex += 1;
    }
    codeOffset = itemEnd;
  };

  if (operand.kind === 'literalString' || operand.kind === 'hexString') {
    appendString(operand.value.length);
  } else if (operand.kind === 'array') {
    for (const item of operand.items) {
      if (item.kind === 'number') {
        cursor -= item.value / 1000 * fontSize * horizontalScaling;
      } else if (item.kind === 'literalString' || item.kind === 'hexString') {
        appendString(item.value.length);
      }
    }
  }
  if (glyphIndex !== decoded.length) {
    throw new PdfEngineError('UNSUPPORTED_DOCUMENT', 'Decoded glyph placement is incomplete');
  }
  return Object.freeze(placements);
}

function textStyle(state: GraphicsState, font: FontResource): EffectiveTextStyle {
  return Object.freeze({
    fontResourceName: font.resourceName,
    fontBaseName: font.baseFont,
    fontSize: state.text.fontSize,
    horizontalScaling: state.text.horizontalScaling,
    characterSpacing: state.text.characterSpacing,
    wordSpacing: state.text.wordSpacing,
    rise: state.text.rise,
    renderingMode: state.text.renderingMode,
    fillColour: state.fillColour,
    strokeColour: state.strokeColour,
    fontWeight: font.fontWeight,
    italicAngle: font.italicAngle,
  });
}

function analysedGlyphs(
  placements: readonly GlyphPlacement[],
  path: readonly StreamPathSegment[],
  pageRef: PdfObjectRef,
  operationIndex: number,
  renderMatrix: Matrix,
  bottom: number,
  top: number,
  rise: number,
  styleKey: string,
  style: EffectiveTextStyle,
): readonly AnalysedGlyph[] {
  const streamPath = Object.freeze([...path]);
  return Object.freeze(placements.map(({ glyph, advance, offset }, glyphIndex) => {
    const corners = [
      transformPoint(renderMatrix, offset, bottom),
      transformPoint(renderMatrix, offset + advance, bottom),
      transformPoint(renderMatrix, offset, top),
      transformPoint(renderMatrix, offset + advance, top),
    ];
    return Object.freeze({
      glyphIndex,
      sourceCodeStart: glyph.sourceCodeStart,
      sourceCodeEnd: glyph.sourceCodeEnd,
      sourceCode: glyph.sourceCode,
      glyphId: glyph.glyphId,
      unicode: glyph.unicode,
      advance,
      source: Object.freeze({
        pageRef,
        streamPath,
        operatorIndex: operationIndex,
        glyphIndex,
        sourceCodeRange: Object.freeze({
          start: glyph.sourceCodeStart,
          end: glyph.sourceCodeEnd,
        }),
      }),
      mutationAddress: Object.freeze({
        pageRef,
        streamPath,
        operatorRange: Object.freeze({
          start: operationIndex,
          end: operationIndex + 1,
        }),
        glyphRange: Object.freeze({
          start: glyphIndex,
          end: glyphIndex + 1,
        }),
      }),
      bounds: boundsFromCorners(corners),
      baseline: immutablePoint(transformPoint(renderMatrix, offset, rise)),
      styleKey,
      style,
      decorations: DEFAULT_TEXT_DECORATIONS,
    });
  }));
}

function mergeControlledSpans(
  spans: readonly AnalysedSpan[],
  controlled: ControlledRedraw,
  operationCount: number,
): AnalysedSpan | null {
  if (
    spans.length !== controlled.textOperationIndexes.length ||
    spans.some((span, index) =>
      span.address.operatorRange.start !== controlled.textOperationIndexes[index] ||
      span.resource.fontResourceName !== controlled.textFontResourceNames[index])
  ) return null;
  const first = spans[0];
  if (first === undefined) return null;

  let sourceOffset = 0;
  const sourceGlyphs = spans.flatMap((span, spanIndex) => span.glyphs.map((glyph) => {
    const sourceLength = glyph.sourceCodeEnd - glyph.sourceCodeStart;
    const rebased = Object.freeze({
      ...glyph,
      glyphIndex: 0,
      sourceCodeStart: sourceOffset,
      sourceCodeEnd: sourceOffset + sourceLength,
      decorations: controlled.textRunIndexes === null || controlled.runDecorations === null
        ? DEFAULT_TEXT_DECORATIONS
        : controlled.runDecorations[controlled.textRunIndexes[spanIndex]!] ??
          DEFAULT_TEXT_DECORATIONS,
    });
    sourceOffset += sourceLength;
    return rebased;
  })).map((glyph, glyphIndex) => Object.freeze({ ...glyph, glyphIndex }));
  if (sourceGlyphs.length === 0) return null;

  const controlledAddress = Object.freeze({
    ...first.address,
    operatorRange: Object.freeze({ start: 0, end: operationCount }),
    glyphRange: Object.freeze({ start: 0, end: sourceGlyphs.length }),
  });
  const glyphs = sourceGlyphs.map((glyph) => Object.freeze({
    ...glyph,
    mutationAddress: controlledAddress,
  }));

  const left = Math.min(...spans.map(({ bounds }) => bounds.x));
  const bottom = Math.min(...spans.map(({ bounds }) => bounds.y));
  const right = Math.max(...spans.map(({ bounds }) => bounds.x + bounds.width));
  const top = Math.max(...spans.map(({ bounds }) => bounds.y + bounds.height));
  const provisional: AnalysedSpan = Object.freeze({
    ...first,
    address: controlledAddress,
    unicode: controlled.actualText,
    bounds: Object.freeze({ x: left, y: bottom, width: right - left, height: top - bottom }),
    glyphs: Object.freeze(glyphs),
  });
  return Object.freeze({ ...provisional, capability: classifyBaseline(provisional) });
}

function makeSpan(
  operation: ContentOperation,
  path: readonly StreamPathSegment[],
  referenceCount: number,
  pageRef: PdfObjectRef,
  canonicalMatrix: Matrix,
  state: GraphicsState,
  font: FontResource,
  explicitlyPositioned: boolean,
): Readonly<{ span: AnalysedSpan | null; advance: number }> {
  const text = state.text;
  if (!text.inTextObject || text.fontResourceName === null || text.fontSize <= 0) {
    throw new PdfEngineError(
      'UNSUPPORTED_DOCUMENT',
      'Text-showing operator lacks an active text object and font',
    );
  }
  const operand = textOperand(operation);
  const decoded = font.decode(decodeTextOperand(operand));
  if (decoded.length === 0) {
    return Object.freeze({
      span: null,
      advance: adjustmentAdvance(operand, text.fontSize, text.horizontalScaling),
    });
  }
  const advances = decoded.map((glyph) =>
    glyphAdvance(glyph, font, text, !explicitlyPositioned));
  const placements = glyphPlacements(
    operand,
    decoded,
    advances,
    text.fontSize,
    text.horizontalScaling,
  );
  const advance = advances.reduce((total, value) => total + value, 0) +
    adjustmentAdvance(operand, text.fontSize, text.horizontalScaling);
  if (!Number.isFinite(advance)) {
    throw new PdfEngineError('UNSUPPORTED_DOCUMENT', 'Text advance is not finite');
  }

  const renderMatrix = multiply(canonicalMatrix, text.textMatrix);
  const bottom = font.descent / 1000 * text.fontSize + text.rise;
  const top = font.ascent / 1000 * text.fontSize + text.rise;
  const corners = [
    transformPoint(renderMatrix, 0, bottom),
    transformPoint(renderMatrix, advance, bottom),
    transformPoint(renderMatrix, 0, top),
    transformPoint(renderMatrix, advance, top),
  ];
  const baseline = immutablePoint(transformPoint(renderMatrix, 0, text.rise));
  const unicode = decoded.every(({ unicode: value }) => value !== null)
    ? decoded.map(({ unicode: value }) => value).join('')
    : null;
  const style = textStyle(state, font);
  const styleKey = JSON.stringify(style);
  const glyphs = analysedGlyphs(
    placements,
    path,
    pageRef,
    operation.index,
    renderMatrix,
    bottom,
    top,
    text.rise,
    styleKey,
    style,
  );
  const provisionalCapability = unicode === null
    ? Object.freeze({ kind: 'readOnly' as const, reasons: Object.freeze(['unsupportedEncoding' as const]) })
    : Object.freeze({ kind: 'safeReplacement' as const, reasons: Object.freeze(['supportedExistingFont' as const]) });
  const provisionalSpan: AnalysedSpan = Object.freeze({
    address: Object.freeze({
      pageRef,
      streamPath: Object.freeze([...path]),
      operatorRange: Object.freeze({ start: operation.index, end: operation.index + 1 }),
      glyphRange: Object.freeze({ start: 0, end: glyphs.length }),
    }),
    unicode,
    bounds: boundsFromCorners(corners),
    baseline,
    glyphs,
    styleKey,
    style,
    fontSize: text.fontSize,
    horizontalScaling: text.horizontalScaling,
    textMatrix: text.textMatrix,
    renderMatrix,
    resource: Object.freeze({
      fontResourceName: font.resourceName,
      fontBaseName: font.baseFont,
      fontSubtype: font.subtype,
      fontEmbedded: font.embedded,
      writingMode: font.writingMode,
      referenceCount,
      fontWeight: font.fontWeight,
      italicAngle: font.italicAngle,
    }),
    capability: provisionalCapability,
  });
  return Object.freeze({
    advance,
    span: Object.freeze({
      ...provisionalSpan,
      capability: classifyBaseline(provisionalSpan),
    }),
  });
}

const TEXT_SHOWING_OPERATORS = new Set(['Tj', 'TJ', "'", '"']);
const TEXT_STATE_OPERATORS = new Set([
  'BT', 'ET', 'Tf', 'Tm', 'Td', 'TD', 'T*', 'Tc', 'Tw', 'Tz', 'TL', 'Ts', 'Tr',
]);

async function analyseStream(
  store: ObjectStore,
  resources: ResourceIndex,
  pageIndex: number,
  pageRef: PdfObjectRef,
  pageMatrix: Matrix,
  path: readonly StreamPathSegment[],
  initial: AnalysisCursor,
  output: AnalysedSpan[],
  decorationGraphics: SourceDecorationGraphic[],
): Promise<AnalysisCursor> {
  const stream = store.resolveStreamPath(pageIndex, path);
  const operations = tokeniseContentStream(
    stream.decodedBytes,
    store[OBJECT_STORE_ANALYSIS_ACCESS]().limits,
  );
  const controlled = parseControlledRedraw(operations);
  if (controlled === null) {
    decorationGraphics.push(...parseDecorationGraphics(operations, {
      pageRef,
      streamPath: path,
      referenceCount: stream.referenceCount,
      pageMatrix,
      initialCtm: initial.state.ctm,
    }));
  }
  const outputStart = output.length;
  let state = initial.state;
  const stack: GraphicsState[] = [...initial.stack];

  for (const operation of operations) {
    if (operation.operator === 'q') {
      if (operation.operands.length !== 0) {
        throw new PdfEngineError('MALFORMED_INPUT', 'q has operands');
      }
      stack.push(state);
      continue;
    }
    if (operation.operator === 'Q') {
      const restored = stack.pop();
      if (restored === undefined) {
        throw new PdfEngineError('MALFORMED_INPUT', 'Graphics-state stack underflow');
      }
      state = restored;
      continue;
    }
    if (operation.operator === 'cm') {
      if (operation.operands.length !== 6) {
        throw new PdfEngineError('MALFORMED_INPUT', 'cm requires six operands');
      }
      const matrix = Object.freeze(operation.operands.map((_operand, index) =>
        numberOperand(operation, index))) as unknown as Matrix;
      state = Object.freeze({ ...state, ctm: multiply(state.ctm, matrix) });
      continue;
    }
    if (operation.operator === 'Do') {
      if (operation.operands.length !== 1) {
        throw new PdfEngineError('MALFORMED_INPUT', 'Do requires one operand');
      }
      const form = resources.form(path, nameOperand(operation, 0));
      if (form === null) continue;
      const formCursor = await analyseStream(
        store,
        resources,
        pageIndex,
        pageRef,
        pageMatrix,
        form.path,
        Object.freeze({
          state: Object.freeze({
            ctm: multiply(state.ctm, form.matrix),
            text: createTextState(),
            fillColour: state.fillColour,
            strokeColour: state.strokeColour,
          }),
          stack: Object.freeze([]),
        }),
        output,
        decorationGraphics,
      );
      if (formCursor.stack.length !== 0) {
        throw new PdfEngineError('MALFORMED_INPUT', 'Form graphics-state stack is not balanced');
      }
      continue;
    }

    if (TEXT_SHOWING_OPERATORS.has(operation.operator)) {
      let text = operation.operator === "'" || operation.operator === '"'
        ? applyTextStateOperation(state.text, operation)
        : state.text;
      const fontName = text.fontResourceName;
      if (fontName === null) {
        throw new PdfEngineError('UNSUPPORTED_DOCUMENT', 'Text has no active font');
      }
      const font = resources.font(path, fontName);
      const result = makeSpan(
        operation,
        path,
        stream.referenceCount,
        pageRef,
        multiply(pageMatrix, state.ctm),
        Object.freeze({ ...state, text }),
        font,
        controlled?.textOperationIndexes.includes(operation.index) ?? false,
      );
      if (result.span !== null) output.push(result.span);
      text = advanceTextMatrix(text, result.advance);
      state = Object.freeze({ ...state, text });
      continue;
    }
    if (TEXT_STATE_OPERATORS.has(operation.operator)) {
      state = Object.freeze({
        ...state,
        text: applyTextStateOperation(state.text, operation),
      });
      continue;
    }
    const coloured = applyDeviceColourOperation(state, operation);
    if (coloured !== null) state = coloured;
  }
  if (controlled !== null) {
    const merged = mergeControlledSpans(output.slice(outputStart), controlled, operations.length);
    if (merged !== null) output.splice(outputStart, output.length - outputStart, merged);
  }
  return Object.freeze({ state, stack: Object.freeze(stack) });
}

export async function analysePage(store: ObjectStore, pageIndex: number): Promise<AnalysedPage> {
  const { document } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const page = document.getPage(pageIndex);
  const pageRef = pdfReference(page.ref.objectNumber, page.ref.generationNumber);
  const resources = await ResourceIndex.build(store, pageIndex);
  const space = pageSpace(store, pageIndex);
  const pageMatrix = pdfToCanonical(space);
  const spans: AnalysedSpan[] = [];
  const decorationGraphics: SourceDecorationGraphic[] = [];
  let cursor: AnalysisCursor = Object.freeze({
    state: Object.freeze({
      ctm: IDENTITY,
      text: createTextState(),
      fillColour: BLACK,
      strokeColour: BLACK,
    }),
    stack: Object.freeze([]),
  });
  for (const stream of store.listPageStreams(pageIndex).filter(({ path }) => path.length === 1)) {
    cursor = await analyseStream(
      store,
      resources,
      pageIndex,
      pageRef,
      pageMatrix,
      stream.path,
      cursor,
      spans,
      decorationGraphics,
    );
  }
  if (cursor.stack.length !== 0) {
    throw new PdfEngineError('MALFORMED_INPUT', 'Page graphics-state stack is not balanced');
  }
  return Object.freeze({
    pageIndex,
    pageRef,
    pageSpace: space,
    spans: Object.freeze(spans),
    decorationGraphics: Object.freeze(decorationGraphics),
    graphicsState: Object.freeze({
      balanced: true,
      finalCtm: Object.freeze([...cursor.state.ctm]) as Matrix,
    }),
  });
}
