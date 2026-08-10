import type { CanonicalBounds } from '@pdf-editor/pdf-engine';
import type { RichReplacementPreviewResult } from '@pdf-editor/worker-protocol';
import type { JSX } from 'react';

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
  fitLineEligible,
  onWidth,
}: Readonly<{
  minimumWidth: number;
  allowedRegion: CanonicalBounds;
  maxAllowedWidth: number;
  preview: RichReplacementPreviewResult | null;
  fitLineEligible: boolean;
  onWidth(width: number): void;
}>): JSX.Element {
  const required = preview?.replacementBounds.width ?? null;
  return (
    <section className="fit-status" aria-labelledby="fit-title">
      <h3 id="fit-title">Line fit</h3>
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
      <p>
        {required === null
          ? `Allowed ${allowedRegion.width.toFixed(1)} pt. Waiting for shaped measurement.`
          : preview!.fits
            ? `Fits: ${required.toFixed(1)} of ${allowedRegion.width.toFixed(1)} pt.`
            : `Overflow: ${required.toFixed(1)} required, ${allowedRegion.width.toFixed(1)} pt allowed.`}
      </p>
      {preview !== null && !preview.fits && (
        fitLineEligible
          ? (
              <button
                type="button"
                onClick={() => onWidth(Math.min(
                  preview.replacementBounds.width,
                  maxAllowedWidth,
                ))}
              >
                Fit line
              </button>
            )
          : <p>Automatic fitting is unavailable for rotated text.</p>
      )}
    </section>
  );
}
