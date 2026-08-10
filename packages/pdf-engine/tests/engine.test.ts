import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import type { RuntimeValidationEvidence } from '../src/validation/pdfjs-validator';
import { PdfEngineSessions } from '../src/engine';
import { PROVISIONAL_LIMITS } from '../src/limits';
import { spanAddressKey } from '../src/model';
import { ObjectStore } from '../src/pdf/object-store';

const fontPath =
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff';

function validation(valid: boolean): RuntimeValidationEvidence {
  return Object.freeze({
    consumer: 'pdfjs',
    valid,
    checks: Object.freeze(valid ? ['old-text-absent', 'new-text-present'] : ['old-text-present']),
    extraction: Object.freeze({
      items: Object.freeze([]),
      targetText: '',
      oldTextAbsentAtTarget: valid,
      newTextPresentAtTarget: valid,
      oldTextOutsideTargetCount: 0,
      outsideTextPreserved: true,
    }),
    render: Object.freeze({
      dpi: 144,
      width: 1,
      height: 1,
      pageWidth: 1,
      pageHeight: 1,
      rgba: new Uint8Array(4),
    }),
  });
}

async function createEngine(valid = true): Promise<PdfEngineSessions> {
  const fontBytes = new Uint8Array(await readFile(fontPath));
  return new PdfEngineSessions({
    limits: PROVISIONAL_LIMITS,
    substituteFont: Object.freeze({
      bytes: fontBytes,
      family: 'Noto Sans',
      version: '5.3.0',
      licence: 'OFL-1.1',
      source: '@fontsource/noto-sans',
    }),
    validator: async () => validation(valid),
  });
}

