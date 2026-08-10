import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import { PdfEngineSessions } from '../src/engine';
import { PROVISIONAL_LIMITS } from '../src/limits';
import type { RuntimeValidationEvidence } from '../src/validation/pdfjs-validator';

const regularFontPath =
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff';
const boldFontPath =
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff';
const openSansBoldFontPath =
  'node_modules/@fontsource/open-sans/files/open-sans-latin-700-normal.woff';
const suiteOnePath = 'tests/1/document.pdf';

function validEvidence(): RuntimeValidationEvidence {
  return {
    consumer: 'pdfjs',
    valid: true,
    checks: ['candidate-valid'],
    extraction: {
      items: [],
      targetText: '',
      oldTextAbsentAtTarget: true,
      newTextPresentAtTarget: true,
      oldTextOutsideTargetCount: 0,
      outsideTextPreserved: true,
    },
    render: {
      dpi: 144,
      width: 1,
      height: 1,
      pageWidth: 1,
      pageHeight: 1,
      rgba: new Uint8Array(4),
    },
  };
}

describe('rich engine sessions', () => {
  test('registers additional bundled style faces before a document opens', async () => {
    const regularBytes = new Uint8Array(await readFile(regularFontPath));
    const boldBytes = new Uint8Array(await readFile(boldFontPath));
    const engine = new PdfEngineSessions({
      limits: PROVISIONAL_LIMITS,
      substituteFont: {
        bytes: regularBytes,
        family: 'Noto Sans',
        version: '5.3.0',
        licence: 'OFL-1.1',
        source: '@fontsource/noto-sans',
      },
      additionalBundledFonts: async () => [{
        fileName: 'NotoSans-Bold.woff',
        bytes: boldBytes,
      }],
      validator: async () => validEvidence(),
    });

    const opened = await engine.openDocument(
      new Uint8Array(await readFile('fixtures/generated/30-wkhtmltopdf-rich-line.pdf')),
    );

    expect(opened.fonts.map(({ inspection }) => inspection.weight).sort()).toEqual([400, 700]);
  });

  test('rejects a rich payload with invalid source-run provenance', async () => {
    const regularBytes = new Uint8Array(await readFile(regularFontPath));
    const engine = new PdfEngineSessions({
      limits: PROVISIONAL_LIMITS,
      substituteFont: {
        bytes: regularBytes,
        family: 'Noto Sans',
        version: '5.3.0',
        licence: 'OFL-1.1',
        source: '@fontsource/noto-sans',
      },
      validator: async () => validEvidence(),
    });
    const opened = await engine.openDocument(
      new Uint8Array(await readFile('fixtures/generated/30-wkhtmltopdf-rich-line.pdf')),
    );
    const analysed = await engine.analysePage(opened.documentId, 0, 0);
    const group = analysed.textLayout.groups.find(
      ({ text }) => text === 'this is a bold text',
    )!;
    const font = opened.fonts.find(({ inspection }) => inspection.weight === 400)!;
    const run = group.styleRuns[0]!;

    await expect(engine.previewRichReplacement(opened.documentId, 0, {
      selection: {
        lineKey: group.lineKey,
        anchorGlyphIndex: group.glyphRange.start,
        focusGlyphIndex: group.glyphRange.end - 1,
      },
      runs: [{
        text: run.text,
        style: run.style,
        fontId: font.id,
        fontIntent: 'preserve-source',
        decorations: run.decorations,
        sourceRunIndex: 99,
      }],
      allowedRegion: {
        ...group.bounds,
        width: group.bounds.width * 2,
        height: group.bounds.height * 3,
      },
      substitutionConsents: [],
    })).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });

  test('registers fonts and stages a source-backed rich candidate until validation', async () => {
    const regularBytes = new Uint8Array(await readFile(regularFontPath));
    const boldBytes = new Uint8Array(await readFile(boldFontPath));
    let validationArguments: readonly unknown[] = [];
    const engine = new PdfEngineSessions({
      limits: PROVISIONAL_LIMITS,
      substituteFont: {
        bytes: regularBytes,
        family: 'Noto Sans',
        version: '5.3.0',
        licence: 'OFL-1.1',
        source: '@fontsource/noto-sans',
      },
      validator: async (...args: readonly unknown[]) => {
        validationArguments = args;
        return validEvidence();
      },
    });
    const bold = await engine.registerFont({
      source: 'upload',
      fileName: 'NotoSans-Bold.woff',
      bytes: boldBytes,
    });
    const originalBytes = new Uint8Array(
      await readFile('fixtures/generated/30-wkhtmltopdf-rich-line.pdf'),
    );
    const opened = await engine.openDocument(originalBytes);
    const regular = opened.fonts.find(({ inspection }) => inspection.weight === 400)!;
    const analysed = await engine.analysePage(opened.documentId, 0, 0);
    const group = analysed.textLayout.groups.find(
      ({ text }) => text === 'this is a bold text',
    )!;
    const [normalStart, sourceBold, normalEnd] = group.styleRuns;
    await expect(engine.previewRichReplacement(
      opened.documentId,
      0,
      {
        selection: {
          lineKey: group.lineKey,
          anchorGlyphIndex: group.glyphRange.start,
          focusGlyphIndex: group.glyphRange.end - 1,
        },
        runs: [
          { text: normalStart!.text, style: normalStart!.style, fontId: regular.id, fontIntent: 'preserve-source' as const, decorations: normalStart!.decorations },
          { text: sourceBold!.text, style: sourceBold!.style, fontId: regular.id, fontIntent: 'preserve-source' as const, decorations: sourceBold!.decorations },
          { text: normalEnd!.text, style: normalEnd!.style, fontId: regular.id, fontIntent: 'preserve-source' as const, decorations: normalEnd!.decorations },
        ],
        allowedRegion: {
          x: group.bounds.x,
          y: group.bounds.y - group.bounds.height,
          width: group.bounds.width * 2,
          height: group.bounds.height * 3,
        },
        substitutionConsents: [regular.id],
      },
    )).rejects.toMatchObject({ code: 'FONT_UNAVAILABLE' });
    const payload = {
      selection: {
        lineKey: group.lineKey,
        anchorGlyphIndex: group.glyphRange.start,
        focusGlyphIndex: group.glyphRange.end - 1,
      },
      runs: [
        { text: normalStart!.text, style: normalStart!.style, fontId: regular.id, fontIntent: 'preserve-source' as const, decorations: normalStart!.decorations },
        { text: 'firm', style: sourceBold!.style, fontId: bold.id, fontIntent: 'preserve-source' as const, decorations: sourceBold!.decorations },
        { text: normalEnd!.text, style: normalEnd!.style, fontId: regular.id, fontIntent: 'preserve-source' as const, decorations: normalEnd!.decorations },
      ],
      allowedRegion: {
        x: group.bounds.x,
        y: group.bounds.y - group.bounds.height,
        width: group.bounds.width * 2,
        height: group.bounds.height * 3,
      },
      substitutionConsents: [regular.id, bold.id],
    };

    const unconsentedPreview = await engine.previewRichReplacement(
      opened.documentId,
      0,
      { ...payload, substitutionConsents: [] },
    );
    expect(unconsentedPreview).toMatchObject({
      fits: true,
      replacementBounds: {
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      },
      requiredSubstitutionConsents: expect.arrayContaining([regular.id, bold.id]),
      fontMatches: expect.arrayContaining([
        { fontId: regular.id, matchKind: 'substitute' },
        { fontId: bold.id, matchKind: 'substitute' },
      ]),
    });

    const preview = await engine.previewRichReplacement(
      opened.documentId,
      0,
      payload,
    );
    expect(preview).toMatchObject({
      fits: true,
      requiredSubstitutionConsents: [],
    });
    const applied = await engine.applyRichReplacement(
      opened.documentId,
      0,
      payload,
      preview.preconditions,
    );

    expect(applied).toMatchObject({ revision: 1, candidateId: expect.any(String) });
    expect((await engine.analysePage(opened.documentId, 0, 0)).textLayout.groups).toContainEqual(
      expect.objectContaining({ text: 'this is a bold text' }),
    );
    const checked = await engine.validateCandidate(
      opened.documentId,
      0,
      applied.candidateId,
    );
    expect(checked).toMatchObject({ valid: true, revision: 1 });
    expect(validationArguments).toHaveLength(3);
    const [validatedSource, validatedCandidate, validationExpectation] = validationArguments as [
      Uint8Array,
      Uint8Array,
      Readonly<{
        authorisedBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
        structure: Readonly<{
          commandHash: string;
          fontResourceNames: readonly string[];
          mutatedSourceStreams: readonly unknown[];
        }>;
      }>,
    ];
    expect(validatedSource).toEqual(originalBytes);
    expect(validatedCandidate).not.toEqual(originalBytes);
    expect(validationExpectation.authorisedBounds).toEqual(payload.allowedRegion);
    expect(validationExpectation.structure).toMatchObject({
      commandHash: preview.commandHash,
      fontResourceNames: applied.fontResourceNames,
    });
    expect(validationExpectation.structure.mutatedSourceStreams).not.toHaveLength(0);
    const updated = await engine.analysePage(opened.documentId, 1, 0);
    expect(updated.textLayout.groups).toContainEqual(
      expect.objectContaining({ text: 'this is a firm text' }),
    );
  }, 30_000);

  test('uses the explicitly uploaded Open Sans Bold face for the controlled Suite 1 status after reopen', async () => {
    const regularBytes = new Uint8Array(await readFile(regularFontPath));
    const uploadedBytes = new Uint8Array(await readFile(openSansBoldFontPath));
    const makeEngine = () => new PdfEngineSessions({
      limits: PROVISIONAL_LIMITS,
      substituteFont: {
        bytes: regularBytes,
        family: 'Noto Sans',
        version: '5.3.0',
        licence: 'OFL-1.1',
        source: '@fontsource/noto-sans',
      },
      validator: async () => validEvidence(),
    });
    const engine = makeEngine();
    const uploaded = await engine.registerFont({
      source: 'upload',
      fileName: 'OpenSans-Bold.woff',
      bytes: uploadedBytes,
    });
    const opened = await engine.openDocument(
      new Uint8Array(await readFile(suiteOnePath)),
    );
    const analysed = await engine.analysePage(opened.documentId, 0, 0);
    const group = analysed.textLayout.groups.find(
      ({ text }) => text === 'Approval status: Pending',
    )!;
    const [sourceRun] = group.styleRuns;
    const payload = {
      selection: {
        lineKey: group.lineKey,
        anchorGlyphIndex: group.glyphRange.start,
        focusGlyphIndex: group.glyphRange.end - 1,
      },
      runs: [
        { text: 'Approval status: Approved', style: sourceRun!.style, fontId: uploaded.id, fontIntent: 'explicit-choice' as const, decorations: sourceRun!.decorations },
      ],
      allowedRegion: {
        x: group.bounds.x,
        y: group.bounds.y - group.bounds.height,
        width: group.bounds.width * 2,
        height: group.bounds.height * 3,
      },
      substitutionConsents: [],
    };

    const preview = await engine.previewRichReplacement(opened.documentId, 0, payload);
    expect(preview.fontMatches).toContainEqual({
      fontId: uploaded.id,
      matchKind: 'exact',
    });
    const applied = await engine.applyRichReplacement(
      opened.documentId,
      0,
      payload,
      preview.preconditions,
    );
    const validated = await engine.validateCandidate(
      opened.documentId,
      0,
      applied.candidateId,
    );
    expect(validated.valid).toBe(true);
    const exported = new Uint8Array(engine.exportDocument(
      opened.documentId,
      validated.revision,
      validated.candidateHash,
    ));

    const reopenedEngine = makeEngine();
    const reopened = await reopenedEngine.openDocument(exported);
    const reopenedAnalysis = await reopenedEngine.analysePage(reopened.documentId, 0, 0);
    const updated = reopenedAnalysis.textLayout.groups.find(
      ({ text }) => text === 'Approval status: Approved',
    );
    expect(updated).toBeDefined();
    expect(updated!.styleRuns[0]).toMatchObject({
      text: 'Approval status: Approved',
      style: {
        fontResourceName: applied.fontResourceNames[0],
        fontBaseName: expect.stringMatching(/OpenSans-Bold|Open Sans Bold/i),
        fontWeight: 700,
      },
    });
    expect(applied.fontResourceNames[0]).toBe(
      `M0R_${preview.commandHash.slice(0, 16)}_0`,
    );
  }, 30_000);
});
