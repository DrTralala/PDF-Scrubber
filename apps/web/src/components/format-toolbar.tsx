import type {
  EffectiveTextStyle,
  FontDescriptor,
  HalfOpenRange,
} from '@pdf-editor/pdf-engine';
import type { JSX } from 'react';

import type {
  EditorRichTextRun,
  RichTextFormatPatch,
} from '../editing/rich-text-buffer';
import { deriveFormatState, type FormatToggleState } from '../editing/format-state';

function colourValue(style: EffectiveTextStyle): string {
  const components = style.fillColour.colourSpace === 'DeviceRGB'
    ? style.fillColour.components
    : style.fillColour.colourSpace === 'DeviceGray'
      ? [style.fillColour.components[0]!, style.fillColour.components[0]!, style.fillColour.components[0]!]
      : [0, 0, 0];
  return `#${components.map((component) => Math.round(
    Math.max(0, Math.min(1, component)) * 255,
  ).toString(16).padStart(2, '0')).join('')}`;
}

function rgbColour(value: string): EffectiveTextStyle['fillColour'] {
  const hex = value.replace(/^#/, '');
  return Object.freeze({
    colourSpace: 'DeviceRGB',
    components: Object.freeze([0, 2, 4].map((offset) =>
      Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)),
  });
}

function ariaPressed(state: FormatToggleState): boolean | 'mixed' {
  return state === 'mixed' ? 'mixed' : state === 'on';
}

export function FormatToolbar({
  runs,
  selection,
  fonts,
  onFormat,
}: Readonly<{
  runs: readonly EditorRichTextRun[];
  selection: HalfOpenRange;
  fonts: readonly FontDescriptor[];
  onFormat(range: HalfOpenRange, patch: RichTextFormatPatch): void;
}>): JSX.Element {
  const formatState = deriveFormatState(runs, selection);
  const run = formatState.representative;
  const target = formatState.target;
  return (
    <fieldset className="format-toolbar">
      <legend>Formatting</legend>
      <label>
        Font
        <select
          aria-label="Font"
          value={run.fontId}
          onChange={(event) => onFormat(target, {
            fontId: event.currentTarget.value,
            fontIntent: 'explicit-choice',
          })}
        >
          {fonts.map((font) => (
            <option key={font.id} value={font.id}>
              {font.inspection.fullName ?? font.inspection.postscriptName ?? font.fileName ?? 'Unnamed font'}
              {' · '}{font.source}
            </option>
          ))}
        </select>
      </label>
      <label>
        Font size
        <input
          aria-label="Font size"
          type="number"
          min="1"
          max="512"
          step="0.25"
          value={run.style.fontSize}
          onChange={(event) => onFormat(target, {
            style: { fontSize: Number(event.currentTarget.value) },
          })}
        />
      </label>
      <div className="format-buttons">
        <button
          type="button"
          aria-label="Bold"
          aria-pressed={ariaPressed(formatState.bold)}
          onClick={() => onFormat(target, {
            style: { fontWeight: formatState.bold === 'on' ? 400 : 700 },
          })}
        >B</button>
        <button
          type="button"
          aria-label="Italic"
          aria-pressed={ariaPressed(formatState.italic)}
          onClick={() => onFormat(target, {
            style: { italicAngle: formatState.italic === 'on' ? 0 : -12 },
          })}
        ><i>I</i></button>
        <button
          type="button"
          aria-label="Underline"
          aria-pressed={ariaPressed(formatState.underline)}
          onClick={() => onFormat(target, {
            decorations: { underline: formatState.underline !== 'on' },
          })}
        ><span className="format-symbol format-symbol-underline">U</span></button>
        <button
          type="button"
          aria-label="Strikethrough"
          aria-pressed={ariaPressed(formatState.strikethrough)}
          onClick={() => onFormat(target, {
            decorations: { strikethrough: formatState.strikethrough !== 'on' },
          })}
        ><span className="format-symbol format-symbol-strikethrough">S</span></button>
        <label className="text-colour-control">
          Text Colour
          <input
            aria-label="Text Colour"
            type="color"
            value={colourValue(run.style)}
            onChange={(event) => onFormat(target, {
              style: { fillColour: rgbColour(event.currentTarget.value) },
            })}
          />
        </label>
      </div>
      <details>
        <summary>Advanced spacing</summary>
        <label>
          Character spacing
          <input
            aria-label="Character spacing"
            type="number"
            step="0.1"
            value={run.style.characterSpacing}
            onChange={(event) => onFormat(target, {
              style: { characterSpacing: Number(event.currentTarget.value) },
            })}
          />
        </label>
        <label>
          Horizontal scale
          <input
            aria-label="Horizontal scale"
            type="number"
            min="0.1"
            max="4"
            step="0.05"
            value={run.style.horizontalScaling}
            onChange={(event) => onFormat(target, {
              style: { horizontalScaling: Number(event.currentTarget.value) },
            })}
          />
        </label>
      </details>
    </fieldset>
  );
}
