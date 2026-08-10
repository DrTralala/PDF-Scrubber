import type { CapabilityReason } from '../model';

export type Matrix = readonly [number, number, number, number, number, number];
export type Point = readonly [number, number];

export const IDENTITY: Matrix = Object.freeze([1, 0, 0, 1, 0, 0]);

export class AmbiguousTransformError extends Error {
  readonly reason: Extract<CapabilityReason, 'ambiguousTransform'> =
    'ambiguousTransform';

  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousTransformError';
  }
}

function assertFinite(values: readonly number[], context: string): void {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new AmbiguousTransformError(`${context} contains a non-finite value`);
  }
}

function determinantOf(matrix: Matrix, context: string): number {
  assertFinite(matrix, context);
  const [a, b, c, d] = matrix;
  const determinant = a * d - b * c;
  const linearScale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  if (
    !Number.isFinite(determinant) ||
    linearScale === 0 ||
    Math.abs(determinant) <= Number.EPSILON * linearScale * linearScale
  ) {
    throw new AmbiguousTransformError(`${context} is singular or numerically ambiguous`);
  }
  return determinant;
}

function immutableMatrix(
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
): Matrix {
  const values: Matrix = [a, b, c, d, e, f];
  determinantOf(values, 'matrix');
  return Object.freeze(values);
}

/** Returns a matrix that applies `right` first and then `left`. */
export function multiply(left: Matrix, right: Matrix): Matrix {
  determinantOf(left, 'left matrix');
  determinantOf(right, 'right matrix');
  const [a1, b1, c1, d1, e1, f1] = left;
  const [a2, b2, c2, d2, e2, f2] = right;
  return immutableMatrix(
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  );
}

export function invert(matrix: Matrix): Matrix {
  const determinant = determinantOf(matrix, 'matrix');
  const [a, b, c, d, e, f] = matrix;
  return immutableMatrix(
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  );
}

export function transformPoint(matrix: Matrix, x: number, y: number): Point {
  determinantOf(matrix, 'matrix');
  assertFinite([x, y], 'point');
  const [a, b, c, d, e, f] = matrix;
  const transformed: Point = [a * x + c * y + e, b * x + d * y + f];
  assertFinite(transformed, 'transformed point');
  return Object.freeze(transformed);
}
