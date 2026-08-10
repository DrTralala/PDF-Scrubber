import { readFile } from 'node:fs/promises';

import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { describe, expect, test } from 'vitest';

import { createReplacementFixture } from '@pdf-editor/test-support';

import { analysePage } from '../../src/analysis/analyse-page';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import { ObjectStore } from '../../src/pdf/object-store';

import {
  validateCandidate,
  validateCandidateAgainstSource,
  type ValidationCanvasFactory,
} from '../../src/validation/pdfjs-validator';
import { parseControlledRedraw } from '../../src/content/controlled-redraw';
import { tokeniseContentStream } from '../../src/content/tokeniser';

const nodeCanvasFactory: ValidationCanvasFactory = (width, height) => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  return {
    canvas,
    context,
    readRgba: () => new Uint8Array(context.getImageData(0, 0, width, height).data),
  };
};

async function whiteOutCounterfeit(): Promise<Readonly<{
  bytes: Uint8Array;
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
}>> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('Target 01', { x: 72, y: 700, size: 24, font });
  page.drawText('Target 01', { x: 300, y: 500, size: 24, font });
  page.drawRectangle({ x: 70, y: 696, width: 120, height: 30, color: rgb(1, 1, 1) });
  page.drawText('Edited 01', { x: 72, y: 700, size: 24, font });
  return Object.freeze({
    bytes: await document.save({ useObjectStreams: false }),
    bounds: Object.freeze({ x: 70, y: 696, width: 120, height: 30 }),
  });
}

async function sourceAwareExpectation(replacement: Awaited<ReturnType<typeof createReplacementFixture>>) {
  const source = await ObjectStore.open(replacement.originalBytes, PROVISIONAL_LIMITS);
  const sourceSpan = (await analysePage(source, 0)).spans.find(
    ({ unicode }) => unicode === replacement.oldText,
  )!;
  const candidate = await ObjectStore.open(replacement.candidateBytes, PROVISIONAL_LIMITS);
  const controlled = candidate.listPageStreams(0)
    .filter(({ path }) => path.length === 1)
    .map(({ decodedBytes }) => parseControlledRedraw(
      tokeniseContentStream(decodedBytes, PROVISIONAL_LIMITS),
    ))
    .find((value) => value !== null)!;
  return Object.freeze({
    pageIndex: 0,
    targetBounds: replacement.targetBounds,
    authorisedBounds: replacement.targetBounds,
    oldText: replacement.oldText,
    newText: replacement.newText,
    expectedOldTextOutsideTarget: 0,
    structure: Object.freeze({
      commandHash: controlled.commandHash,
      fontResourceNames: controlled.fontResourceNames,
      mutatedSourceStreams: Object.freeze([Object.freeze({
        pageIndex: 0,
        streamPath: sourceSpan.address.streamPath,
      })]),
    }),
  });
}

