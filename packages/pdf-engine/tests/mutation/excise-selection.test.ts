import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import { analysePage } from '../../src/analysis/analyse-page';
import { groupPageText } from '../../src/layout/group-lines';
import { buildTextSelection } from '../../src/layout/selection';
import {
  buildSelectionMutationPreconditions,
  exciseSelection,
  previewSelectionExcision,
} from '../../src/mutation/excise';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import type { TextSelection } from '../../src/model';
import { ObjectStore } from '../../src/pdf/object-store';
import { buildDecorationFixture } from '../../../test-support/src/corpus/decorations';

async function richLineStore(): Promise<ObjectStore> {
  return ObjectStore.open(
    await readFile('fixtures/generated/30-wkhtmltopdf-rich-line.pdf'),
    PROVISIONAL_LIMITS,
  );
}

async function customerLabelSelection(store: ObjectStore): Promise<TextSelection> {
  const layout = groupPageText(await analysePage(store, 0));
  const group = layout.groups.find(({ text }) => text === 'Customer Name:')!;
  const line = layout.lines.find(({ key }) => key === group.lineKey)!;
  return buildTextSelection(line, group.glyphRange.start, group.glyphRange.end - 1);
}

async function decorationSelection(
  kind: 'stroked-underline' | 'shared-stream' = 'stroked-underline',
): Promise<Readonly<{ store: ObjectStore; selection: TextSelection }>> {
  const store = await ObjectStore.open(await buildDecorationFixture(kind), PROVISIONAL_LIMITS);
  const line = groupPageText(await analysePage(store, 0)).lines[0]!;
  return Object.freeze({
    store,
    selection: buildTextSelection(line, 0, line.glyphs.length - 1),
  });
}

describe('exciseSelection', () => {
  test('atomically removes a selection spanning fourteen source operations', async () => {
    const store = await richLineStore();
    const selection = await customerLabelSelection(store);
    const valueBefore = (await analysePage(store, 0)).spans
      .find(({ unicode }) => unicode === 'A')!.baseline;
    const originalStreams = store.listPageStreams(0);
    const preconditions = await buildSelectionMutationPreconditions(store, selection);

    const preview = await previewSelectionExcision(store, {
      pageIndex: 0,
      selection,
      currentRevision: 0,
      expectedRevision: 0,
      preconditions,
    });

    expect(selection.sourceSlices).toHaveLength(14);
    expect(preview.operatorDigests).toHaveLength(14);
    expect(store.listPageStreams(0)).toEqual(originalStreams);

    const result = await exciseSelection(store, {
      pageIndex: 0,
      selection,
      currentRevision: 0,
      expectedRevision: 0,
      preconditions,
    });
    const analysed = await analysePage(store, 0);
    const extracted = analysed.spans.map(({ unicode }) => unicode ?? '').join('');
    const valueAfter = analysed.spans.find(({ unicode }) => unicode === 'A')!.baseline;

    expect(result.operatorDigests).toEqual(preview.operatorDigests);
    expect(extracted).not.toContain('Customer Name:');
    expect(extracted).toContain('Alex Morgan');
    expect(valueAfter[0]).toBeCloseTo(valueBefore[0], 7);
    expect(valueAfter[1]).toBeCloseTo(valueBefore[1], 7);
  });

  test('rejects the whole selection before changing any stream when one digest is stale', async () => {
    const store = await richLineStore();
    const selection = await customerLabelSelection(store);
    const preconditions = await buildSelectionMutationPreconditions(store, selection);
    const originalStreams = store.listPageStreams(0);

    await expect(exciseSelection(store, {
      pageIndex: 0,
      selection,
      currentRevision: 0,
      expectedRevision: 0,
      preconditions: Object.freeze({
        slices: Object.freeze(preconditions.slices.map((item, index) =>
          index === 7
            ? Object.freeze({ ...item, expectedOperatorDigest: '0'.repeat(64) })
            : item)),
        decorations: preconditions.decorations,
      }),
    })).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(store.listPageStreams(0)).toEqual(originalStreams);
  });

  test('builds same-stream text and source-decoration patches against the original bytes', async () => {
    const { store, selection } = await decorationSelection();
    const originalStreams = store.listPageStreams(0);
    const preconditions = await buildSelectionMutationPreconditions(store, selection);

    const preview = await previewSelectionExcision(store, {
      pageIndex: 0,
      selection,
      currentRevision: 0,
      expectedRevision: 0,
      preconditions,
    });

    expect(preconditions.decorations).toEqual([
      expect.objectContaining({
        addressKey: expect.any(String),
        expectedOperatorDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(preview.streamReplacements).toHaveLength(1);
    expect(preview.decorationDigests).toEqual([
      preconditions.decorations[0]!.expectedOperatorDigest,
    ]);
    expect(store.listPageStreams(0)).toEqual(originalStreams);

    await exciseSelection(store, {
      pageIndex: 0,
      selection,
      currentRevision: 0,
      expectedRevision: 0,
      preconditions,
    });
    const analysed = await analysePage(store, 0);
    expect(analysed.spans.map(({ unicode }) => unicode).join('')).not.toContain('Decorated text');
    expect(analysed.decorationGraphics).toEqual([]);
  });

  test('rejects a stale decoration digest before changing its source stream', async () => {
    const { store, selection } = await decorationSelection();
    const preconditions = await buildSelectionMutationPreconditions(store, selection);
    const originalStreams = store.listPageStreams(0);

    await expect(exciseSelection(store, {
      pageIndex: 0,
      selection,
      currentRevision: 0,
      expectedRevision: 0,
      preconditions: Object.freeze({
        slices: preconditions.slices,
        decorations: Object.freeze([Object.freeze({
          ...preconditions.decorations[0]!,
          expectedOperatorDigest: '0'.repeat(64),
        })]),
      }),
    })).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(store.listPageStreams(0)).toEqual(originalStreams);
  });

  test('preserves shared decoration graphics because they never become mutable evidence', async () => {
    const { store, selection } = await decorationSelection('shared-stream');
    const preconditions = await buildSelectionMutationPreconditions(store, selection);

    expect(selection.sourceDecorations).toEqual([]);
    expect(selection.decorationWarnings).toEqual([
      expect.objectContaining({ reason: 'shared-content' }),
    ]);
    expect(preconditions.decorations).toEqual([]);
  });
});
