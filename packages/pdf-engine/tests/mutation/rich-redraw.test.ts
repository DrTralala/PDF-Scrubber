import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, test } from 'vitest';

import { analysePage } from '../../src/analysis/analyse-page';
import { PDF_SCRUBBER_MARKED_CONTENT_TAG } from '../../src/content/brand-markers';
import { parseControlledRedraw } from '../../src/content/controlled-redraw';
import { tokeniseContentStream } from '../../src/content/tokeniser';
import type { ResolvedFontAsset } from '../../src/fonts/font-embedding';
import { FontRegistry } from '../../src/fonts/font-registry';
import { shapeText } from '../../src/fonts/harfbuzz-shaper';
import { groupPageText } from '../../src/layout/group-lines';
import { buildTextSelection } from '../../src/layout/selection';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import type { AnalysedTextGroup, AnalysedTextLine, TextSelection } from '../../src/model';
import { buildSelectionMutationPreconditions } from '../../src/mutation/excise';
import {
  applyRichReplacement,
  previewRichReplacement,
  type RichReplacementMutationInput,
} from '../../src/mutation/replace-selection';
import { appendControlledRichRedraw } from '../../src/mutation/redraw';
import { ObjectStore } from '../../src/pdf/object-store';
import { buildDecorationFixture } from '../../../test-support/src/corpus/decorations';
import {
  validateCandidateAgainstSource,
  type ValidationCanvasFactory,
} from '../../src/validation/pdfjs-validator';

const REGULAR_PATH = resolve(
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff',
);
const BOLD_PATH = resolve(
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff',
);

const nodeCanvasFactory: ValidationCanvasFactory = (width, height) => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  return {
    canvas,
    context,
    readRgba: () => new Uint8Array(context.getImageData(0, 0, width, height).data),
  };
};

async function fixtureStore(): Promise<ObjectStore> {
  return ObjectStore.open(
    await readFile('fixtures/generated/30-wkhtmltopdf-rich-line.pdf'),
    PROVISIONAL_LIMITS,
  );
}

async function spacingFixtureStore(): Promise<ObjectStore> {
  return ObjectStore.open(
    await readFile('fixtures/generated/05-spacing-rise-scale.pdf'),
    PROVISIONAL_LIMITS,
  );
}

async function sentenceSelection(store: ObjectStore): Promise<Readonly<{
  selection: TextSelection;
  line: AnalysedTextLine;
  group: AnalysedTextGroup;
}>> {
  const layout = groupPageText(await analysePage(store, 0));
  const group = layout.groups.find(({ text }) => text.startsWith('this is a '))!;
  const line = layout.lines.find(({ key }) => key === group.lineKey)!;
  return Object.freeze({
    selection: buildTextSelection(line, group.glyphRange.start, group.glyphRange.end - 1),
    line,
    group,
  });
}

async function assets(): Promise<Readonly<{
  regular: ResolvedFontAsset;
  bold: ResolvedFontAsset;
}>> {
  const registry = new FontRegistry();
  const regularBytes = new Uint8Array(await readFile(REGULAR_PATH));
  const boldBytes = new Uint8Array(await readFile(BOLD_PATH));
  const regular = await registry.register({
    source: 'bundled',
    fileName: 'noto-sans-latin-400-normal.woff',
    bytes: regularBytes,
  });
  const bold = await registry.register({
    source: 'bundled',
    fileName: 'noto-sans-latin-700-normal.woff',
    bytes: boldBytes,
  });
  return Object.freeze({
    regular: Object.freeze({
      descriptor: regular,
      bytes: registry.getBytes(regular.id),
      matchKind: 'exact',
    }),
    bold: Object.freeze({
      descriptor: bold,
      bytes: registry.getBytes(bold.id),
      matchKind: 'exact',
    }),
  });
}

async function richInput(
  store: ObjectStore,
  revision: number,
  texts: readonly [string, string, string],
): Promise<RichReplacementMutationInput> {
  const { selection } = await sentenceSelection(store);
  const fonts = await assets();
  const sourceRuns = selection.styleRuns;
  const runs = await Promise.all(texts.map(async (text, index) => {
    const font = index === 1 ? fonts.bold : fonts.regular;
    return Object.freeze({
      text,
      style: sourceRuns[index]!.style,
      shapedRun: await shapeText({ fontBytes: font.bytes, text }),
      fontAsset: font,
      decorations: sourceRuns[index]!.decorations,
    });
  }));
  return Object.freeze({
    pageIndex: 0,
    selection,
    runs: Object.freeze(runs),
    allowedRegion: Object.freeze({
      ...selection.bounds,
      width: selection.bounds.width * 2,
      height: selection.bounds.height * 2,
    }),
    substitutionConsents: Object.freeze([]),
    currentRevision: revision,
    expectedRevision: revision,
    preconditions: await buildSelectionMutationPreconditions(store, selection),
  });
}

