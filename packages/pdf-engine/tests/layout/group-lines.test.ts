import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { describe, expect, test } from 'vitest';

import { analysePage } from '../../src/analysis/analyse-page';
import { groupPageText } from '../../src/layout/group-lines';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import { ObjectStore } from '../../src/pdf/object-store';
import { buildDecorationFixture } from '../../../test-support/src/corpus/decorations';

async function layoutFixture(id: string) {
  const bytes = await readFile(resolve('fixtures/generated', `${id}.pdf`));
  const store = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
  return groupPageText(await analysePage(store, 0));
}

async function layoutPdf(path: string) {
  const bytes = await readFile(path);
  const store = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
  return groupPageText(await analysePage(store, 0));
}

async function negativeScalePositiveTjDocument(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 300]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontName = page.node.newFontDictionary('Scaled', font.ref).toString();
  const stream = document.context.register(document.context.stream([
    'BT',
    `${fontName} 12 Tf`,
    '-100 Tz',
    '40 100 Td',
    '[(A) 1000 (B)] TJ',
    'ET',
  ].join('\n')));
  page.node.set(PDFName.of('Contents'), stream);
  return document.save({ useObjectStreams: false });
}

function sourceKey(source: {
  streamPath: readonly { ref: { objectNumber: number; generationNumber: number } }[];
  operatorIndex: number;
  glyphIndex: number;
}): string {
  return `${source.streamPath.map(({ ref }) =>
    `${ref.objectNumber}:${ref.generationNumber}`).join('/')}|${source.operatorIndex}|${source.glyphIndex}`;
}

describe('groupPageText', () => {
  test('reconstructs ONLYOFFICE word gaps without turning TJ kerning into spaces', async () => {
    const onlyOffice = await layoutPdf('ONLYOFFICE.pdf');
    const kerned = await layoutFixture('02-kerned-tj-array');

    expect(onlyOffice.lines.map(({ groups }) => groups.map(({ text }) => text).join('')))
      .toEqual(['Alpha Beta', 'Gamma Delta']);
    expect(kerned.lines.flatMap(({ groups }) => groups.map(({ text }) => text)))
      .toContain('Target 02');
  });

  test('does not infer a space from a positive TJ value under negative scaling', async () => {
    const store = await ObjectStore.open(
      await negativeScalePositiveTjDocument(),
      PROVISIONAL_LIMITS,
    );
    const layout = groupPageText(await analysePage(store, 0));

    expect(layout.lines.map(({ groups }) => groups.map(({ text }) => text).join('')))
      .toEqual(['AB']);
  });

  test('groups every eligible wkhtmltopdf glyph into the intended fields and sentence', async () => {
    const layout = await layoutFixture('30-wkhtmltopdf-rich-line');

    expect(layout.lines).toHaveLength(3);
    expect(layout.groups.map(({ text }) => text)).toEqual([
      'Shopee',
      'Customer Name:',
      'Alex Morgan',
      'this is a bold text',
    ]);
    expect(layout.groups.map(({ styleRuns }) => styleRuns.length)).toEqual([1, 1, 1, 3]);
    expect(layout.eligibleSourceGlyphCount).toBe(50);

    const covered = layout.lines.flatMap((line) => line.groups.flatMap((group) =>
      line.glyphs.slice(group.glyphRange.start, group.glyphRange.end)
        .map(({ source }) => sourceKey(source)),
    ));
    expect(new Set(covered).size).toBe(50);
    expect(covered).toHaveLength(50);
  });

  test('does not split a visual line merely because its font style changes', async () => {
    const layout = await layoutFixture('30-wkhtmltopdf-rich-line');
    const sentence = layout.groups.find(({ text }) => text === 'this is a bold text')!;

    expect(sentence.styleRuns.map(({ text }) => text)).toEqual([
      'this is a ',
      'bold',
      ' text',
    ]);
    expect(new Set(sentence.styleRuns.map(({ style }) => style.fontWeight))).toEqual(
      new Set([400, 700]),
    );
  });

  test('publishes deterministic read-only outcomes for bidi and vertical text', async () => {
    const [bidi, vertical] = await Promise.all([
      layoutFixture('09-bidirectional'),
      layoutFixture('10-vertical-writing'),
    ]);

    expect(bidi.lines[0]?.capability).toEqual({
      kind: 'readOnly',
      reasons: ['unsupportedEncoding'],
    });
    expect(vertical.lines[0]?.capability).toEqual({
      kind: 'readOnly',
      reasons: ['unsupportedEncoding'],
    });
  });

  test.each([
    ['stroked-underline', { underline: true, strikethrough: false }],
    ['filled-strikethrough', { underline: false, strikethrough: true }],
    ['combined', { underline: true, strikethrough: true }],
    ['rotated', { underline: true, strikethrough: false }],
    ['sheared', { underline: false, strikethrough: true }],
  ] as const)('matches %s to the uniquely owned text run', async (kind, decorations) => {
    const store = await ObjectStore.open(await buildDecorationFixture(kind), PROVISIONAL_LIMITS);

    const layout = groupPageText(await analysePage(store, 0));
    const line = layout.lines.find(({ groups }) =>
      groups.some(({ text }) => text === 'Decorated text'))!;

    expect(line.glyphs.every((glyph) =>
      glyph.decorations.underline === decorations.underline &&
      glyph.decorations.strikethrough === decorations.strikethrough)).toBe(true);
    expect(line.sourceDecorations.map(({ kind: value }) => value))
      .toEqual(decorations.underline && decorations.strikethrough
        ? ['underline', 'strikethrough']
        : [decorations.underline ? 'underline' : 'strikethrough']);
    expect(line.decorationWarnings).toEqual([]);
    expect(line.capability.kind).not.toBe('readOnly');
  });

  test.each([
    ['table', null],
    ['double-custom', null],
    ['separator', 'ambiguous-geometry'],
    ['ambiguous-owner', 'multiple-owners'],
    ['shared-stream', 'shared-content'],
  ] as const)('never turns %s graphics into mutable decoration evidence', async (kind, warning) => {
    const store = await ObjectStore.open(await buildDecorationFixture(kind), PROVISIONAL_LIMITS);

    const layout = groupPageText(await analysePage(store, 0));

    expect(layout.lines.flatMap(({ sourceDecorations }) => sourceDecorations)).toEqual([]);
    expect(layout.lines.flatMap(({ glyphs }) => glyphs).every(({ decorations }) =>
      !decorations.underline && !decorations.strikethrough)).toBe(true);
    if (warning !== null) {
      expect(layout.decorationWarnings).toEqual([
        expect.objectContaining({ reason: warning }),
      ]);
    }
  });
});
