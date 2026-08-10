import type { CanonicalBounds } from '@pdf-editor/pdf-engine';

function projectedExtent(
  bounds: CanonicalBounds,
  axis: readonly [number, number],
): number {
  return Math.abs(axis[0]) * bounds.width + Math.abs(axis[1]) * bounds.height;
}

export function deriveRichFitRegion(
  selectionBounds: CanonicalBounds,
  glyphBounds: readonly CanonicalBounds[],
  baselineDirection: readonly [number, number],
): CanonicalBounds {
  const magnitude = Math.hypot(...baselineDirection);
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) {
    return Object.freeze({ ...selectionBounds });
  }
  const direction = Object.freeze([
    baselineDirection[0] / magnitude,
    baselineDirection[1] / magnitude,
  ] as const);
  const normal = Object.freeze([-direction[1], direction[0]] as const);
  const crossExtent = Math.max(
    0,
    ...glyphBounds.map((bounds) => projectedExtent(bounds, normal)),
  );
  const paddingX = Math.abs(normal[0]) * crossExtent;
  const paddingY = Math.abs(normal[1]) * crossExtent;
  return Object.freeze({
    x: selectionBounds.x - paddingX,
    y: selectionBounds.y - paddingY,
    width: selectionBounds.width + paddingX * 2,
    height: selectionBounds.height + paddingY * 2,
  });
}
