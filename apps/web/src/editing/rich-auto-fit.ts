import type { CanonicalBounds } from '@pdf-editor/pdf-engine';

const GEOMETRY_TOLERANCE = 1e-6;

export function autoFitRichWidth(input: Readonly<{
  requiredBounds: CanonicalBounds;
  allowedRegion: CanonicalBounds;
  maxAllowedWidth: number;
  fitLineEligible: boolean;
}>): number | null {
  const { requiredBounds, allowedRegion } = input;
  if (!input.fitLineEligible) return null;
  if (
    !Number.isFinite(requiredBounds.x) ||
    !Number.isFinite(requiredBounds.y) ||
    !Number.isFinite(requiredBounds.width) ||
    !Number.isFinite(requiredBounds.height) ||
    !Number.isFinite(allowedRegion.x) ||
    !Number.isFinite(allowedRegion.y) ||
    !Number.isFinite(allowedRegion.width) ||
    !Number.isFinite(allowedRegion.height) ||
    !Number.isFinite(input.maxAllowedWidth)
  ) return null;
  if (
    requiredBounds.width <= allowedRegion.width + GEOMETRY_TOLERANCE ||
    requiredBounds.width > input.maxAllowedWidth + GEOMETRY_TOLERANCE ||
    requiredBounds.x < allowedRegion.x - GEOMETRY_TOLERANCE ||
    requiredBounds.y < allowedRegion.y - GEOMETRY_TOLERANCE ||
    requiredBounds.y + requiredBounds.height >
      allowedRegion.y + allowedRegion.height + GEOMETRY_TOLERANCE
  ) return null;
  return Math.min(requiredBounds.width, input.maxAllowedWidth);
}
