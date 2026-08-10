import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createCanvas } from '@napi-rs/canvas';
import { PDFArray, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { describe, expect, test } from 'vitest';

import { analysePage } from '../../src/analysis/analyse-page';
import { classifyReplacement } from '../../src/classification/classify';
import { shapeText } from '../../src/fonts/harfbuzz-shaper';
import type { SubstituteFontAsset } from '../../src/fonts/font-embedding';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import type { AnalysedSpan } from '../../src/model';
import { buildMutationPreconditions } from '../../src/mutation/excise';
import {
  PDF_SCRUBBER_PAGE_ISOLATION_PREFIX,
  PDF_SCRUBBER_PAGE_ISOLATION_SUFFIX,
} from '../../src/mutation/isolate-page';
import {
  applyReplacement,
  previewReplacement,
  type ReplacementMutationInput,
} from '../../src/mutation/replace-span';
import { ObjectStore } from '../../src/pdf/object-store';
import {
  validateCandidate,
  type ValidationCanvasFactory,
} from '../../src/validation/pdfjs-validator';

const LATIN_PATH = resolve(
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff',
);
const ARABIC_PATH = resolve(
  'node_modules/@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff',
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

async function replacementInput(
  store: ObjectStore,
  replacement: string,
  fontPath: string,
  selectedSpan?: AnalysedSpan,
): Promise<ReplacementMutationInput> {
  const span = selectedSpan ?? (await analysePage(store, 0)).spans.find(
    ({ unicode }) => unicode === 'Target 01',
  )!;
  const fontBytes = new Uint8Array(await readFile(fontPath));
  const asset: SubstituteFontAsset = Object.freeze({
    bytes: fontBytes,
    family: fontPath === ARABIC_PATH ? 'Noto Sans Arabic' : 'Noto Sans',
    version: '5.3.0',
    licence: 'OFL-1.1',
    source: fontPath === ARABIC_PATH
      ? '@fontsource/noto-sans-arabic'
      : '@fontsource/noto-sans',
  });
  return {
    pageIndex: 0,
    span,
    replacement,
    classification: classifyReplacement(span, replacement, {
      existingFontCanEncode: false,
      substituteFontAvailable: true,
      substituteFontEmbeddable: true,
      replacementBounds: span.bounds,
      acceptSubstitution: true,
    }),
    shapedRun: await shapeText({
      fontBytes,
      text: replacement.normalize('NFC'),
      ...(fontPath === ARABIC_PATH ? { script: 'Arab', language: 'ar' } : {}),
    }),
    fontAsset: asset,
    currentRevision: 0,
    expectedRevision: 0,
    preconditions: await buildMutationPreconditions(store, 0, span),
  };
}

async function fixtureStore(): Promise<ObjectStore> {
  return ObjectStore.open(
    await readFile('fixtures/generated/01-simple-tj.pdf'),
    PROVISIONAL_LIMITS,
  );
}

async function twoStreamStore(): Promise<ObjectStore> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontName = page.node.newFontDictionary('M0', font.ref).toString();
  const target = document.context.register(document.context.stream(
    `BT ${fontName} 24 Tf 72 700 Td (Target 01) Tj ET`,
  ));
  const untouched = document.context.register(document.context.stream(
    'q 0.25 w 10 10 m 20 20 l S Q % untouched',
  ));
  const contents = PDFArray.withContext(document.context);
  contents.push(target);
  contents.push(untouched);
  page.node.set(PDFName.of('Contents'), contents);
  return ObjectStore.open(
    await document.save({ useObjectStreams: false }),
    PROVISIONAL_LIMITS,
  );
}

describe('replacement mutation', () => {
  test.each([
    ['Goodbye', LATIN_PATH],
    ['مرحبا', ARABIC_PATH],
    ['Re\u0301sume\u0301 08', LATIN_PATH],
  ])('excises Target 01 and redraws extractable %s in a controlled stream', async (
    replacement,
    fontPath,
  ) => {
    const store = await fixtureStore();
    const input = await replacementInput(store, replacement, fontPath);
    const originalStreams = store.listPageStreams(0);

    const preview = await previewReplacement(store, input);
    expect(store.listPageStreams(0)).toEqual(originalStreams);
    expect(preview.nextRevision).toBe(1);

    const result = await applyReplacement(store, input);
    const reopened = await ObjectStore.open(result.candidateBytes, PROVISIONAL_LIMITS);
    const streams = reopened.listPageStreams(0);
    const replacementStream = new TextDecoder().decode(streams.at(-1)!.decodedBytes);

    expect(new TextDecoder().decode(streams[0]!.decodedBytes)).not.toContain('Target 01');
    expect(replacementStream).toMatch(/^q\nBT\n\/M0R_[0-9a-f]{16} /);
     expect(replacementStream).toContain('\nET\nQ\n');
    expect((await analysePage(reopened, 0)).spans
      .map(({ unicode }) => unicode)
      .join('')
      .normalize('NFC')
      .replace(/\s+/gu, ''))
      .toContain(replacement.normalize('NFC').replace(/\s+/gu, ''));
    expect(new TextDecoder('latin1').decode(result.candidateBytes)).toContain('/ToUnicode');
    expect(result.revision).toBe(1);
  });

  test('keeps unrelated root streams in order and byte-identical', async () => {
    const store = await twoStreamStore();
    const rootsBefore = store.listPageStreams(0);
    const untouchedBefore = rootsBefore[1]!.encodedBytes;

    const result = await applyReplacement(
      store,
      await replacementInput(store, 'Goodbye', LATIN_PATH),
    );
    const reopened = await ObjectStore.open(result.candidateBytes, PROVISIONAL_LIMITS);
    const rootsAfter = reopened.listPageStreams(0);

    expect(rootsAfter.map(({ decodedBytes }) => new TextDecoder().decode(decodedBytes))).toEqual([
      PDF_SCRUBBER_PAGE_ISOLATION_PREFIX,
      expect.any(String),
      'q 0.25 w 10 10 m 20 20 l S Q % untouched',
      PDF_SCRUBBER_PAGE_ISOLATION_SUFFIX,
      expect.stringMatching(/^q\nBT\n\/M0R_/),
    ]);
    expect(rootsAfter[1]!.path[0]!.ref).toEqual(rootsBefore[0]!.path[0]!.ref);
    expect(rootsAfter[2]!.path[0]!.ref).toEqual(rootsBefore[1]!.path[0]!.ref);
    expect(rootsAfter[2]!.encodedBytes).toEqual(untouchedBefore);
    expect(rootsAfter).toHaveLength(rootsBefore.length + 3);
  });

  test('isolates a persistent root CTM before positioning the controlled redraw', async () => {
    const store = await ObjectStore.open(
      await readFile('fixtures/generated/30-wkhtmltopdf-rich-line.pdf'),
      PROVISIONAL_LIMITS,
    );
    const source = (await analysePage(store, 0)).spans.find(({ unicode }) => unicode === 'C')!;
    const result = await applyReplacement(
      store,
      await replacementInput(store, 'Z', LATIN_PATH, source),
    );
    const reopened = await ObjectStore.open(result.candidateBytes, PROVISIONAL_LIMITS);
    const replacement = (await analysePage(reopened, 0)).spans.find(({ unicode }) => unicode === 'Z')!;

    expect(replacement.baseline[0]).toBeCloseTo(source.baseline[0], 6);
    expect(replacement.baseline[1]).toBeCloseTo(source.baseline[1], 6);
    expect((await analysePage(reopened, 0)).graphicsState.finalCtm).toEqual([1, 0, 0, 1, 0, 0]);
  });

  test('redraws Arabic text with digits in logical extraction order', async () => {
    const replacement = 'إيصال ٠٩';
    const store = await fixtureStore();
    const input = await replacementInput(store, replacement, ARABIC_PATH);
    const result = await applyReplacement(store, input);

    const evidence = await validateCandidate(result.candidateBytes, {
      pageIndex: 0,
      targetBounds: input.span.bounds,
      oldText: 'Target 01',
      newText: replacement,
      expectedOldTextOutsideTarget: 0,
    }, nodeCanvasFactory);

    expect(evidence.extraction.targetText).toBe(replacement.replace(/\s+/gu, ''));
    expect(evidence.extraction.newTextPresentAtTarget).toBe(true);
  }, 15_000);
});
