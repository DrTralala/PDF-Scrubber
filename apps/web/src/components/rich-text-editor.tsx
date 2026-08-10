import type { HalfOpenRange } from '@pdf-editor/pdf-engine';
import type { ChangeEvent, JSX, SyntheticEvent } from 'react';

import type { EditorRichTextRun } from '../editing/rich-text-buffer';

function changedRange(previous: string, next: string): Readonly<{
  range: HalfOpenRange;
  inserted: string;
}> {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) {
    start += 1;
  }
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > start && nextEnd > start &&
    previous[previousEnd - 1] === next[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  return Object.freeze({
    range: Object.freeze({ start, end: previousEnd }),
    inserted: next.slice(start, nextEnd),
  });
}

export function RichTextEditor({
  runs,
  onReplace,
  onSelectionChange,
}: Readonly<{
  runs: readonly EditorRichTextRun[];
  onReplace(range: HalfOpenRange, text: string): void;
  onSelectionChange(range: HalfOpenRange): void;
}>): JSX.Element {
  const text = runs.map((run) => run.text).join('');
  const updateSelection = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
    const field = event.currentTarget;
    onSelectionChange(Object.freeze({
      start: field.selectionStart,
      end: field.selectionEnd,
    }));
  };
  const change = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const changed = changedRange(text, event.currentTarget.value);
    onReplace(changed.range, changed.inserted);
  };
  return (
    <label className="rich-text-editor">
      Edit selected text
      <textarea
        aria-label="Edit selected text"
        value={text}
        rows={4}
        onChange={change}
        onSelect={updateSelection}
        onKeyUp={updateSelection}
        onClick={updateSelection}
      />
    </label>
  );
}
