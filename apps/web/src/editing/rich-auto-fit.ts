import type { CanonicalBounds } from '@pdf-editor/pdf-engine';

const GEOMETRY_TOLERANCE = 1e-6;

export type RichFitGeometryInput = Readonly<{
  requiredBounds: CanonicalBounds;
  allowedRegion: CanonicalBounds;
  maxAllowedWidth: number;
}>;

export type RichFitMeasurement = Readonly<{
  measuredLeftEdge: number;
  measuredRightEdge: number;
  allowedLeftEdge: number;
  allowedRightEdge: number;
  maximumRightEdge: number;
  widthShortfall: number;
  leftOverflow: boolean;
  verticalOverflow: boolean;
  widthOverflow: boolean;
  maximumWidthOverflow: boolean;
}>;

export function measureRichFitGeometry(
  input: RichFitGeometryInput,
): RichFitMeasurement | null {
  const { requiredBounds, allowedRegion, maxAllowedWidth } = input;
  if (
    !Number.isFinite(requiredBounds.x) ||
    !Number.isFinite(requiredBounds.y) ||
    !Number.isFinite(requiredBounds.width) ||
    !Number.isFinite(requiredBounds.height) ||
    !Number.isFinite(allowedRegion.x) ||
    !Number.isFinite(allowedRegion.y) ||
    !Number.isFinite(allowedRegion.width) ||
    !Number.isFinite(allowedRegion.height) ||
    !Number.isFinite(maxAllowedWidth)
  ) return null;

  const measuredRightEdge = requiredBounds.x + requiredBounds.width;
  const allowedRightEdge = allowedRegion.x + allowedRegion.width;
  const maximumRightEdge = allowedRegion.x + maxAllowedWidth;
  return Object.freeze({
    measuredLeftEdge: requiredBounds.x,
    measuredRightEdge,
    allowedLeftEdge: allowedRegion.x,
    allowedRightEdge,
    maximumRightEdge,
    widthShortfall: Math.max(0, measuredRightEdge - maximumRightEdge),
    leftOverflow: requiredBounds.x < allowedRegion.x - GEOMETRY_TOLERANCE,
    verticalOverflow:
      requiredBounds.y < allowedRegion.y - GEOMETRY_TOLERANCE ||
      requiredBounds.y + requiredBounds.height >
        allowedRegion.y + allowedRegion.height + GEOMETRY_TOLERANCE,
    widthOverflow: measuredRightEdge > allowedRightEdge + GEOMETRY_TOLERANCE,
    maximumWidthOverflow:
      measuredRightEdge > maximumRightEdge + GEOMETRY_TOLERANCE,
  });
}

export function autoFitRichWidth(input: RichFitGeometryInput & Readonly<{
  autoFitEligible: boolean;
}>): number | null {
  if (!input.autoFitEligible) return null;
  const measurement = measureRichFitGeometry(input);
  if (
    measurement === null ||
    measurement.leftOverflow ||
    measurement.verticalOverflow ||
    !measurement.widthOverflow ||
    measurement.maximumWidthOverflow
  ) return null;
  return Math.min(
    measurement.measuredRightEdge - measurement.allowedLeftEdge,
    input.maxAllowedWidth,
  );
}
