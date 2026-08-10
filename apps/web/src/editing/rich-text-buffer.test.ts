import { describe, expect, test } from 'vitest';

import { selectionFixture } from '../test/fakes';
import { RichTextBuffer, type EditorRichTextRun } from './rich-text-buffer';

function run(
  text: string,
  fontId: string,
  weight: number,
  decorations = { underline: false, strikethrough: false },
  sourceRunIndex: number | null = null,
): EditorRichTextRun {
  const source = selectionFixture().style;
  return Object.freeze({
    text,
    style: Object.freeze({ ...source, fontWeight: weight }),
    fontId,
    fontIntent: 'preserve-source',
    decorations,
    sourceRunIndex,
  }) as EditorRichTextRun;
}

describe('RichTextBuffer', () => {
  test('preserves mixed styles and gives inserted text the preceding caret style', () => {
    const buffer = RichTextBuffer.fromRuns([
      run('abc', 'regular', 400),
      run('B', 'bold', 700),
      run('def', 'regular', 400),
    ]);

    const edited = buffer.replace({ start: 4, end: 4 }, '!');

    expect(edited.text).toBe('abcB!def');
    expect(edited.runs.map(({ text, style }) => [text, style.fontWeight])).toEqual([
      ['abc', 400],
      ['B!', 700],
      ['def', 400],
    ]);
  });

  test('preserves the source run when appending text at the end', () => {
    const buffer = RichTextBuffer.fromRuns([
      run('Seller: ', 'regular', 400, undefined, 0),
      run('BroadLink Official Store', 'regular', 400, undefined, 1),
    ]);

    const edited = buffer.replace(
      { start: buffer.text.length, end: buffer.text.length },
      ' Preferred',
    );

    expect(edited.runs.map(({ text, sourceRunIndex }) => [text, sourceRunIndex])).toEqual([
      ['Seller: ', 0],
      ['BroadLink Official Store Preferred', 1],
    ]);
  });

  test('does not merge equal presentation from different source runs', () => {
    const buffer = RichTextBuffer.fromRuns([
      run('A', 'regular', 400, undefined, 0),
      run('B', 'regular', 400, undefined, 1),
    ]);

    expect(buffer.runs.map(({ text, sourceRunIndex }) => [text, sourceRunIndex])).toEqual([
      ['A', 0],
      ['B', 1],
    ]);
  });

  test('inherits the following style when inserting at position zero', () => {
    const edited = RichTextBuffer.fromRuns([run('Text', 'bold', 700)])
      .replace({ start: 0, end: 0 }, 'A');

    expect(edited.runs).toHaveLength(1);
    expect(edited.runs[0]).toMatchObject({ text: 'AText', fontId: 'bold' });
  });

  test('inherits the selected style when replacing a formatted range', () => {
    const buffer = RichTextBuffer.fromRuns([
      run('this is a ', 'regular', 400),
      run('bold', 'bold', 700),
      run(' text', 'regular', 400),
    ]);

    const edited = buffer.replace({ start: 10, end: 14 }, 'firm');

    expect(edited.runs.map(({ text, style, fontId }) => [
      text,
      style.fontWeight,
      fontId,
    ])).toEqual([
      ['this is a ', 400, 'regular'],
      ['firm', 700, 'bold'],
      [' text', 400, 'regular'],
    ]);
  });

  test('splits and merges runs when a range is formatted', () => {
    const buffer = RichTextBuffer.fromRuns([run('abcdef', 'regular', 400)]);

    const formatted = buffer.format(
      { start: 1, end: 3 },
      { style: { fontSize: 9 }, fontId: 'compact', fontIntent: 'explicit-choice' },
    );

    expect(formatted.runs.map(({ text, style, fontId, fontIntent }) => ({
      text,
      size: style.fontSize,
      fontId,
      fontIntent,
    }))).toEqual([
      { text: 'a', size: 12, fontId: 'regular', fontIntent: 'preserve-source' },
      { text: 'bc', size: 9, fontId: 'compact', fontIntent: 'explicit-choice' },
      { text: 'def', size: 12, fontId: 'regular', fontIntent: 'preserve-source' },
    ]);
  });

  test('expands formatting ranges to complete grapheme clusters', () => {
    const formatted = RichTextBuffer.fromRuns([run('Cafe\u0301', 'regular', 400)])
      .format({ start: 4, end: 5 }, { style: { fontWeight: 700 } });

    expect(formatted.runs.map(({ text, style }) => [text, style.fontWeight])).toEqual([
      ['Caf', 400],
      ['e\u0301', 700],
    ]);
  });

  test('applies underline and strikethrough independently and combines them', () => {
    const buffer = RichTextBuffer.fromRuns([run('abcdef', 'regular', 400)]);

    const underlined = buffer.format(
      { start: 1, end: 5 },
      { decorations: { underline: true } },
    );
    const combined = underlined.format(
      { start: 2, end: 4 },
      { decorations: { strikethrough: true } },
    );

    expect(combined.runs.map(({ text, decorations }) => ({ text, decorations }))).toEqual([
      { text: 'a', decorations: { underline: false, strikethrough: false } },
      { text: 'b', decorations: { underline: true, strikethrough: false } },
      { text: 'cd', decorations: { underline: true, strikethrough: true } },
      { text: 'e', decorations: { underline: true, strikethrough: false } },
      { text: 'f', decorations: { underline: false, strikethrough: false } },
    ]);
  });

  test('expands decoration formatting to a complete grapheme and merges equal presentation', () => {
    const formatted = RichTextBuffer.fromRuns([
      run('Caf', 'regular', 400),
      run('e\u0301!', 'regular', 400),
    ]).format(
      { start: 4, end: 5 },
      { decorations: { underline: true } },
    );

    expect(formatted.runs.map(({ text, decorations }) => ({ text, decorations }))).toEqual([
      { text: 'Caf', decorations: { underline: false, strikethrough: false } },
      { text: 'e\u0301', decorations: { underline: true, strikethrough: false } },
      { text: '!', decorations: { underline: false, strikethrough: false } },
    ]);
  });
});
