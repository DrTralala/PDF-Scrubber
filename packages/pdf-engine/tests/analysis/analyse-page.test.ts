import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PDFArray, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { describe, expect, test } from 'vitest';

import { analysePage } from '../../src/analysis/analyse-page';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import { spanAddressKey } from '../../src/model';
import { ObjectStore } from '../../src/pdf/object-store';
import { buildDecorationFixture } from '../../../test-support/src/corpus/decorations';

async function fixture(id: string): Promise<Uint8Array> {
  return readFile(resolve('fixtures/generated', `${id}.pdf`));
}

async function analyseFixture(id: string, pageIndex = 0) {
  const store = await ObjectStore.open(await fixture(id), PROVISIONAL_LIMITS);
  return analysePage(store, pageIndex);
}

async function positionedDocument(x: number, y: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 300]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontName = page.node.newFontDictionary('Stable', font.ref).toString();
  const stream = document.context.register(
    document.context.stream(`BT ${fontName} 12 Tf ${x} ${y} Td (Stable) Tj ET`),
  );
  page.node.set(PDFName.of('Contents'), stream);
  return document.save({ useObjectStreams: false });
}

async function styledDocument(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 300]);
  const font = await document.embedFont(StandardFonts.HelveticaBoldOblique);
  const fontName = page.node.newFontDictionary('Styled', font.ref).toString();
  const stream = document.context.register(
    document.context.stream([
      '0.1 0.2 0.3 rg',
      '0.4 G',
      'BT',
      `${fontName} 18 Tf`,
      '2 Tc',
      '4 Tw',
      '90 Tz',
      '5 Ts',
      '2 Tr',
      '20 40 Td',
      '(AB) Tj',
      'ET',
    ].join('\n')),
  );
  page.node.set(PDFName.of('Contents'), stream);
  return document.save({ useObjectStreams: false });
}

async function imageAndTextDocument(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 300]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontName = page.node.newFontDictionary('Text', font.ref).toString();
  const image = document.context.register(document.context.flateStream(
    Uint8Array.of(0),
    {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 1,
      Height: 1,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    },
  ));
  const imageName = page.node.newXObject('Image', image).toString();
  const stream = document.context.register(document.context.stream([
    `q 20 0 0 20 10 10 cm ${imageName} Do Q`,
    `BT ${fontName} 12 Tf 40 50 Td (After image) Tj ET`,
  ].join('\n')));
  page.node.set(PDFName.of('Contents'), stream);
  return document.save({ useObjectStreams: false });
}

