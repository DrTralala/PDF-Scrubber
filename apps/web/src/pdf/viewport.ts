import {
  canonicalPageSize,
  canonicalToViewport,
  transformPoint,
  type CanonicalBounds,
  type PageSpace,
} from '@pdf-editor/pdf-engine';
import type { PageViewport } from 'pdfjs-dist';

type Size = Readonly<{ width: number; height: number }>;
type ViewportSize = Pick<PageViewport, 'width' | 'height'>;

export type ViewportRect = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

function assertFinitePositiveSize(size: Size, name: string): void {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) {
    throw new Error(`${name} dimensions must be finite`);
  }
  if (size.width <= 0 || size.height <= 0) {
    throw new Error(`${name} dimensions must be positive`);
  }
}

export function toViewportRect(
  bounds: CanonicalBounds,
  pageSpace: PageSpace,
  viewport: ViewportSize,
): ViewportRect {
  assertFinitePositiveSize(viewport, 'Viewport');
  if (
    !Number.isFinite(bounds.x)
    || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
    || bounds.width <= 0
    || bounds.height <= 0
  ) {
    throw new Error('Canonical bounds must be finite and positive');
  }

  const [canonicalWidth, canonicalHeight] = canonicalPageSize(pageSpace);
  const horizontalScale = viewport.width / canonicalWidth;
  const verticalScale = viewport.height / canonicalHeight;
  if (Math.abs(horizontalScale - verticalScale) > 1e-6) {
    throw new Error('Viewport must use uniform scaling');
  }

  const matrix = canonicalToViewport(pageSpace, horizontalScale);
  const first = transformPoint(matrix, bounds.x, bounds.y);
  const opposite = transformPoint(
    matrix,
    bounds.x + bounds.width,
    bounds.y + bounds.height,
  );

  return Object.freeze({
    left: Math.min(first[0], opposite[0]),
    top: Math.min(first[1], opposite[1]),
    width: Math.abs(opposite[0] - first[0]),
    height: Math.abs(opposite[1] - first[1]),
  });
}

export function fitScale(
  page: Size,
  available: Size,
  mode: 'page' | 'width',
): number {
  assertFinitePositiveSize(page, 'Page');
  assertFinitePositiveSize(available, 'Available');
  const widthScale = available.width / page.width;
  return mode === 'width'
    ? widthScale
    : Math.min(widthScale, available.height / page.height);
}