describe('revisioned PDF engine sessions', () => {
  test('inspects fonts only for the matching document revision', async () => {
    const engine = await createEngine();
    const original = new Uint8Array(await readFile('fixtures/generated/01-simple-tj.pdf'));
    const opened = await engine.openDocument(original);

    await expect(engine.inspectDocumentFonts(opened.documentId, 0)).resolves.toEqual([
      { name: 'Helvetica', reason: 'standard-font' },
    ]);
    await expect(engine.inspectDocumentFonts(opened.documentId, 1)).rejects.toMatchObject({
      code: 'STALE_REVISION',
    });
  });

  test('commits a candidate atomically and exports it once after matching validation', async () => {
    const engine = await createEngine();
    const original = new Uint8Array(await readFile('fixtures/generated/01-simple-tj.pdf'));
    const originalCopy = original.slice();
    const opened = await engine.openDocument(original);
    const page = await engine.analysePage(opened.documentId, 0, 0);
    const span = page.spans.find(({ unicode }) => unicode === 'Target 01')!;
    const spanKey = spanAddressKey(span.address);
    const preview = await engine.previewReplacement(
      opened.documentId,
      0,
      spanKey,
      'Edited 01',
      true,
    );

    const applied = await engine.applyReplacement(
      opened.documentId,
      0,
      spanKey,
      'Edited 01',
      true,
      preview.preconditions,
    );
    expect(applied).toMatchObject({ revision: 1, candidateId: expect.any(String) });
    expect('candidateBytes' in applied).toBe(false);
    expect(original).toEqual(originalCopy);
    expect((await engine.analysePage(opened.documentId, 0, 0)).spans).not.toHaveLength(0);

    const checked = await engine.validateCandidate(
      opened.documentId,
      0,
      applied.candidateId,
    );
    expect(checked.valid).toBe(true);
    expect(checked.candidateHash).toBe(applied.candidateHash);
    expect(checked.revision).toBe(1);
    const exported = await engine.exportDocument(
      opened.documentId,
      1,
      checked.candidateHash,
    );
    expect(exported.byteLength).toBeGreaterThan(original.byteLength);
    expect(() =>
      engine.exportDocument(opened.documentId, 1, checked.candidateHash),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILURE' }));
  }, 15_000);

  test('does not advance revision or expose bytes when validation fails', async () => {
    const engine = await createEngine(false);
    const original = new Uint8Array(await readFile('fixtures/generated/01-simple-tj.pdf'));
    const opened = await engine.openDocument(original);
    const span = (await engine.analysePage(opened.documentId, 0, 0)).spans[0]!;
    const spanKey = spanAddressKey(span.address);
    const preview = await engine.previewReplacement(
      opened.documentId,
      0,
      spanKey,
      'Edited 01',
      true,
    );
    const applied = await engine.applyReplacement(
      opened.documentId,
      0,
      spanKey,
      'Edited 01',
      true,
      preview.preconditions,
    );

    const checked = await engine.validateCandidate(
      opened.documentId,
      0,
      applied.candidateId,
    );
    expect(checked).toMatchObject({ valid: false, revision: 0 });
    expect(() =>
      engine.exportDocument(opened.documentId, 0, applied.candidateHash),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILURE' }));
    expect((await engine.analysePage(opened.documentId, 0, 0)).spans).not.toHaveLength(0);
  }, 15_000);

  test('does not count other unmapped spans as extractable old text outside the target', async () => {
    const fixture = new Uint8Array(
      await readFile('fixtures/generated/20-missing-tounicode.pdf'),
    );
    const sourceStore = await ObjectStore.open(fixture, PROVISIONAL_LIMITS);
    const sourceStream = sourceStore.listPageStreams(0).find(({ path }) => path.length === 1)!;
    const translated = new Uint8Array(
      new TextEncoder().encode(`q\n1 0 0 1 200 -200 cm\n${new TextDecoder().decode(sourceStream.decodedBytes)}\nQ\n`),
    );
    await sourceStore.appendPageContentStream(0, translated);
    const sourceBytes = await sourceStore.serialiseCandidate();
    let expectation: Readonly<{
      oldText: string;
      expectedOldTextOutsideTarget: number;
    }> | undefined;
    const fontBytes = new Uint8Array(await readFile(fontPath));
    const engine = new PdfEngineSessions({
      limits: PROVISIONAL_LIMITS,
      substituteFont: {
        bytes: fontBytes,
        family: 'Noto Sans',
        version: '5.3.0',
        licence: 'OFL-1.1',
        source: '@fontsource/noto-sans',
      },
      validator: async (_source, _candidate, supplied) => {
        expectation = supplied;
        return validation(true);
      },
    });
    const opened = await engine.openDocument(sourceBytes);
    const page = await engine.analysePage(opened.documentId, 0, 0);
    const unmapped = page.spans.filter(({ unicode }) => unicode === null);
    expect(unmapped).toHaveLength(2);
    const span = unmapped[0]!;
    const spanKey = spanAddressKey(span.address);
    const preview = await engine.previewReplacement(
      opened.documentId,
      0,
      spanKey,
      'Edited 20',
      true,
    );
    const applied = await engine.applyReplacement(
      opened.documentId,
      0,
      spanKey,
      'Edited 20',
      true,
      preview.preconditions,
    );
    await engine.validateCandidate(opened.documentId, 0, applied.candidateId);

    expect(expectation?.oldText).toMatch(/^source:/);
    expect(expectation?.expectedOldTextOutsideTarget).toBe(0);
  }, 20_000);

  test('rejects stale and read-only shared-Form mutations without changing revision', async () => {
    const engine = await createEngine();
    const shared = new Uint8Array(await readFile('fixtures/generated/18-shared-form-xobject.pdf'));
    const opened = await engine.openDocument(shared);
    const span = (await engine.analysePage(opened.documentId, 0, 0)).spans[0]!;
    const spanKey = spanAddressKey(span.address);
    const preview = await engine.previewReplacement(
      opened.documentId,
      0,
      spanKey,
      'Edited 17',
      true,
    );
    expect(preview.capability.kind).toBe('readOnly');
    await expect(
      engine.applyReplacement(opened.documentId, 1, spanKey, 'Edited 17', true, preview.preconditions),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      engine.applyReplacement(opened.documentId, 0, spanKey, 'Edited 17', true, preview.preconditions),
    ).rejects.toMatchObject({ code: 'READ_ONLY_SPAN' });
    expect((await engine.analysePage(opened.documentId, 0, 0)).spans).not.toHaveLength(0);
  }, 15_000);

  test('binds substitution consent and normalised text to preview preconditions', async () => {
    const engine = await createEngine();
    const original = new Uint8Array(await readFile('fixtures/generated/06-subset-font.pdf'));
    const opened = await engine.openDocument(original);
    const span = (await engine.analysePage(opened.documentId, 0, 0)).spans[0]!;
    const spanKey = spanAddressKey(span.address);

    const denied = await engine.previewReplacement(
      opened.documentId,
      0,
      spanKey,
      'Cafe\u0301',
      false,
    );
    expect(denied).toMatchObject({
      normalisedReplacement: 'Café',
      canApply: false,
      substitutionAccepted: false,
    });
    await expect(
      engine.applyReplacement(
        opened.documentId,
        0,
        spanKey,
        'Cafe\u0301',
        false,
        denied.preconditions,
      ),
    ).rejects.toMatchObject({ code: 'READ_ONLY_SPAN' });

    const accepted = await engine.previewReplacement(
      opened.documentId,
      0,
      spanKey,
      'Cafe\u0301',
      true,
    );
    expect(accepted.preconditions).toMatchObject({
      expectedNormalisedReplacement: 'Café',
      expectedSubstitutionAccepted: true,
    });
    await expect(
      engine.applyReplacement(
        opened.documentId,
        0,
        spanKey,
        'Different',
        true,
        accepted.preconditions,
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      engine.applyReplacement(
        opened.documentId,
        0,
        spanKey,
        'Cafe\u0301',
        false,
        accepted.preconditions,
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
  }, 15_000);

  test('validates and exports each of two revisions exactly once', async () => {
    const engine = await createEngine();
    const original = new Uint8Array(await readFile('fixtures/generated/01-simple-tj.pdf'));
    const opened = await engine.openDocument(original);
    let revision = 0;

    for (const [expectedCurrentText, replacement] of [
      ['Target 01', 'Edited 01'],
      ['Edited 01', 'Edited 02'],
    ] as const) {
      const page = await engine.analysePage(opened.documentId, revision, 0);
      const matching = page.spans.filter(({ unicode }) => unicode === expectedCurrentText);
      expect(matching).toHaveLength(1);
      const span = matching[0]!;
      const spanKey = spanAddressKey(span.address);
      const preview = await engine.previewReplacement(
        opened.documentId,
        revision,
        spanKey,
        replacement,
        true,
      );
      const applied = await engine.applyReplacement(
        opened.documentId,
        revision,
        spanKey,
        replacement,
        true,
        preview.preconditions,
      );
      const checked = await engine.validateCandidate(
        opened.documentId,
        revision,
        applied.candidateId,
      );
      expect(checked.valid).toBe(true);
      revision = checked.revision;
      expect(
        engine.exportDocument(opened.documentId, revision, checked.candidateHash).byteLength,
      ).toBeGreaterThan(0);
      expect(() =>
        engine.exportDocument(opened.documentId, revision, checked.candidateHash),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILURE' }));
    }

    expect(revision).toBe(2);
  }, 30_000);
});
