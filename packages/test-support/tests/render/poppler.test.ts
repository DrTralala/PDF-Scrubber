import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';
import { analysePage, ObjectStore, PROVISIONAL_LIMITS } from '@pdf-editor/pdf-engine';

import { evaluateExtraction } from '../../src/diff/extraction';
import { collectPopplerEvidence } from '../../src/render/poppler';
import { createReplacementFixture } from '../../src/validation/replacement-fixture';

describe('Poppler validation adapter', () => {
  test('extracts positioned text and renders a fixed-144-DPI page', async () => {
    const evidence = await collectPopplerEvidence(
      await readFile('fixtures/generated/01-simple-tj.pdf'),
      0,
    );

    expect(evidence.consumer).toBe('poppler');
    expect(evidence.extraction.some(({ text }) => text.includes('Target 01'))).toBe(true);
    expect(evidence.image.width).toBe(1224);
    expect(evidence.image.height).toBe(1584);
    expect(evidence.image.rgba).toHaveLength(1224 * 1584 * 4);
  }, 15_000);

  test('does not interpolate document-derived text into command arguments', async () => {
    const evidence = await collectPopplerEvidence(
      await readFile('fixtures/generated/04-double-quote.pdf'),
      0,
    );

    expect(evidence.commands.every((command) =>
      command.args.every((argument) => !argument.includes('Target 04')),
    )).toBe(true);
  }, 15_000);

  test('independently confirms old-text absence and replacement presence', async () => {
    const replacement = await createReplacementFixture('Edited 01');
    const evidence = await collectPopplerEvidence(replacement.candidateBytes, 0);
    const extraction = evaluateExtraction(evidence.extraction, {
      pageIndex: 0,
      targetBounds: replacement.targetBounds,
      oldText: 'Target 01',
      newText: 'Edited 01',
      expectedOldTextOutsideTarget: 0,
    });

    expect(extraction.oldTextAbsentAtTarget).toBe(true);
    expect(extraction.newTextPresentAtTarget).toBe(true);
    expect(extraction.valid).toBe(true);
  }, 15_000);

  test('extracts Arabic replacement text with digits in logical order', async () => {
    const newText = 'إيصال ٠٩';
    const replacement = await createReplacementFixture(newText);
    const evidence = await collectPopplerEvidence(replacement.candidateBytes, 0);
    const extraction = evaluateExtraction(evidence.extraction, {
      pageIndex: 0,
      targetBounds: replacement.targetBounds,
      oldText: 'Target 01',
      newText,
      expectedOldTextOutsideTarget: 0,
    });

    expect(extraction.targetText).toBe(newText.replace(/\s+/gu, ''));
    expect(extraction.newTextPresentAtTarget).toBe(true);
  }, 15_000);

  test.each([
    '11-rotate-90',
    '13-rotate-270',
    '14-crop-nonzero-origin',
    '15-user-unit',
  ])('normalises Poppler bbox evidence into canonical coordinates for %s', async (id) => {
    const bytes = new Uint8Array(await readFile(`fixtures/generated/${id}.pdf`));
    const authoritative = (await analysePage(
      await ObjectStore.open(bytes, PROVISIONAL_LIMITS),
      0,
    )).spans[0]!;
    const poppler = await collectPopplerEvidence(bytes, 0);
    const extracted = poppler.extraction[0]!;

    expect(extracted.bounds.x).toBeCloseTo(authoritative.bounds.x, 6);
    expect(extracted.bounds.y).toBeCloseTo(authoritative.bounds.y, 6);
    expect(extracted.bounds.width).toBeCloseTo(authoritative.bounds.width, 6);
    expect(extracted.bounds.height).toBeCloseTo(authoritative.bounds.height, 6);
  }, 15_000);
});
