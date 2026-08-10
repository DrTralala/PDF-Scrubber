import type { HalfOpenRange } from '@pdf-editor/pdf-engine';

import type { EditorRichTextRun } from './rich-text-buffer';

export type FormatToggleState = 'on' | 'off' | 'mixed';

export type SelectionFormatState = Readonly<{
  target: HalfOpenRange;
  representative: EditorRichTextRun;
  bold: FormatToggleState;
  italic: FormatToggleState;
  underline: FormatToggleState;
  strikethrough: FormatToggleState;
}>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function runAt(
  runs: readonly EditorRichTextRun[],
  index: number,
): EditorRichTextRun {
  let offset = 0;
  for (const run of runs) {
    if (index >= offset && index < offset + run.text.length) return run;
    offset += run.text.length;
  }
  const fallback = runs.at(-1);
  if (fallback === undefined) throw new RangeError('Formatting requires at least one rich text run');
  return fallback;
}

function intersectingRuns(
  runs: readonly EditorRichTextRun[],
  range: HalfOpenRange,
): readonly EditorRichTextRun[] {
  const selected: EditorRichTextRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const end = offset + run.text.length;
    if (offset < range.end && end > range.start) selected.push(run);
    offset = end;
  }
  return selected;
}

function toggleState(
  runs: readonly EditorRichTextRun[],
  predicate: (run: EditorRichTextRun) => boolean,
): FormatToggleState {
  const enabled = runs.filter(predicate).length;
  if (enabled === 0) return 'off';
  if (enabled === runs.length) return 'on';
  return 'mixed';
}

export function deriveFormatState(
  runs: readonly EditorRichTextRun[],
  selection: HalfOpenRange,
): SelectionFormatState {
  if (runs.length === 0) throw new RangeError('Formatting requires at least one rich text run');
  const length = runs.reduce((total, run) => total + run.text.length, 0);
  const start = clamp(selection.start, 0, length);
  const end = clamp(selection.end, start, length);
  const target = start === end
    ? Object.freeze({ start: 0, end: length })
    : Object.freeze({ start, end });
  const representative = runAt(runs, clamp(start, 0, Math.max(0, length - 1)));
  const selected = intersectingRuns(runs, target);
  const effectiveRuns = selected.length === 0 ? [representative] : selected;

  return Object.freeze({
    target,
    representative,
    bold: toggleState(effectiveRuns, (run) => (run.style.fontWeight ?? 400) >= 600),
    italic: toggleState(effectiveRuns, (run) => (run.style.italicAngle ?? 0) !== 0),
    underline: toggleState(effectiveRuns, (run) => run.decorations.underline),
    strikethrough: toggleState(effectiveRuns, (run) => run.decorations.strikethrough),
  });
}
