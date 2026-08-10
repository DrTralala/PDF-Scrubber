import type { EffectiveTextStyle } from '@pdf-editor/pdf-engine';
import { expect, it } from 'vitest';

import { selectionFixture } from '../test/fakes';
import type { EditorRichTextRun } from './rich-text-buffer';
import { deriveFormatState } from './format-state';

const baseStyle = selectionFixture().style;

function run(
  text: string,
  options: Readonly<{
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    fontId?: string;
  }> = {},
): EditorRichTextRun {
  return Object.freeze({
    text,
    style: Object.freeze({
      ...baseStyle,
      fontWeight: options.bold ? 700 : 400,
      italicAngle: options.italic ? -12 : 0,
    } satisfies EffectiveTextStyle),
    fontId: options.fontId ?? 'font:regular',
    fontIntent: 'preserve-source',
    decorations: Object.freeze({
      underline: options.underline ?? false,
      strikethrough: options.strikethrough ?? false,
    }),
  });
}

it('treats a collapsed editor range as the complete rich selection', () => {
  const state = deriveFormatState([
    run('Plain', { fontId: 'font:first' }),
    run('Bold', { bold: true, fontId: 'font:second' }),
  ], { start: 5, end: 5 });

  expect(state.target).toEqual({ start: 0, end: 9 });
  expect(state.representative.fontId).toBe('font:second');
  expect(state.bold).toBe('mixed');
});

it('uses only runs intersecting an explicit editor range', () => {
  const state = deriveFormatState([
    run('A'),
    run('BC', { bold: true, italic: true, underline: true, strikethrough: true }),
    run('D'),
  ], { start: 1, end: 3 });

  expect(state.target).toEqual({ start: 1, end: 3 });
  expect(state.bold).toBe('on');
  expect(state.italic).toBe('on');
  expect(state.underline).toBe('on');
  expect(state.strikethrough).toBe('on');
});

it('reports off and mixed formatting independently across the selected runs', () => {
  const state = deriveFormatState([
    run('A', { bold: true, underline: true }),
    run('B', { italic: true, underline: false }),
  ], { start: 0, end: 2 });

  expect(state.bold).toBe('mixed');
  expect(state.italic).toBe('mixed');
  expect(state.underline).toBe('mixed');
  expect(state.strikethrough).toBe('off');
});
