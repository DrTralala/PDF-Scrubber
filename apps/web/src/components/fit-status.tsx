import type { CanonicalBounds } from '@pdf-editor/pdf-engine';
import type { RichReplacementPreviewResult } from '@pdf-editor/worker-protocol';
import type { JSX } from 'react';

import { measureRichFitGeometry } from '../editing/rich-auto-fit';

// Layout directions are normalised; this tolerance absorbs harmless PDF transform rounding.
const LEFT_TO_RIGHT_HORIZONTAL_TOLERANCE = 0.001;

export function isLeftToRightHorizontalBaseline(
  direction: readonly [number, number],
): boolean {
  const length = Math.hypot(direction[0], direction[1]);
  if (!Number.isFinite(length) || length === 0) return false;
  const x = direction[0] / length;
  const y = direction[1] / length;
  return x >= 1 - LEFT_TO_RIGHT_HORIZONTAL_TOLERANCE &&
    Math.abs(y) <= LEFT_TO_RIGHT_HORIZONTAL_TOLERANCE;
}

export function FitStatus({
  minimumWidth,
  allowedRegion,
  maxAllowedWidth,
  preview,
  autoFitEligible,
  autoFitEnabled,
  onWidth,
  onAutoFitChange,
}: Readonly<{
  minimumWidth: number;
  allowedRegion: CanonicalBounds;
  maxAllowedWidth: number;
  preview: RichReplacementPreviewResult | null;
  autoFitEligible: boolean;
  autoFitEnabled: boolean;
  onWidth(width: number): void;
  onAutoFitChange(enabled: boolean): void;
}>): JSX.Element {
  const measurement = preview === null
    ? null
    : measureRichFitGeometry({
        requiredBounds: preview.replacementBounds,
        allowedRegion,
        maxAllowedWidth,
      });
  const status = preview === null
    ? `Allowed ${allowedRegion.width.toFixed(1)} pt. Waiting for shaped measurement.`
    : measurement === null
      ? 'Unable to verify the shaped measurement in PDF points.'
      : measurement.leftOverflow
        ? `Left overflow: measured left edge ${measurement.measuredLeftEdge.toFixed(1)} pt; allowed left edge ${measurement.allowedLeftEdge.toFixed(1)} pt.`
        : measurement.verticalOverflow
          ? `Vertical overflow: measured bounds ${preview.replacementBounds.y.toFixed(1)}–${(preview.replacementBounds.y + preview.replacementBounds.height).toFixed(1)} pt; allowed vertical bounds ${allowedRegion.y.toFixed(1)}–${(allowedRegion.y + allowedRegion.height).toFixed(1)} pt.`
          : measurement.maximumWidthOverflow
            ? `Overflow: measured right edge ${measurement.measuredRightEdge.toFixed(1)} pt; maximum right edge ${measurement.maximumRightEdge.toFixed(1)} pt (${measurement.widthShortfall.toFixed(1)} pt short).`
            : measurement.widthOverflow
              ? `Overflow: measured right edge ${measurement.measuredRightEdge.toFixed(1)} pt; current allowed right edge ${measurement.allowedRightEdge.toFixed(1)} pt.`
              : preview.fits
                ? `Fits: measured right edge ${measurement.measuredRightEdge.toFixed(1)} pt; current allowed right edge ${measurement.allowedRightEdge.toFixed(1)} pt.`
                : 'Overflow: the shaped replacement is not validated as fitting.';
  return (
    <section className="fit-status" aria-labelledby="fit-title">
      <h3 id="fit-title">Line fit</h3>
      <div className="fit-status-controls">
        <label>
          Allowed width
          <input
            aria-label="Allowed width"
            type="range"
            min={minimumWidth}
            max={maxAllowedWidth}
            step="any"
            value={allowedRegion.width}
            onChange={(event) => onWidth(Number(event.currentTarget.value))}
          />
        </label>
        <label className="fit-status-auto">
          <input
            type="checkbox"
            checked={autoFitEnabled}
            onChange={(event) => onAutoFitChange(event.currentTarget.checked)}
          />
          Auto
        </label>
      </div>
      <p>{status}</p>
      {preview !== null && !autoFitEligible && (
        <p>Automatic fitting is unavailable for rotated or non-horizontal text.</p>
      )}
    </section>
  );
}