describe('PDF.js runtime validation', () => {
  test('rejects rendering before canvas allocation when the image pixel cap is exceeded', async () => {
    const bytes = new Uint8Array(await readFile('fixtures/generated/01-simple-tj.pdf'));
    const evidence = await validateCandidate(
      bytes,
      {
        pageIndex: 0,
        targetBounds: { x: 0, y: 0, width: 612, height: 792 },
        oldText: '',
        newText: '',
        expectedOldTextOutsideTarget: 0,
      },
      nodeCanvasFactory,
      { ...PROVISIONAL_LIMITS, maxImagePixels: 1 },
    );

    expect(evidence).toMatchObject({
      valid: false,
      checks: ['document-load-failed'],
      error: {
        code: 'RESOURCE_LIMIT',
        details: {
          resource: 'imagePixels',
          limit: 1,
          observedPixels: expect.any(Number),
        },
      },
    });
  });

  test('accepts a true excision and replacement at the authoritative target', async () => {
    const replacement = await createReplacementFixture('Edited 01');

    const evidence = await validateCandidate(replacement.candidateBytes, {
      pageIndex: 0,
      targetBounds: replacement.targetBounds,
      oldText: 'Target 01',
      newText: 'Edited 01',
      expectedOldTextOutsideTarget: 0,
    }, nodeCanvasFactory);

    expect(evidence.valid).toBe(true);
    expect(evidence.consumer).toBe('pdfjs');
    expect(evidence.render.dpi).toBe(144);
    expect(evidence.extraction.oldTextAbsentAtTarget).toBe(true);
    expect(evidence.extraction.newTextPresentAtTarget).toBe(true);
  }, 15_000);

  test('accepts a candidate only when source text, pixels, structure, and fonts are preserved outside the authorised edit', async () => {
    const replacement = await createReplacementFixture('E 01');
    const expectation = await sourceAwareExpectation(replacement);

    const evidence = await validateCandidateAgainstSource(
      replacement.originalBytes,
      replacement.candidateBytes,
      expectation,
      nodeCanvasFactory,
    );

    expect(evidence.valid).toBe(true);
    expect(evidence.sourceComparison).toMatchObject({
      pageGeometryPreserved: true,
      outsideTextPreserved: true,
      outsidePixelsPreserved: true,
      outsideMismatchedPixels: 0,
    });
    expect(evidence.structure).toMatchObject({
      valid: true,
      controlledText: 'E 01',
      fontResourcesPresent: true,
      sourceStreamsPreserved: true,
    });
  }, 20_000);

  test('derives outside-text preservation from the source instead of a caller occurrence count', async () => {
    const replacement = await createReplacementFixture('E 01');
    const expectation = await sourceAwareExpectation(replacement);

    const evidence = await validateCandidateAgainstSource(
      replacement.originalBytes,
      replacement.candidateBytes,
      { ...expectation, expectedOldTextOutsideTarget: 99 },
      nodeCanvasFactory,
    );

    expect(evidence.extraction.outsideTextPreserved).toBe(false);
    expect(evidence.sourceComparison?.outsideTextPreserved).toBe(true);
    expect(evidence.valid).toBe(true);
    expect(evidence.checks).not.toContain('outside-text-changed');
  }, 20_000);

  test('rejects candidate text and pixels changed outside the authorised edit region', async () => {
    const replacement = await createReplacementFixture('E 01');
    const expectation = await sourceAwareExpectation(replacement);
    const document = await PDFDocument.load(replacement.candidateBytes, { updateMetadata: false });
    const font = await document.embedFont(StandardFonts.Helvetica);
    document.getPage(0).drawText('Unauthorised', { x: 300, y: 500, size: 18, font });
    document.getPage(0).drawRectangle({
      x: 300,
      y: 460,
      width: 40,
      height: 20,
      color: rgb(1, 0, 0),
    });
    const tampered = await document.save({ useObjectStreams: false, updateFieldAppearances: false });

    const evidence = await validateCandidateAgainstSource(
      replacement.originalBytes,
      tampered,
      expectation,
      nodeCanvasFactory,
    );

    expect(evidence.valid).toBe(false);
    expect(evidence.sourceComparison).toMatchObject({
      outsideTextPreserved: false,
      outsidePixelsPreserved: false,
    });
    expect(evidence.sourceComparison!.outsideMismatchedPixels).toBeGreaterThan(0);
    expect(evidence.checks).toContain('outside-pixels-changed');
  }, 20_000);

  test('rejects an otherwise invisible unexpected content stream', async () => {
    const replacement = await createReplacementFixture('E 01');
    const expectation = await sourceAwareExpectation(replacement);
    const candidate = await ObjectStore.open(replacement.candidateBytes, PROVISIONAL_LIMITS);
    await candidate.appendPageContentStream(0, new TextEncoder().encode('% unexpected\n'));
    const tampered = await candidate.serialiseCandidate();

    const evidence = await validateCandidateAgainstSource(
      replacement.originalBytes,
      tampered,
      expectation,
      nodeCanvasFactory,
    );

    expect(evidence.valid).toBe(false);
    expect(evidence.sourceComparison).toMatchObject({
      outsideTextPreserved: true,
      outsidePixelsPreserved: true,
    });
    expect(evidence.structure).toMatchObject({ valid: false });
    expect(evidence.structure!.checks).toContain('unexpected-content-stream');
  }, 20_000);

  test('rejects controlled redraw evidence that does not match the expected font resource', async () => {
    const replacement = await createReplacementFixture('E 01');
    const expectation = await sourceAwareExpectation(replacement);

    const evidence = await validateCandidateAgainstSource(
      replacement.originalBytes,
      replacement.candidateBytes,
      {
        ...expectation,
        structure: {
          ...expectation.structure,
          fontResourceNames: ['M0R_0000000000000000'],
        },
      },
      nodeCanvasFactory,
    );

    expect(evidence.valid).toBe(false);
    expect(evidence.structure).toMatchObject({
      valid: false,
      fontResourcesPresent: false,
    });
    expect(evidence.structure!.checks).toContain('controlled-redraw-mismatch');
  }, 20_000);

  test('rejects a white-out-only counterfeit while preserving identical text elsewhere', async () => {
    const counterfeit = await whiteOutCounterfeit();
    const evidence = await validateCandidate(counterfeit.bytes, {
      pageIndex: 0,
      targetBounds: counterfeit.bounds,
      oldText: 'Target 01',
      newText: 'Edited 01',
      expectedOldTextOutsideTarget: 1,
    }, nodeCanvasFactory);

    expect(evidence.extraction.oldTextAbsentAtTarget).toBe(false);
    expect(evidence.extraction.oldTextOutsideTargetCount).toBe(1);
    expect(evidence.valid).toBe(false);
  }, 15_000);

  test('returns typed invalid evidence for a corrupted export', async () => {
    const evidence = await validateCandidate(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      pageIndex: 0,
      targetBounds: { x: 0, y: 0, width: 1, height: 1 },
      oldText: 'old',
      newText: 'new',
      expectedOldTextOutsideTarget: 0,
    }, nodeCanvasFactory);

    expect(evidence.valid).toBe(false);
    expect(evidence.checks).toContain('document-load-failed');
    expect(evidence.error?.code).toBe('VALIDATION_FAILURE');
  });

  test.each([
    '11-rotate-90',
    '14-crop-nonzero-origin',
    '15-user-unit',
  ])('matches PDF.js extraction through canonical page coordinates for %s', async (id) => {
    const bytes = new Uint8Array(await readFile(`fixtures/generated/${id}.pdf`));
    const store = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
    const span = (await analysePage(store, 0)).spans[0]!;
    const evidence = await validateCandidate(bytes, {
      pageIndex: 0,
      targetBounds: span.bounds,
      oldText: '',
      newText: span.unicode!,
      expectedOldTextOutsideTarget: 0,
    }, nodeCanvasFactory);

    expect(evidence.extraction.newTextPresentAtTarget).toBe(true);
    expect(evidence.valid).toBe(true);
  }, 15_000);
});