describe('analysePage', () => {
  test('returns the exact page space used for canonical span bounds', async () => {
    const page = await analyseFixture('14-crop-nonzero-origin');
    expect(page.pageSpace).toEqual({
      mediaBox: [20, 30, 632, 822],
      cropBox: [40, 50, 572, 742],
      rotate: 0,
      userUnit: 1,
    });
  });

  test.each([
    ['01-simple-tj', 'Target 01'],
    ['02-kerned-tj-array', 'Target 02'],
    ['03-single-quote', 'Target 03'],
    ['04-double-quote', 'Target 04'],
  ])('extracts authoritative Unicode from %s', async (id, expected) => {
    const page = await analyseFixture(id);
    expect(page.spans.map(({ unicode }) => unicode)).toContain(expected);
    const span = page.spans.find(({ unicode }) => unicode === expected)!;
    expect(span.address.operatorRange.end - span.address.operatorRange.start).toBe(1);
    expect(span.address.glyphRange).toEqual({ start: 0, end: expected.length });
    expect(span.glyphs.map(({ unicode }) => unicode).join('')).toBe(expected);
  });

  test('applies character spacing, word spacing, rise, and horizontal scaling to bounds', async () => {
    const plain = (await analyseFixture('01-simple-tj')).spans.find(
      ({ unicode }) => unicode === 'Target 01',
    )!;
    const adjusted = (await analyseFixture('05-spacing-rise-scale')).spans.find(
      ({ unicode }) => unicode === 'Target 05',
    )!;

    expect(adjusted.bounds.width).toBeGreaterThan(plain.bounds.width);
    expect(adjusted.baseline[1]).toBeCloseTo(plain.baseline[1] + 6, 7);
  });

  test('retains every nested Form reference in the span address', async () => {
    const span = (await analyseFixture('17-nested-form-xobject')).spans.find(
      ({ unicode }) => unicode === 'Target 17',
    )!;

    expect(span.address.streamPath.map(({ kind }) => kind)).toEqual([
      'pageContents',
      'formXObject',
      'formXObject',
    ]);
    expect(span.address.streamPath.map(({ resourceName }) => resourceName)).toEqual([
      null,
      expect.stringMatching(/^M0Form-/),
      'Inner',
    ]);
  });

  test('reports a shared Form span with reference count two', async () => {
    const span = (await analyseFixture('18-shared-form-xobject')).spans.find(
      ({ unicode }) => unicode === 'Target 18',
    )!;
    expect(span.resource.referenceCount).toBe(2);
  });

  test('keeps address identity independent of glyph geometry', async () => {
    const firstStore = await ObjectStore.open(await positionedDocument(20, 30), PROVISIONAL_LIMITS);
    const secondStore = await ObjectStore.open(await positionedDocument(120, 180), PROVISIONAL_LIMITS);
    const first = (await analysePage(firstStore, 0)).spans[0]!;
    const second = (await analysePage(secondStore, 0)).spans[0]!;

    expect(spanAddressKey(first.address)).toBe(spanAddressKey(second.address));
    expect(first.bounds).not.toEqual(second.bounds);
  });

  test('carries graphics state across ordered page content streams', async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([300, 300]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    const fontName = page.node.newFontDictionary('Split', font.ref).toString();
    const first = document.context.register(document.context.stream('q 1 0 0 1 40 50 cm'));
    const second = document.context.register(
      document.context.stream(`BT ${fontName} 12 Tf 10 20 Td (Split) Tj ET Q`),
    );
    const contents = PDFArray.withContext(document.context);
    contents.push(first);
    contents.push(second);
    page.node.set(PDFName.of('Contents'), contents);
    const store = await ObjectStore.open(
      await document.save({ useObjectStreams: false }),
      PROVISIONAL_LIMITS,
    );

    const analysed = await analysePage(store, 0);

    expect(analysed.spans[0]?.baseline).toEqual([50, 70]);
  });

  test('reports persistent final root graphics state for safe redraw isolation', async () => {
    const page = await analyseFixture('30-wkhtmltopdf-rich-line');

    expect(page.graphicsState).toEqual({
      balanced: true,
      finalCtm: [0.75, 0, 0, -0.75, 28.5, 656.75],
    });
  });

  test('ignores image XObjects while analysing text on the same page', async () => {
    const store = await ObjectStore.open(await imageAndTextDocument(), PROVISIONAL_LIMITS);

    const page = await analysePage(store, 0);

    expect(page.spans.map(({ unicode }) => unicode)).toEqual(['After image']);
  });

  test('records source identity and canonical geometry on every analysed glyph', async () => {
    const page = await analyseFixture('02-kerned-tj-array');
    const span = page.spans.find(({ unicode }) => unicode === 'Target 02')!;

    expect(span.glyphs).toHaveLength(9);
    expect(span.glyphs[0]?.source).toEqual({
      pageRef: span.address.pageRef,
      streamPath: span.address.streamPath,
      operatorIndex: span.address.operatorRange.start,
      glyphIndex: 0,
      sourceCodeRange: { start: 0, end: 1 },
    });
    expect(span.glyphs.every(({ bounds }) => bounds.width > 0 && bounds.height > 0)).toBe(true);
    expect(span.glyphs.every(({ baseline }) => baseline[1] === span.baseline[1])).toBe(true);
    expect(span.glyphs[1]!.baseline[0]).toBeGreaterThan(span.glyphs[0]!.baseline[0]);
  });

  test('captures the effective text state and font style used to paint a glyph', async () => {
    const store = await ObjectStore.open(await styledDocument(), PROVISIONAL_LIMITS);
    const span = (await analysePage(store, 0)).spans[0]!;

    expect(span.style).toEqual({
      fontResourceName: span.resource.fontResourceName,
      fontBaseName: 'Helvetica-BoldOblique',
      fontSize: 18,
      horizontalScaling: 0.9,
      characterSpacing: 2,
      wordSpacing: 4,
      rise: 5,
      renderingMode: 2,
      fillColour: { colourSpace: 'DeviceRGB', components: [0.1, 0.2, 0.3] },
      strokeColour: { colourSpace: 'DeviceGray', components: [0.4] },
      fontWeight: 700,
      italicAngle: -12,
    });
    expect(span.glyphs.every(({ styleKey }) => styleKey === span.styleKey)).toBe(true);
  });

  test.each([
    ['stroked-underline', 1],
    ['filled-strikethrough', 1],
    ['combined', 2],
    ['rotated', 1],
    ['sheared', 1],
    ['separator', 1],
    ['ambiguous-owner', 1],
    ['shared-stream', 1],
    ['table', 0],
    ['double-custom', 0],
  ] as const)('publishes only conservative source graphic candidates for %s', async (kind, count) => {
    const store = await ObjectStore.open(await buildDecorationFixture(kind), PROVISIONAL_LIMITS);

    const page = await analysePage(store, 0);

    expect(page.decorationGraphics).toHaveLength(count);
    if (kind === 'shared-stream') {
      expect(page.decorationGraphics[0]).toMatchObject({ referenceCount: 2 });
    }
  });
});
