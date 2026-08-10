import {
  ENGINE_ERROR_CODES,
  type DocumentEditingFont,
  type FontDescriptor,
  type HalfOpenRange,
} from '@pdf-editor/pdf-engine';
import type { AnalysePageResult } from '@pdf-editor/worker-protocol';
import { describe, expect, it, vi } from 'vitest';

import { ValidationRejectedError } from '../engine/product-engine-client';
import { WorkerClientError } from '../engine/worker-client';
import { editorError } from '../model/editor-state';
import {
  analysisFixture,
  createControllerHarness,
  deferred,
  FakeDisplayDocument,
  fakeFontDescriptor,
  pdfFile,
  richPreviewResult,
  textLineAnalysisFixture,
  validatedResult,
} from '../test/fakes';
import type { EditorController } from './editor-controller';

function applicationTarget(
  controller: EditorController,
  range: HalfOpenRange,
) {
  const snapshot = controller.getSnapshot();
  if (snapshot.selection?.kind !== 'text') throw new Error('Expected a text selection');
  return Object.freeze({
    generation: snapshot.generation,
    pageIndex: snapshot.pageIndex,
    selectionKey: snapshot.selection.textSelection.key,
    range,
  });
}

function applicationFont(
  inspection: Partial<FontDescriptor['inspection']> = {},
): FontDescriptor {
  const base = fakeFontDescriptor('upload', 'Selected.ttf', '4-5-6');
  return Object.freeze({
    ...base,
    inspection: Object.freeze({
      ...base.inspection,
      weight: 700,
      italic: true,
      italicAngle: -10,
      codePoints: Object.freeze([65, 66, 67]),
      ...inspection,
    }),
  });
}

async function prepareReplacement(
  controller: EditorController,
  text: string,
): Promise<void> {
  controller.selectSpan('span-1');
  controller.setReplacement(text);
  controller.setAcceptSubstitution(true);
  await controller.previewSelection();
}

