import {
  AmbiguousTransformError,
  invert,
  type Matrix,
  type Point,
} from './matrix';

export type PageBox = readonly [
  xMinimum: number,
  yMinimum: number,
  xMaximum: number,
  yMaximum: number,
];

export type PageSpace = Readonly<{
  mediaBox: PageBox;
  cropBox?: PageBox;
  rotate: number;
  userUnit: number;
}>;

function assertBox(box: PageBox, name: string): void {
  if (
    box.some((value) => !Number.isFinite(value)) ||
    box[2] <= box[0] ||
    box[3] <= box[1]
  ) {
    throw new AmbiguousTransformError(`${name} is not a finite positive-area box`);
  }
}

function visibleBox(page: PageSpace): PageBox {
  assertBox(page.mediaBox, 'MediaBox');
  if (page.cropBox === undefined) return page.mediaBox;
  assertBox(page.cropBox, 'CropBox');
  const intersection: PageBox = [
    Math.max(page.mediaBox[0], page.cropBox[0]),
    Math.max(page.mediaBox[1], page.cropBox[1]),
    Math.min(page.mediaBox[2], page.cropBox[2]),
    Math.min(page.mediaBox[3], page.cropBox[3]),
  ];
  assertBox(intersection, 'MediaBox/CropBox intersection');
  return intersection;
}

function normalisedRotation(page: PageSpace): 0 | 90 | 180 | 270 {
  if (!Number.isFinite(page.rotate) || page.rotate % 90 !== 0) {
    throw new AmbiguousTransformError('page rotation is not a multiple of 90 degrees');
  }
  const rotation = ((page.rotate % 360) + 360) % 360;
  return rotation as 0 | 90 | 180 | 270;
}

function pageInputs(page: PageSpace): Readonly<{
  box: PageBox;
  rotation: 0 | 90 | 180 | 270;
  userUnit: number;
}> {
  if (!Number.isFinite(page.userUnit) || page.userUnit <= 0) {
    throw new AmbiguousTransformError('UserUnit must be finite and greater than zero');
  }
  return {
    box: visibleBox(page),
    rotation: normalisedRotation(page),
    userUnit: page.userUnit,
  };
}

/**
 * Maps default PDF user space into visible, rotated canonical page space.
 * Canonical coordinates have a bottom-left origin and y-up axes; UserUnit is
 * applied. PDF.js's screen-space y inversion is deliberately not included.
 */
export function pdfToCanonical(page: PageSpace): Matrix {
  const { box: [x0, y0, x1, y1], rotation, userUnit: u } = pageInputs(page);
  switch (rotation) {
    case 0:
      return Object.freeze([u, 0, 0, u, -u * x0, -u * y0]);
    case 90:
      return Object.freeze([0, -u, u, 0, -u * y0, u * x1]);
    case 180:
      return Object.freeze([-u, 0, 0, -u, u * x1, u * y1]);
    case 270:
      return Object.freeze([0, u, -u, 0, u * y1, -u * x0]);
  }
}

export function canonicalToPdf(page: PageSpace): Matrix {
  return invert(pdfToCanonical(page));
}

export function canonicalPageSize(page: PageSpace): Point {
  const { box: [x0, y0, x1, y1], rotation, userUnit } = pageInputs(page);
  const width = (x1 - x0) * userUnit;
  const height = (y1 - y0) * userUnit;
  return Object.freeze(rotation === 90 || rotation === 270 ? [height, width] : [width, height]);
}

/** Maps canonical y-up coordinates to the top-left, y-down PDF.js viewport. */
export function canonicalToViewport(
  page: PageSpace,
  scale: number,
  offsetX = 0,
  offsetY = 0,
): Matrix {
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Number.isFinite(offsetX) ||
    !Number.isFinite(offsetY)
  ) {
    throw new AmbiguousTransformError('viewport scale and offsets must be finite');
  }
  const [, height] = canonicalPageSize(page);
  return Object.freeze([
    scale,
    0,
    0,
    -scale,
    offsetX,
    offsetY + height * scale,
  ]);
}
