import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { analysePage } from '../../src/analysis/analyse-page';
import { groupPageText } from '../../src/layout/group-lines';
import { buildTextSelection } from '../../src/layout/selection';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import { ObjectStore } from '../../src/pdf/object-store';
import { buildDecorationFixture } from '../../../test-support/src/corpus/decorations';

async function layoutFixture(id: string) {
  const bytes = await readFile(resolve('fixtures/generated', `${id}.pdf`));
  const store = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
  return groupPageText(await analysePage(store, 0));
}

describe('buildTextSelection', () => {
  test('builds the same contiguous source-backed selection in either drag direction', async () => {
    const layout = await layoutFixture('30-wkhtmltopdf-rich-line');
    const line = layout.lines.find((candidate) =>
      candidate.groups.some(({ text }) => text === 'Customer Name:'))!;
    const group = line.groups.find(({ text }) => text === 'Customer Name:')!;

    const forward = buildTextSelection(
      line,
      group.glyphRange.start,
      group.glyphRange.end - 1,
    );
    const reverse = buildTextSelection(
      line,
      group.glyphRange.end - 1,
      group.glyphRange.start,
    );

    expect(forward).toEqual(reverse);
    expect(forward.text).toBe('Customer Name:');
    expect(forward.sourceSlices).toHaveLength(14);
    expect(forward.sourceSlices.every(({ operatorRange, glyphRange }) =>
      operatorRange.end - operatorRange.start === 1 &&
      glyphRange.end - glyphRange.start === 1)).toBe(true);
  });

  test('expands a combining-mark endpoint to its complete grapheme', async () => {
    const layout = await layoutFixture('08-combining-marks');
    const line = layout.lines[0]!;
    const markIndex = line.glyphs.findIndex(({ unicode }) => unicode === '\u0301');

    expect(markIndex).toBeGreaterThan(0);
    const selection = buildTextSelection(line, markIndex, markIndex);
    expect(selection.text).toBe('e\u0301');
    expect(selection.glyphRange).toEqual({ start: markIndex - 1, end: markIndex + 1 });
  });

  test('includes a high-confidence source decoration only when its complete owner is selected', async () => {
    const store = await ObjectStore.open(
      await buildDecorationFixture('stroked-underline'),
      PROVISIONAL_LIMITS,
    );
    const line = groupPageText(await analysePage(store, 0)).lines[0]!;

    const whole = buildTextSelection(line, 0, line.glyphs.length - 1);
    const partial = buildTextSelection(line, 0, line.glyphs.length - 2);

    expect(whole.sourceDecorations).toHaveLength(1);
    expect(whole.sourceDecorations[0]).toMatchObject({ kind: 'underline' });
    expect(whole.decorationWarnings).toEqual([]);
    expect(partial.sourceDecorations).toEqual([]);
    expect(partial.decorationWarnings).toEqual([
      expect.objectContaining({ reason: 'ambiguous-geometry' }),
    ]);
  });

  test.each([
    ['ambiguous-owner', 'multiple-owners'],
    ['shared-stream', 'shared-content'],
  ] as const)('preserves the %s warning on an intersecting selection', async (kind, reason) => {
    const store = await ObjectStore.open(await buildDecorationFixture(kind), PROVISIONAL_LIMITS);
    const line = groupPageText(await analysePage(store, 0)).lines[0]!;
    const selection = buildTextSelection(line, 0, line.glyphs.length - 1);

    expect(selection.sourceDecorations).toEqual([]);
    expect(selection.decorationWarnings).toEqual([
      expect.objectContaining({ reason }),
    ]);
  });
});
