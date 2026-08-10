import type { FontInspection } from './font-inspection';

export type ResolvedTextDecorationMetrics = Readonly<{
  underlinePositionEm: number;
  underlineThicknessEm: number;
  strikeoutPositionEm: number;
  strikeoutThicknessEm: number;
}>;

type DecorationMetricInput = Pick<
  FontInspection,
  | 'unitsPerEm'
  | 'underlinePosition'
  | 'underlineThickness'
  | 'strikeoutPosition'
  | 'strikeoutThickness'
>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function thickness(value: number | null, unitsPerEm: number): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0.05;
  return clamp(value / unitsPerEm, 0.025, 0.12);
}

export function resolveTextDecorationMetrics(
  inspection: DecorationMetricInput,
): ResolvedTextDecorationMetrics {
  const unitsPerEm = inspection.unitsPerEm;
  const underline = inspection.underlinePosition;
  const strikeout = inspection.strikeoutPosition;
  const underlinePositionEm = underline !== null && Number.isFinite(underline) && underline < 0
    ? clamp(underline / unitsPerEm, -0.35, -0.05)
    : -0.1;
  const strikeoutPositionEm = strikeout !== null && Number.isFinite(strikeout) && strikeout > 0
    ? clamp(strikeout / unitsPerEm, 0.2, 0.6)
    : 0.3;
  return Object.freeze({
    underlinePositionEm,
    underlineThicknessEm: thickness(inspection.underlineThickness, unitsPerEm),
    strikeoutPositionEm,
    strikeoutThicknessEm: thickness(inspection.strikeoutThickness, unitsPerEm),
  });
}