describe('EditorController', () => {
  it('opens independent engine/display copies and analyses page zero', async () => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });
    const source = Uint8Array.of(1, 2, 3);

    await h.controller.open(pdfFile('report.pdf', source));

    expect(h.engines[0]!.openInputs[0]).toEqual(source);
    expect(h.displayInputs[0]).toEqual(source);
    expect(h.engines[0]!.openInputs[0]!.buffer).not.toBe(h.displayInputs[0]!.buffer);
    expect(h.engines[0]!.analyseCalls).toEqual([0]);
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      pageIndex: 0,
      pageCount: 1,
      downloadAvailable: false,
    });
  });

  it('makes page zero usable while document font inspection is pending', async () => {
    const inventory = deferred<readonly DocumentEditingFont[]>();
    const h = createControllerHarness({
      analyses: [analysisFixture()],
      fontInventoryResults: [inventory.promise],
    });

    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      fontInventoryState: 'scanning',
      editingFonts: [],
    });
    expect(h.engines[0]!.fontInventoryCalls).toBe(1);

    inventory.resolve([{ name: 'DejaVuSans', reason: 'not-embedded' }]);
    await vi.waitFor(() => expect(h.controller.getSnapshot()).toMatchObject({
      fontInventoryState: 'ready',
      editingFonts: [{ name: 'DejaVuSans', reason: 'not-embedded' }],
    }));
  });

  it('contains font inspection failure without disabling the document', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture()],
      fontInventoryResults: [new Error('private parser detail')],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await vi.waitFor(() => expect(h.controller.getSnapshot().fontInventoryState).toBe('failed'));

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      error: null,
      editingFonts: [],
    });
    expect(h.controller.getSnapshot().status).toBe('Ready');
  });

  it('ignores a font inventory result from an older document generation', async () => {
    const stale = deferred<readonly DocumentEditingFont[]>();
    const h = createControllerHarness({
      analyses: [analysisFixture('Document A'), analysisFixture('Document B')],
      fontInventoryResults: [
        stale.promise,
        [{ name: 'Current Font', reason: 'embedded-not-reusable' }],
      ],
    });
    await h.controller.open(pdfFile('a.pdf', Uint8Array.of(1)));
    await h.controller.open(pdfFile('b.pdf', Uint8Array.of(2)));
    await vi.waitFor(() => expect(h.controller.getSnapshot().editingFonts).toEqual([
      { name: 'Current Font', reason: 'embedded-not-reusable' },
    ]));

    stale.resolve([{ name: 'Stale Font', reason: 'standard-font' }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.controller.getSnapshot().editingFonts).toEqual([{
      name: 'Current Font',
      reason: 'embedded-not-reusable',
    }]);
  });

  it('ignores a font inventory failure from an older document generation', async () => {
    const stale = deferred<readonly DocumentEditingFont[]>();
    const h = createControllerHarness({
      analyses: [analysisFixture('Document A'), analysisFixture('Document B')],
      fontInventoryResults: [
        stale.promise,
        [{ name: 'Current Font', reason: 'embedded-not-reusable' }],
      ],
    });
    await h.controller.open(pdfFile('a.pdf', Uint8Array.of(1)));
    await h.controller.open(pdfFile('b.pdf', Uint8Array.of(2)));
    await vi.waitFor(() => expect(h.controller.getSnapshot().editingFonts).toEqual([
      { name: 'Current Font', reason: 'embedded-not-reusable' },
    ]));

    stale.reject(new Error('stale private parser detail'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      error: null,
      status: 'Ready',
      editingFonts: [{ name: 'Current Font', reason: 'embedded-not-reusable' }],
    });
  });

  it('clears old inventory before waiting for the previous display to be destroyed', async () => {
    const destroy = deferred<void>();
    const destroySpy = vi.spyOn(FakeDisplayDocument.prototype, 'destroy')
      .mockImplementation(() => destroy.promise);
    const h = createControllerHarness({
      analyses: [analysisFixture('Document A'), analysisFixture('Document B')],
      fontInventoryResults: [
        [{ name: 'Old Font', reason: 'standard-font' }],
        [{ name: 'Current Font', reason: 'embedded-not-reusable' }],
      ],
    });

    try {
      await h.controller.open(pdfFile('a.pdf', Uint8Array.of(1)));
      await vi.waitFor(() => expect(h.controller.getSnapshot().editingFonts).toEqual([
        { name: 'Old Font', reason: 'standard-font' },
      ]));

      const opening = h.controller.open(pdfFile('b.pdf', Uint8Array.of(2)));
      try {
        expect(h.controller.getSnapshot()).toMatchObject({
          phase: 'opening',
          fileName: null,
          fontInventoryState: 'scanning',
          editingFonts: [],
        });
      } finally {
        destroy.resolve();
        await opening;
      }

      await vi.waitFor(() => expect(h.controller.getSnapshot().editingFonts).toEqual([
        { name: 'Current Font', reason: 'embedded-not-reusable' },
      ]));
    } finally {
      destroy.resolve();
      destroySpy.mockRestore();
    }
  });

  it('normalises a reverse source-backed text range from the analysed line', async () => {
    const h = createControllerHarness({ analyses: [textLineAnalysisFixture('ABC')] });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));

    h.controller.selectTextRange('line-1', 2, 0, null);

    expect(h.controller.getSnapshot()).toMatchObject({
      selection: {
        kind: 'text',
        groupKey: null,
        textSelection: {
          lineKey: 'line-1',
          glyphRange: { start: 0, end: 3 },
          text: 'ABC',
        },
      },
      replacement: 'ABC',
      status: 'Custom text selected',
    });
  });

  it('previews and atomically applies rich text with explicit substitution consent', async () => {
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC'), textLineAnalysisFixture('AXC')],
      applyResults: [validatedResult(1, Uint8Array.of(2))],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');

    h.controller.replaceRichText({ start: 1, end: 2 }, 'X');
    await h.controller.previewSelection();

    const first = h.controller.getSnapshot().richEditor!;
    expect(first.runs.map(({ text }) => text).join('')).toBe('AXC');
    expect(first.preview).toMatchObject({
      fits: true,
      requiredSubstitutionConsents: ['font:bundled-example'],
    });
    expect(h.engines[0]!.richPreviewInputs[0]).toMatchObject({
      selection: { lineKey: 'line-1', anchorGlyphIndex: 0, focusGlyphIndex: 2 },
      runs: [{ text: 'AXC', fontId: 'font:bundled-example' }],
    });

    h.controller.setRichSubstitutionConsent('font:bundled-example', true);
    await h.controller.previewSelection();
    await h.controller.applySelection();

    expect(h.engines[0]!.richApplyInputs).toHaveLength(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      hasEdits: true,
      downloadAvailable: true,
      status: 'Replacement applied',
    });
  });

  it('returns to ready and ignores a stale rich-preview success after text changes', async () => {
    const pending = deferred<ReturnType<typeof richPreviewResult>>();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC')],
      richPreviewResults: [pending.promise],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');

    const request = h.controller.previewSelection();
    expect(h.controller.getSnapshot().phase).toBe('previewing');
    h.controller.replaceRichText({ start: 1, end: 2 }, 'X');
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      replacement: 'AXC',
      richEditor: { preview: null },
    });

    pending.resolve(richPreviewResult('ABC'));
    await request;
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      replacement: 'AXC',
      richEditor: { preview: null },
    });
  });

  it('ignores a stale rich-preview rejection after text changes', async () => {
    const pending = deferred<ReturnType<typeof richPreviewResult>>();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC')],
      richPreviewResults: [pending.promise],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');

    const request = h.controller.previewSelection();
    h.controller.replaceRichText({ start: 1, end: 2 }, 'X');
    pending.reject(new Error('stale shaping failure'));
    await request;

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      replacement: 'AXC',
      error: null,
      richEditor: { preview: null },
    });
  });

  it('uses one waiting state when rich-preview inputs change', async () => {
    const h = createControllerHarness({ analyses: [textLineAnalysisFixture('ABC')] });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');

    h.controller.formatRichText({ start: 0, end: 1 }, { style: { fontSize: 13 } });
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      status: 'Waiting to shape the latest text…',
      richEditor: { preview: null },
    });

    h.controller.setRichAllowedWidth(90);
    expect(h.controller.getSnapshot().status).toBe('Waiting to shape the latest text…');
    h.controller.setRichSubstitutionConsent('font:bundled-example', true);
    expect(h.controller.getSnapshot().status).toBe('Waiting to shape the latest text…');
    await h.controller.registerFont('upload', 'face.ttf', Uint8Array.of(1, 2, 3));
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      status: 'Waiting to shape the latest text…',
      richEditor: { preview: null },
    });
  });

  it('registers then explicitly applies inspected font metadata to the captured range', async () => {
    const descriptor = applicationFont();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC')],
      fontRegistrationResults: [descriptor],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');
    const target = applicationTarget(h.controller, { start: 1, end: 2 });
    const bytes = Uint8Array.of(4, 5, 6);

    const result = await h.controller.registerAndApplyFont(
      'upload',
      'Selected.ttf',
      bytes,
      target,
    );
    bytes[0] = 9;

    expect(result).toEqual({ descriptor, outcome: 'applied' });
    expect(h.engines[0]!.fontRegistrations).toEqual([{
      source: 'upload',
      fileName: 'Selected.ttf',
      bytes: Uint8Array.of(4, 5, 6),
    }]);
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      status: 'Waiting to shape the latest text…',
      richEditor: {
        preview: null,
        runs: [
          { text: 'A', fontIntent: 'preserve-source' },
          {
            text: 'B',
            fontId: descriptor.id,
            fontIntent: 'explicit-choice',
            style: { fontWeight: 700, italicAngle: -10 },
          },
          { text: 'C', fontIntent: 'preserve-source' },
        ],
      },
    });
  });

  it('retains registration but skips application after the source selection changes', async () => {
    const descriptor = applicationFont();
    const pending = deferred<FontDescriptor>();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC')],
      fontRegistrationResults: [pending.promise],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');
    const target = applicationTarget(h.controller, { start: 0, end: 3 });

    const applying = h.controller.registerAndApplyFont(
      'upload',
      'Selected.ttf',
      Uint8Array.of(4, 5, 6),
      target,
    );
    h.controller.selectTextRange('line-1', 0, 0, null);
    pending.resolve(descriptor);

    await expect(applying).resolves.toEqual({ descriptor, outcome: 'stale-selection' });
    expect(h.controller.listSessionFonts()).toEqual([descriptor]);
    expect(h.controller.getSnapshot().richEditor?.runs).not.toContainEqual(
      expect.objectContaining({ fontIntent: 'explicit-choice' }),
    );
  });

  it('retains registration but skips application after the document generation changes', async () => {
    const descriptor = applicationFont();
    const pending = deferred<FontDescriptor>();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC'), textLineAnalysisFixture('XYZ')],
      fontRegistrationResults: [pending.promise],
    });
    await h.controller.open(pdfFile('first.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');
    const target = applicationTarget(h.controller, { start: 0, end: 3 });

    const applying = h.controller.registerAndApplyFont(
      'local',
      'Selected.ttf',
      Uint8Array.of(4, 5, 6),
      target,
    );
    await h.controller.open(pdfFile('second.pdf', Uint8Array.of(2)));
    pending.resolve(descriptor);

    await expect(applying).resolves.toEqual({ descriptor, outcome: 'stale-selection' });
    expect(h.controller.getSnapshot()).toMatchObject({ fileName: 'second.pdf', selection: null });
    expect(h.controller.listSessionFonts()).toEqual([descriptor]);
  });

  it('registers but does not apply a face missing coverage for the captured text', async () => {
    const descriptor = applicationFont({ codePoints: Object.freeze([65, 67]) });
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC')],
      fontRegistrationResults: [descriptor],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');

    const result = await h.controller.registerAndApplyFont(
      'upload',
      'Selected.ttf',
      Uint8Array.of(4, 5, 6),
      applicationTarget(h.controller, { start: 1, end: 2 }),
    );

    expect(result).toEqual({ descriptor, outcome: 'missing-coverage' });
    expect(h.controller.listSessionFonts()).toEqual([descriptor]);
    expect(h.controller.getSnapshot().richEditor?.runs).not.toContainEqual(
      expect.objectContaining({ fontIntent: 'explicit-choice' }),
    );
  });

  it('treats an invalid captured editor range as stale instead of formatting another range', async () => {
    const descriptor = applicationFont();
    const h = createControllerHarness({
      analyses: [textLineAnalysisFixture('ABC')],
      fontRegistrationResults: [descriptor],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    h.controller.selectTextRange('line-1', 0, 2, 'group-1');

    const result = await h.controller.registerAndApplyFont(
      'upload',
      'Selected.ttf',
      Uint8Array.of(4, 5, 6),
      applicationTarget(h.controller, { start: 1, end: 20 }),
    );

    expect(result).toEqual({ descriptor, outcome: 'stale-selection' });
  });

  it('waits for authoritative engine acceptance before opening the display parser', async () => {
    const h = createControllerHarness({
      openResults: [new WorkerClientError({
        code: 'UNSUPPORTED_DOCUMENT',
        message: 'Untrusted worker detail',
      })],
    });

    await h.controller.open(pdfFile('encrypted.pdf', Uint8Array.of(1)));

    expect(h.displayInputs).toHaveLength(0);
    expect(h.controller.getSnapshot().error).toMatchObject({
      code: 'UNSUPPORTED_DOCUMENT',
      message: 'This release cannot open encrypted or unsupported PDFs.',
    });
  });

  it('invalidates preview whenever text or consent changes', async () => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await prepareReplacement(h.controller, 'Edited');
    expect(h.controller.getSnapshot().preview).not.toBeNull();

    h.controller.setReplacement('Changed');
    expect(h.controller.getSnapshot().preview).toBeNull();
    await h.controller.previewSelection();
    h.controller.setAcceptSubstitution(false);
    expect(h.controller.getSnapshot().preview).toBeNull();
  });

  it('commits two successively validated byte snapshots', async () => {
    const h = createControllerHarness({
      analyses: [
        analysisFixture(),
        analysisFixture('Edited 01'),
        analysisFixture('Edited 02'),
      ],
      applyResults: [
        validatedResult(1, Uint8Array.of(2)),
        validatedResult(2, Uint8Array.of(3)),
      ],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));

    await prepareReplacement(h.controller, 'Edited 01');
    await h.controller.applySelection();
    await prepareReplacement(h.controller, 'Edited 02');
    await h.controller.applySelection();

    expect(h.engines).toHaveLength(1);
    expect(h.engines[0]!.applyRevisions).toEqual([0, 1]);
    expect(h.displayInputs.map((bytes) => [...bytes])).toEqual([[1], [2], [3]]);
    expect(h.controller.download()).toEqual({
      sourceFileName: 'report.pdf',
      bytes: Uint8Array.of(3),
    });
  });

  it('rebuilds from pre-Apply display bytes after validation rejection', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture()],
      applyResults: [new ValidationRejectedError(['forced-test-rejection'])],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await prepareReplacement(h.controller, 'Rejected');

    await h.controller.applySelection();

    expect(h.engines[0]!.terminated).toBe(true);
    expect(h.engines[1]!.openInputs[0]).toEqual(Uint8Array.of(1));
    expect(h.displayInputs.map((bytes) => [...bytes])).toEqual([[1], [1]]);
    expect(h.controller.getSnapshot()).toMatchObject({
      downloadAvailable: false,
      status: 'Replacement was not applied; the last validated document was restored.',
    });
  });

  it('names a candidate file-byte failure while restoring validated bytes', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture()],
      applyResults: [new WorkerClientError({
        code: 'RESOURCE_LIMIT',
        message: 'Untrusted candidate detail',
        details: {
          resource: 'fileBytes',
          limit: 15_728_640,
          observedBytes: 15_728_641,
        },
      })],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await prepareReplacement(h.controller, 'Too large');

    await h.controller.applySelection();

    expect(h.engines[1]!.openInputs[0]).toEqual(Uint8Array.of(1));
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      downloadAvailable: false,
      status: 'The edited PDF exceeds the 15 MiB file limit. The last validated document was restored.',
    });
  });

  it('resets edited bytes to the untouched original', async () => {
    const resetInventory = deferred<readonly DocumentEditingFont[]>();
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture('Edited'), analysisFixture()],
      applyResults: [validatedResult(1, Uint8Array.of(2))],
      fontInventoryResults: [[], resetInventory.promise],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await prepareReplacement(h.controller, 'Edited');
    await h.controller.applySelection();

    await h.controller.reset();

    expect(h.engines[1]!.openInputs[0]).toEqual(Uint8Array.of(1));
    expect(h.engines[1]!.fontInventoryCalls).toBe(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      fontInventoryState: 'scanning',
      editingFonts: [],
      hasEdits: false,
      downloadAvailable: false,
    });
    resetInventory.resolve([{ name: 'Reset Font', reason: 'not-embedded' }]);
    await vi.waitFor(() => expect(h.controller.getSnapshot()).toMatchObject({
      fontInventoryState: 'ready',
      editingFonts: [{ name: 'Reset Font', reason: 'not-embedded' }],
    }));
    expect(() => h.controller.download()).toThrow(/validated edit/);
  });

  it('keeps the original editing-font inventory static after registration', async () => {
    const original = Object.freeze({
      name: 'Original Face',
      reason: 'embedded-not-reusable' as const,
    });
    const h = createControllerHarness({
      analyses: [analysisFixture()],
      fontInventoryResults: [[original]],
    });
    await h.controller.open(pdfFile('report.pdf', Uint8Array.of(1)));
    await vi.waitFor(() => expect(h.controller.getSnapshot().editingFonts).toEqual([original]));

    await h.controller.registerFont('upload', 'different-face.ttf', Uint8Array.of(1, 2, 3));

    expect(h.engines[0]!.fontInventoryCalls).toBe(1);
    expect(h.controller.getSnapshot().editingFonts).toEqual([original]);
  });

  it('retains uploaded fonts across documents and reset, then clears them on close', async () => {
    const h = createControllerHarness({
      analyses: [analysisFixture(), analysisFixture(), analysisFixture()],
    });
    await h.controller.open(pdfFile('first.pdf', Uint8Array.of(1)));
    const bytes = Uint8Array.of(4, 5, 6);
    const descriptor = await h.controller.registerFont('upload', 'example.ttf', bytes);
    bytes[0] = 9;

    await h.controller.open(pdfFile('second.pdf', Uint8Array.of(2)));
    await h.controller.reset();

    expect(h.engines[0]!.fontRegistrations).toEqual([{
      source: 'upload',
      fileName: 'example.ttf',
      bytes: Uint8Array.of(4, 5, 6),
    }]);
    expect(h.engines[1]!.fontRegistrations).toEqual(h.engines[0]!.fontRegistrations);
    expect(h.engines[2]!.fontRegistrations).toEqual(h.engines[0]!.fontRegistrations);
    expect(h.controller.listSessionFonts()).toEqual([descriptor]);

    await h.controller.close();
    expect(h.controller.listSessionFonts()).toEqual([]);
  });

  it('ignores analysis from an older document generation', async () => {
    const stale = deferred<AnalysePageResult>();
    const current = analysisFixture('Document B');
    const h = createControllerHarness({ analyses: [stale.promise, current] });
    const openingA = h.controller.open(pdfFile('a.pdf', Uint8Array.of(1)));
    await h.waitForAnalysisCall(0);

    await h.controller.open(pdfFile('b.pdf', Uint8Array.of(2)));
    stale.resolve(analysisFixture('Document A'));
    await openingA;

    expect(h.controller.getSnapshot().fileName).toBe('b.pdf');
    expect(h.controller.getSnapshot().analysis?.spans[0]?.unicode).toBe('Document B');
  });

  it('rejects an oversized file before creating parser resources', async () => {
    const h = createControllerHarness();

    await h.controller.open(pdfFile(
      'large.pdf',
      new Uint8Array(15_728_641),
    ));

    expect(h.controller.getSnapshot().error).toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(h.engines).toHaveLength(0);
    expect(h.displayInputs).toHaveLength(0);
  });

  it('accepts a file at the exact 15 MiB product boundary', async () => {
    const h = createControllerHarness({ analyses: [analysisFixture()] });

    await h.controller.open(pdfFile(
      'boundary.pdf',
      new Uint8Array(15_728_640),
    ));

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      fileName: 'boundary.pdf',
    });
    expect(h.engines).toHaveLength(1);
    expect(h.displayInputs).toHaveLength(1);
  });

  it('rejects a non-PDF file before creating parser resources', async () => {
    const h = createControllerHarness();

    await h.controller.open(new File([Uint8Array.of(1)], 'notes.txt', {
      type: 'text/plain',
    }));

    expect(h.controller.getSnapshot().error).toMatchObject({
      code: 'UNSUPPORTED_DOCUMENT',
    });
    expect(h.engines).toHaveLength(0);
    expect(h.displayInputs).toHaveLength(0);
  });

  it.each(ENGINE_ERROR_CODES)(
    'maps %s without exposing the worker message',
    (code) => {
      const mapped = editorError({ code, message: 'PDF secret text' });
      expect(mapped.code).toBe(code);
      expect(mapped.message).not.toContain('PDF secret text');
      expect(['chooseAnother', 'selectAgain', 'reset', 'retry']).toContain(mapped.action);
    },
  );

  it.each([
    ['fileBytes', 15_728_640, 'This PDF exceeds the 15 MiB file limit.'],
    ['indirectObjects', 2_000, 'This PDF exceeds the 2,000 indirect-object limit.'],
    ['nestingDepth', 12, 'This PDF exceeds the nesting-depth limit of 12.'],
    ['decodedStreamBytes', 4_194_304, 'This PDF contains a decoded stream larger than 4 MiB.'],
    ['operations', 50_000, 'This PDF contains more than 50,000 operations in one content stream.'],
    ['imagePixels', 12_000_000, 'This PDF requires rendering more than 12 megapixels on one page.'],
    ['processingTime', 30_000, 'PDF processing exceeded the 30-second limit.'],
  ] as const)('maps the %s resource limit without exposing worker copy', (resource, limit, message) => {
    expect(editorError({
      code: 'RESOURCE_LIMIT',
      message: 'PDF secret text',
      details: { resource, limit },
    })).toEqual({
      code: 'RESOURCE_LIMIT',
      message,
      action: 'chooseAnother',
    });
  });
});
