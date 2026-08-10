import type { ContentOperation } from '../content/tokeniser';
import {
  multiply,
  transformPoint,
  type Matrix,
  type Point,
} from '../geometry/matrix';
import type {
  CanonicalBounds,
  DecorationQuad,
  PdfColour,
  PdfObjectRef,
  SourceDecorationGraphic,
  StreamPathSegment,
} from '../model';

export type DecorationGraphicParseContext = Readonly<{
  pageRef: PdfObjectRef;
  streamPath: readonly StreamPathSegment[];
  referenceCount: number;
  pageMatrix: Matrix;
  initialCtm: Matrix;
}>;

type BlockFrame = Readonly<{
  operationIndex: number;
  ctm: Matrix;
}>;

function numberOperands(operation: ContentOperation, count: number): readonly number[] | null {
  if (operation.operands.length !== count) return null;
  const values = operation.operands.map((operand) =>
    operand.kind === 'number' && Number.isFinite(operand.value) ? operand.value : Number.NaN);
  return values.every(Number.isFinite) ? Object.freeze(values) : null;
}

function deviceColour(operation: ContentOperation): PdfColour | null {
  const definition: readonly [PdfColour['colourSpace'], number] | null =
    operation.operator === 'g' || operation.operator === 'G'
    ? ['DeviceGray' as const, 1]
    : operation.operator === 'rg' || operation.operator === 'RG'
      ? ['DeviceRGB' as const, 3]
      : operation.operator === 'k' || operation.operator === 'K'
        ? ['DeviceCMYK' as const, 4]
        : null;
  if (definition === null) return null;
  const components = numberOperands(operation, definition[1]);
  if (components === null || components.some((component) => component < 0 || component > 1)) {
    return null;
  }
  return Object.freeze({
    colourSpace: definition[0],
    components: Object.freeze([...components]),
  });
}