async function spacingInput(
  store: ObjectStore,
  revision: number,
): Promise<RichReplacementMutationInput> {
  const layout = groupPageText(await analysePage(store, 0));
  const group = layout.groups.find(({ text }) => text === 'Target 05');
  if (group === undefined) throw new Error('Spacing fixture target group is missing');
  const line = layout.lines.find(({ key }) => key === group.lineKey);
  if (line === undefined) throw new Error('Spacing fixture target line is missing');
  const selection = buildTextSelection(
    line,
    group.glyphRange.start,
    group.glyphRange.end - 1,
  );
  const sourceRun = selection.styleRuns[0];
  if (sourceRun === undefined) throw new Error('Spacing fixture source run is missing');
  const font = (await assets()).regular;
  const replacement = 'Edited 05';
  const run = Object.freeze({
    text: replacement,
    style: sourceRun.style,
    shapedRun: await shapeText({ fontBytes: font.bytes, text: replacement }),
    fontAsset: font,
    decorations: sourceRun.decorations,
  });
  return Object.freeze({
    pageIndex: 0,
    selection,
    runs: Object.freeze([run]),
    allowedRegion: Object.freeze({
      x: selection.bounds.x - selection.bounds.width,
      y: selection.bounds.y - selection.bounds.height,
      width: selection.bounds.width * 3,
      height: selection.bounds.height * 3,
    }),
    substitutionConsents: Object.freeze([]),
    currentRevision: revision,
    expectedRevision: revision,
    preconditions: await buildSelectionMutationPreconditions(store, selection),
  });
}

async function sourceDecorationInput(
  store: ObjectStore,
  decorations: Readonly<{ underline: boolean; strikethrough: boolean }>,
  replacement?: string,
): Promise<RichReplacementMutationInput> {
  const layout = groupPageText(await analysePage(store, 0));
  const group = layout.groups.find(({ text }) => text === 'Decorated text')!;
  const line = layout.lines.find(({ key }) => key === group.lineKey)!;
  const selection = buildTextSelection(
    line,
    group.glyphRange.start,
    group.glyphRange.end - 1,
  );
  const font = (await assets()).regular;
  const runText = replacement ?? selection.text;
  const run = Object.freeze({
    text: runText,
    style: selection.styleRuns[0]!.style,
    shapedRun: await shapeText({ fontBytes: font.bytes, text: runText }),
    fontAsset: font,
    decorations: Object.freeze({ ...decorations }),
  });
  return Object.freeze({
    pageIndex: 0,
    selection,
    runs: Object.freeze([run]),
    allowedRegion: Object.freeze({
      x: selection.bounds.x - selection.bounds.width,
      y: selection.bounds.y - selection.bounds.height,
      width: selection.bounds.width * 3,
      height: selection.bounds.height * 3,
    }),
    substitutionConsents: Object.freeze([]),
    currentRevision: 0,
    expectedRevision: 0,
    preconditions: await buildSelectionMutationPreconditions(store, selection),
  });
}

