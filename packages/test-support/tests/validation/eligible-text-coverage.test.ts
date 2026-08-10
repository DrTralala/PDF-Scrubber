import { readFile } from 'node:fs/promises';

import { createCanvas } from '@napi-rs/canvas';
import {
  PdfEngineSessions,
  PROVISIONAL_LIMITS,
  validateCandidateAgainstSource,
  type ValidationCanvasFactory,
} from '@pdf-editor/pdf-engine';
import { describe, expect, test } from 'vitest';

import {
  CORPUS,
  evaluateEligibleTextCoverage,
} from '../../src/index';

const FIXTURE_PATH = 'fixtures/generated/30-wkhtmltopdf-rich-line.pdf';
const REGULAR_FONT_PATH =
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff';
const BOLD_FONT_PATH =
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff';

const nodeCanvasFactory: ValidationCanvasFactory = (width, height) => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  return {
    canvas,
    context,
    readRgba: () => new Uint8Array(context.getImageData(0, 0, width, height).data),
  };
};

describe('wkhtmltopdf eligible-text coverage', () => {
  test('accounts for every eligible glyph once and validates every inferred group edit', async () => {
    const corpusCase = CORPUS.find(({ id }) => id === '30-wkhtmltopdf-rich-line');
    const expectation = corpusCase?.eligibleText;
    if (corpusCase === undefined || expectation === undefined) {
      throw new Error('The rich-line fixture must publish eligible-text expectations');
    }
    const [sourceBytes, regularBytes, boldBytes] = await Promise.all([
      readFile(FIXTURE_PATH).then((bytes) => new Uint8Array(bytes)),
      readFile(REGULAR_FONT_PATH).then((bytes) => new Uint8Array(bytes)),
      readFile(BOLD_FONT_PATH).then((bytes) => new Uint8Array(bytes)),
    ]);
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
      validator: (source, candidate, mutationExpectation) =>
        validateCandidateAgainstSource(
          source,
          candidate,
          mutationExpectation,
          nodeCanvasFactory,
        ),
    });

    for (const expectedGroup of expectation.groups) {
      const opened = await engine.openDocument(sourceBytes);
      const analysis = await engine.analysePage(opened.documentId, 0, 0);
      const coverage = evaluateEligibleTextCoverage(analysis, expectation);
      const group = analysis.textLayout.groups.find(({ text }) => text === expectedGroup.text);
      if (group === undefined) throw new Error(`Missing expected group: ${expectedGroup.text}`);
      const line = analysis.textLayout.lines.find(({ key }) => key === group.lineKey);
      if (line === undefined) throw new Error(`Missing line for group: ${expectedGroup.text}`);
      const runs = group.styleRuns.map((sourceRun, index) => {
        const font = opened.fonts.find(({ inspection }) =>
          inspection.weight === (sourceRun.style.fontWeight ?? 400) &&
          inspection.italic === ((sourceRun.style.italicAngle ?? 0) !== 0));
        if (font === undefined) {
          throw new Error(`Missing bundled style face for group: ${expectedGroup.text}`);
        }
        return Object.freeze({
          text: expectedGroup.replacementRuns[index]!,
          style: sourceRun.style,
          fontId: font.id,
          fontIntent: 'preserve-source' as const,
          decorations: sourceRun.decorations,
        });
      });
      const payload = Object.freeze({
        selection: Object.freeze({
          lineKey: line.key,
          anchorGlyphIndex: group.glyphRange.start,
          focusGlyphIndex: group.glyphRange.end - 1,
        }),
        runs: Object.freeze(runs),
        allowedRegion: Object.freeze({
          x: group.bounds.x,
          y: group.bounds.y - group.bounds.height,
          width: group.bounds.width,
          height: group.bounds.height * 3,
        }),
        substitutionConsents: Object.freeze([...new Set(runs.map(({ fontId }) => fontId))]),
      });
      const preview = await engine.previewRichReplacement(opened.documentId, 0, payload);
      expect(preview.fits, `${expectedGroup.text}: ${JSON.stringify({
        replacementBounds: preview.replacementBounds,
        allowedRegion: preview.allowedRegion,
      })}`).toBe(true);
      const applied = await engine.applyRichReplacement(
        opened.documentId,
        0,
        payload,
        preview.preconditions,
      );
      const validation = await engine.validateCandidate(
        opened.documentId,
        0,
        applied.candidateId,
      );
      const updated = await engine.analysePage(opened.documentId, 1, 0);
      const replacementText = expectedGroup.replacementRuns.join('');
      const exported = engine.exportDocument(
        opened.documentId,
        1,
        validation.candidateHash,
      );

      expect(coverage).toMatchObject({ valid: true, duplicateSourceGlyphKeys: [] });
      expect(preview).toMatchObject({ fits: true, requiredSubstitutionConsents: [] });
      expect(validation).toMatchObject({ valid: true, revision: 1 });
      expect(validation.checks).toEqual(expect.arrayContaining([
        'outside-text-identical',
        'outside-pixels-preserved',
        'source-streams-preserved',
        'font-resources-present',
      ]));
      expect(updated.textLayout.groups).toContainEqual(
        expect.objectContaining({ text: replacementText }),
      );
      expect(exported.byteLength).toBeGreaterThan(0);
      engine.closeDocument(opened.documentId, 1);
    }
  }, 60_000);
});