function distance(left: Point, right: Point): number {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

function midpoint(left: Point, right: Point): Point {
  return Object.freeze([(left[0] + right[0]) / 2, (left[1] + right[1]) / 2]);
}

function point(x: number, y: number): Point {
  return Object.freeze([x, y]);
}

function bounds(quad: DecorationQuad): CanonicalBounds {
  const xs = quad.map(([x]) => x);
  const ys = quad.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return Object.freeze({
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  });
}

function transformedQuad(matrix: Matrix, points: readonly [Point, Point, Point, Point]): DecorationQuad {
  return Object.freeze(points.map(([x, y]) => transformPoint(matrix, x, y))) as DecorationQuad;
}

function graphic(
  context: DecorationGraphicParseContext,
  operations: readonly ContentOperation[],
  frame: BlockFrame,
  endIndex: number,
): SourceDecorationGraphic | null {
  const block = operations.slice(frame.operationIndex + 1, endIndex);
  let ctm = frame.ctm;
  let colour: PdfColour | null = null;
  let lineWidth: number | null = null;
  let move: readonly [number, number] | null = null;
  let line: readonly [number, number] | null = null;
  let rectangle: readonly [number, number, number, number] | null = null;
  let painter: 'S' | 'f' | 'f*' | null = null;

  try {
    for (const operation of block) {
      if (operation.operator === 'cm') {
        const values = numberOperands(operation, 6);
        if (values === null) return null;
        ctm = multiply(ctm, Object.freeze([...values]) as Matrix);
        continue;
      }
      const parsedColour = deviceColour(operation);
      if (parsedColour !== null) {
        if (colour !== null) return null;
        colour = parsedColour;
        continue;
      }
      if (operation.operator === 'w') {
        const values = numberOperands(operation, 1);
        if (values === null || lineWidth !== null || !(values[0]! > 0)) return null;
        lineWidth = values[0]!;
        continue;
      }
      if (operation.operator === 'm') {
        const values = numberOperands(operation, 2);
        if (values === null || move !== null) return null;
        move = Object.freeze([values[0]!, values[1]!]);
        continue;
      }
      if (operation.operator === 'l') {
        const values = numberOperands(operation, 2);
        if (values === null || line !== null) return null;
        line = Object.freeze([values[0]!, values[1]!]);
        continue;
      }
      if (operation.operator === 're') {
        const values = numberOperands(operation, 4);
        if (values === null || rectangle !== null) return null;
        rectangle = Object.freeze([values[0]!, values[1]!, values[2]!, values[3]!]);
        continue;
      }
      if (operation.operator === 'S' || operation.operator === 'f' || operation.operator === 'f*') {
        if (operation.operands.length !== 0 || painter !== null) return null;
        painter = operation.operator;
        continue;
      }
      return null;
    }
    if (colour === null || painter === null) return null;
    const canonical = multiply(context.pageMatrix, ctm);
    let paint: SourceDecorationGraphic['paint'];
    let quad: DecorationQuad;
    let axis: SourceDecorationGraphic['axis'];
    let thickness: number;

    if (
      painter === 'S' && lineWidth !== null && move !== null && line !== null &&
      rectangle === null
    ) {
      const length = Math.hypot(line[0] - move[0], line[1] - move[1]);
      if (!(length > 0)) return null;
      const nx = -(line[1] - move[1]) / length;
      const ny = (line[0] - move[0]) / length;
      const half = lineWidth / 2;
      quad = transformedQuad(canonical, Object.freeze([
        point(move[0] - nx * half, move[1] - ny * half),
        point(line[0] - nx * half, line[1] - ny * half),
        point(line[0] + nx * half, line[1] + ny * half),
        point(move[0] + nx * half, move[1] + ny * half),
      ]));
      axis = Object.freeze([
        transformPoint(canonical, move[0], move[1]),
        transformPoint(canonical, line[0], line[1]),
      ]);
      thickness = (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2;
      paint = 'stroke';
    } else if (
      (painter === 'f' || painter === 'f*') && rectangle !== null &&
      lineWidth === null && move === null && line === null
    ) {
      const [x, y, width, height] = rectangle;
      if (width === 0 || height === 0) return null;
      const raw = transformedQuad(canonical, Object.freeze([
        point(x, y),
        point(x + width, y),
        point(x + width, y + height),
        point(x, y + height),
      ]));
      const horizontal = (distance(raw[0], raw[1]) + distance(raw[3], raw[2])) / 2;
      const vertical = (distance(raw[0], raw[3]) + distance(raw[1], raw[2])) / 2;
      if (!(horizontal > 0) || !(vertical > 0) || horizontal === vertical) return null;
      if (horizontal > vertical) {
        quad = raw;
        axis = Object.freeze([midpoint(raw[0], raw[3]), midpoint(raw[1], raw[2])]);
        thickness = vertical;
      } else {
        quad = Object.freeze([raw[0], raw[3], raw[2], raw[1]]);
        axis = Object.freeze([midpoint(raw[0], raw[1]), midpoint(raw[3], raw[2])]);
        thickness = horizontal;
      }
      paint = 'fill';
    } else {
      return null;
    }
    if (!Number.isFinite(thickness) || !(thickness > 0)) return null;
    return Object.freeze({
      address: Object.freeze({
        pageRef: context.pageRef,
        streamPath: Object.freeze([...context.streamPath]),
        operatorRange: Object.freeze({ start: frame.operationIndex, end: endIndex + 1 }),
      }),
      referenceCount: context.referenceCount,
      paint,
      axis,
      quad,
      bounds: bounds(quad),
      thickness,
      colour,
    });
  } catch {
    return null;
  }
}

export function parseDecorationGraphics(
  operations: readonly ContentOperation[],
  context: DecorationGraphicParseContext,
): readonly SourceDecorationGraphic[] {
  const output: SourceDecorationGraphic[] = [];
  const stack: BlockFrame[] = [];
  let ctm = context.initialCtm;

  for (const operation of operations) {
    if (operation.operator === 'q') {
      if (operation.operands.length === 0) {
        stack.push(Object.freeze({ operationIndex: operation.index, ctm }));
      }
      continue;
    }
    if (operation.operator === 'Q') {
      const frame = stack.pop();
      if (frame !== undefined && operation.operands.length === 0) {
        const candidate = graphic(context, operations, frame, operation.index);
        if (candidate !== null) output.push(candidate);
        ctm = frame.ctm;
      }
      continue;
    }
    if (operation.operator === 'cm') {
      const values = numberOperands(operation, 6);
      if (values !== null) {
        try {
          ctm = multiply(ctm, Object.freeze([...values]) as Matrix);
        } catch {
          // The containing block is rejected when it is parsed at Q.
        }
      }
    }
  }
  return Object.freeze(output);
}