describe('rich selection redraw', () => {
  test('redraws one selection as extractable multi-font controlled content', async () => {
    const store = await fixtureStore();
    const source = await sentenceSelection(store);
    const input = await richInput(store, 0, ['this is a ', 'BOLD', ' text']);
    const sourceBytes = await store.serialiseCandidate();
    const result = await applyRichReplacement(
      store,
      input,
    );
    const reopened = await ObjectStore.open(result.candidateBytes, PROVISIONAL_LIMITS);
    const replacementLayout = groupPageText(await analysePage(reopened, 0));
    const replacement = replacementLayout.groups.find(({ text }) => text === 'this is a BOLD text');
    const operations = tokeniseContentStream(
      reopened.listPageStreams(0).at(-1)!.decodedBytes,
      PROVISIONAL_LIMITS,
    );
    expect(new TextDecoder().decode(reopened.listPageStreams(0).at(-1)!.decodedBytes))
      .toContain(`/${PDF_SCRUBBER_MARKED_CONTENT_TAG} <<`);
    const controlled = parseControlledRedraw(operations);
    const validation = await validateCandidateAgainstSource(sourceBytes, result.candidateBytes, {
      pageIndex: 0,
      targetBounds: source.selection.bounds,
      authorisedBounds: input.allowedRegion,
      oldText: 'this is a bold text',
      newText: 'this is a BOLD text',
      expectedOldTextOutsideTarget: 0,
      structure: {
        commandHash: result.commandHash,
        fontResourceNames: result.fontResourceNames,
        mutatedSourceStreams: input.selection.sourceSlices.map(({ streamPath }) => ({
          pageIndex: 0,
          streamPath,
        })),
      },
    }, nodeCanvasFactory);

    expect(replacement?.styleRuns.map(({ text }) => text)).toEqual([
      'this is a ',
      'BOLD',
      ' text',
    ]);
    expect(replacement?.styleRuns.map(({ style }) => style.fontWeight)).toEqual([400, 700, 400]);
    expect(replacement?.bounds.y).toBeCloseTo(source.selection.bounds.y, 3);
    expect(controlled?.version).toBe(3);
    expect(controlled?.actualText).toBe('this is a BOLD text');
    expect(controlled?.fontResourceNames).toHaveLength(2);
    expect(controlled?.runGlyphCounts).toEqual(input.runs.map(({ shapedRun }) => shapedRun.glyphs.length));
    expect(controlled?.runDecorations).toEqual(input.runs.map(({ decorations }) => decorations));
    expect(controlled?.decorationOperationIndexes).toEqual([]);
    expect(result.fontResourceNames).toHaveLength(2);
    expect(validation.extraction.newTextPresentAtTarget).toBe(true);
    expect(validation.extraction.oldTextAbsentAtTarget).toBe(true);
    expect(validation.sourceComparison).toMatchObject({
      outsideTextPreserved: true,
      outsidePixelsPreserved: true,
    });
    expect(validation.structure).toMatchObject({ valid: true });
    expect(validation.valid).toBe(true);
  }, 15_000);

  test('does not duplicate source spacing when a controlled replacement is reopened', async () => {
    const store = await spacingFixtureStore();
    const input = await spacingInput(store, 0);
    const preview = await previewRichReplacement(store, input);
    const result = await applyRichReplacement(store, input);
    const reopened = await ObjectStore.open(result.candidateBytes, PROVISIONAL_LIMITS);
    const replacement = groupPageText(await analysePage(reopened, 0)).groups.find(
      ({ text }) => text === 'Edited 05',
    );

    expect(replacement).toBeDefined();
    const bounds = replacement!.bounds;
    expect(bounds.x).toBeCloseTo(preview.replacementBounds.x, 5);
    expect(bounds.y).toBeCloseTo(preview.replacementBounds.y, 5);
    expect(bounds.width).toBeCloseTo(preview.replacementBounds.width, 5);
    expect(bounds.height).toBeCloseTo(preview.replacementBounds.height, 5);
    expect(bounds.x + bounds.width)
      .toBeCloseTo(
        preview.replacementBounds.x + preview.replacementBounds.width,
        5,
      );
    expect(replacement!.styleRuns[0]?.style).toMatchObject({
      characterSpacing: 2,
      wordSpacing: 4,
      horizontalScaling: 0.9,
    });
  }, 20_000);

  test('applies source spacing calibration to shaped advances', async () => {
    const store = await spacingFixtureStore();
    const input = await spacingInput(store, 0);
    const calibrated = Object.freeze({
      ...input,
      runs: Object.freeze(input.runs.map((run) => Object.freeze({
        ...run,
        sourceSpacingScale: 1.5,
      }))),
    });

    const normal = await previewRichReplacement(store, input);
    const adjusted = await previewRichReplacement(store, calibrated);

    expect(adjusted.replacementBounds.width).toBeGreaterThan(
      normal.replacementBounds.width,
    );
    expect(adjusted.commandHash).not.toBe(normal.commandHash);
  });

  test('uses source glyph advance profiles for existing run positions', async () => {
    const store = await spacingFixtureStore();
    const input = await spacingInput(store, 0);
    const profiled = Object.freeze({
      ...input,
      runs: Object.freeze(input.runs.map((run) => Object.freeze({
        ...run,
        sourceAdvanceProfile: Object.freeze(run.shapedRun.glyphs.map(() => 20)),
      }))),
    });

    const normal = await previewRichReplacement(store, input);
    const adjusted = await previewRichReplacement(store, profiled);

    expect(adjusted.replacementBounds.width).toBeGreaterThan(
      normal.replacementBounds.width,
    );
  });

  test('replaces a previously controlled rich selection as one mutation unit', async () => {
    const original = await fixtureStore();
    const first = await applyRichReplacement(
      original,
      await richInput(original, 0, ['this is a ', 'BOLD', ' text']),
    );
    const controlledStore = await ObjectStore.open(first.candidateBytes, PROVISIONAL_LIMITS);
    const controlledSelection = (await sentenceSelection(controlledStore)).selection;

    expect(controlledSelection.sourceSlices).toHaveLength(1);

    const second = await applyRichReplacement(
      controlledStore,
      await richInput(controlledStore, 1, ['this is a ', 'calm', ' text']),
    );
    const reopened = await ObjectStore.open(second.candidateBytes, PROVISIONAL_LIMITS);
    const layout = groupPageText(await analysePage(reopened, 0));

    expect(layout.groups.some(({ text }) => text === 'this is a calm text')).toBe(true);
    expect(layout.groups.some(({ text }) => text === 'this is a BOLD text')).toBe(false);
    expect(second.revision).toBe(2);
  }, 20_000);

  test('includes decoration flags in the deterministic rich command hash', async () => {
    const store = await fixtureStore();
    const plain = await richInput(store, 0, ['this is a ', 'bold', ' text']);
    const decorated = Object.freeze({
      ...plain,
      runs: Object.freeze(plain.runs.map((run, index) => Object.freeze({
        ...run,
        decorations: Object.freeze({
          underline: index === 1,
          strikethrough: index === 1,
        }),
      }))),
    });

    const plainPreview = await previewRichReplacement(store, plain);
    const decoratedPreview = await previewRichReplacement(store, decorated);

    expect(decoratedPreview.commandHash).not.toBe(plainPreview.commandHash);
  });

  test('renders independent and combined decorations after text and restores flags on reopen', async () => {
    const store = await fixtureStore();
    const plain = await richInput(store, 0, ['this is a ', 'bold', ' text']);
    const decorated = Object.freeze({
      ...plain,
      runs: Object.freeze(plain.runs.map((run, index) => Object.freeze({
        ...run,
        style: index === 1
          ? Object.freeze({
              ...run.style,
              fillColour: Object.freeze({
                colourSpace: 'DeviceRGB' as const,
                components: Object.freeze([0.25, 0.5, 0.75]),
              }),
            })
          : run.style,
        decorations: Object.freeze({
          underline: index !== 2,
          strikethrough: index !== 0,
        }),
      }))),
    });

    const result = await applyRichReplacement(store, decorated);
    const reopened = await ObjectStore.open(result.candidateBytes, PROVISIONAL_LIMITS);
    const operations = tokeniseContentStream(
      reopened.listPageStreams(0).at(-1)!.decodedBytes,
      PROVISIONAL_LIMITS,
    );
    const controlled = parseControlledRedraw(operations);
    const replacement = groupPageText(await analysePage(reopened, 0)).groups.find(
      ({ text }) => text === 'this is a bold text',
    );
    const firstDecoration = controlled?.decorationOperationIndexes[0] ?? -1;

    expect(controlled).toMatchObject({
      version: 3,
      runDecorations: [
        { underline: true, strikethrough: false },
        { underline: true, strikethrough: true },
        { underline: false, strikethrough: true },
      ],
    });
    expect(controlled?.decorationOperationIndexes).toHaveLength(4);
    expect(firstDecoration).toBeGreaterThan(Math.max(...(controlled?.textOperationIndexes ?? [])));
    expect(operations.some(({ operator, operands }) =>
      operator === 'rg' && operands.map((operand) => operand.kind === 'number' ? operand.value : null)
        .join(',') === '0.25,0.5,0.75')).toBe(true);
    expect(replacement?.styleRuns.map(({ decorations }) => decorations)).toEqual([
      { underline: true, strikethrough: false },
      { underline: true, strikethrough: true },
      { underline: false, strikethrough: true },
    ]);
  }, 20_000);

  test.each([
    ['rotated', true],
    ['sheared', false],
  ] as const)('transforms decoration quadrilaterals through the full %s text matrix', async (kind, vertical) => {
    const store = await ObjectStore.open(
      await buildDecorationFixture(kind),
      PROVISIONAL_LIMITS,
    );
    const layout = groupPageText(await analysePage(store, 0));
    const group = layout.groups.find(({ text }) => text === 'Decorated text')!;
    const line = layout.lines.find(({ key }) => key === group.lineKey)!;
    const selection = buildTextSelection(
      line,
      group.glyphRange.start,
      group.glyphRange.end - 1,
    );
    const font = (await assets()).regular;
    const run = Object.freeze({
      text: selection.text,
      style: selection.styleRuns[0]!.style,
      shapedRun: await shapeText({ fontBytes: font.bytes, text: selection.text }),
      fontAsset: font,
      decorations: Object.freeze({ underline: true, strikethrough: true }),
    });
    const result = await appendControlledRichRedraw(
      store,
      0,
      selection,
      [run],
      'a'.repeat(64),
    );
    const operations = tokeniseContentStream(result.contentBytes, PROVISIONAL_LIMITS);
    const controlled = parseControlledRedraw(operations)!;
    const fillIndex = controlled.decorationOperationIndexes[0]!;
    const move = operations[fillIndex - 5]!;
    const lineEnd = operations[fillIndex - 4]!;
    const coordinates = (operation: typeof move) => operation.operands.map((operand) =>
      operand.kind === 'number' ? operand.value : Number.NaN);
    const [startX, startY] = coordinates(move);
    const [endX, endY] = coordinates(lineEnd);

    expect(controlled.runDecorations).toEqual([
      { underline: true, strikethrough: true },
    ]);
    expect(controlled.decorationOperationIndexes).toHaveLength(2);
    expect(result.bounds).toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    });
    expect(result.bounds.width).toBeGreaterThan(0);
    expect(result.bounds.height).toBeGreaterThan(0);
    if (vertical) {
      expect(Math.abs(endX! - startX!)).toBeLessThan(1e-6);
      expect(Math.abs(endY! - startY!)).toBeGreaterThan(1);
    } else {
      expect(Math.abs(endX! - startX!)).toBeGreaterThan(1);
      expect(Math.abs(endY! - startY!)).toBeGreaterThan(1);
    }
  }, 20_000);

  test('produces a validator-safe rotated decorated replacement', async () => {
    const store = await ObjectStore.open(
      await buildDecorationFixture('rotated'),
      PROVISIONAL_LIMITS,
    );
    const sourceBytes = await store.serialiseCandidate();
    const input = await sourceDecorationInput(
      store,
      { underline: true, strikethrough: false },
      'Turned text',
    );
    const result = await applyRichReplacement(store, input);
    const validation = await validateCandidateAgainstSource(
      sourceBytes,
      result.candidateBytes,
      {
        pageIndex: 0,
        targetBounds: input.selection.bounds,
        authorisedBounds: input.allowedRegion,
        oldText: input.selection.text,
        newText: 'Turned text',
        expectedOldTextOutsideTarget: 0,
        structure: {
          commandHash: result.commandHash,
          fontResourceNames: result.fontResourceNames,
          mutatedSourceStreams: [
            ...input.selection.sourceSlices.map(({ streamPath }) => ({
              pageIndex: 0,
              streamPath,
            })),
            ...input.selection.sourceDecorations.map(({ graphic }) => ({
              pageIndex: 0,
              streamPath: graphic.address.streamPath,
            })),
          ],
        },
      },
      nodeCanvasFactory,
    );

    expect(validation.extraction.newTextPresentAtTarget).toBe(true);
    expect(validation.valid).toBe(true);
  }, 20_000);

  test.each([
    ['keeps and redraws', true, 1],
    ['turns off and removes', false, 0],
  ] as const)('%s a high-confidence source underline', async (_name, underline, graphicCount) => {
    const store = await ObjectStore.open(
      await buildDecorationFixture('stroked-underline'),
      PROVISIONAL_LIMITS,
    );
    const input = await sourceDecorationInput(store, {
      underline,
      strikethrough: false,
    });

    expect(input.selection.sourceDecorations).toHaveLength(1);
    const result = await applyRichReplacement(store, input);
    const reopened = await ObjectStore.open(result.candidateBytes, PROVISIONAL_LIMITS);
    const analysed = await analysePage(reopened, 0);
    const replacement = groupPageText(analysed).groups.find(
      ({ text }) => text === 'Decorated text',
    )!;
    const controlled = parseControlledRedraw(tokeniseContentStream(
      reopened.listPageStreams(0).at(-1)!.decodedBytes,
      PROVISIONAL_LIMITS,
    ));

    expect(analysed.decorationGraphics).toEqual([]);
    expect(replacement.styleRuns).toEqual([
      expect.objectContaining({
        decorations: { underline, strikethrough: false },
      }),
    ]);
    expect(controlled?.decorationOperationIndexes).toHaveLength(graphicCount);
  }, 20_000);
});
