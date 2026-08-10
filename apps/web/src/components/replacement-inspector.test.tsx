import {
  buildTextSelection,
  type EffectiveTextStyle,
  type SourceDecorationWarning,
} from '@pdf-editor/pdf-engine';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';

import {
  readyController,
  readyControllerWithApplicablePreview,
  fakeFontDescriptor,
  richPreviewResult,
  selectionFixture,
  textLineAnalysisFixture,
} from '../test/fakes';
import type { EditorSnapshot } from '../model/editor-state';
import { ReplacementInspector } from './replacement-inspector';

function richEditorSnapshot({
  requiredWidth,
  allowedWidth,
  maxAllowedWidth,
  fits,
  baselineDirection = [1, 0],
}: Readonly<{
  requiredWidth: number;
  allowedWidth: number;
  maxAllowedWidth: number;
  fits: boolean;
  baselineDirection?: readonly [number, number];
}>): Partial<EditorSnapshot> {
  const sourceAnalysis = textLineAnalysisFixture('ABC');
  const sourceLine = sourceAnalysis.textLayout.lines[0]!;
  const line = Object.freeze({
    ...sourceLine,
    baselineDirection: Object.freeze([...baselineDirection] as [number, number]),
  });
  const analysis = Object.freeze({
    ...sourceAnalysis,
    textLayout: Object.freeze({
      ...sourceAnalysis.textLayout,
      lines: Object.freeze([line]),
    }),
  });
  const textSelection = buildTextSelection(line, 0, 2);
  const font = fakeFontDescriptor();
  const basePreview = richPreviewResult('ABC');
  return {
    analysis,
    fonts: [font],
    selection: { kind: 'text', groupKey: 'group-1', textSelection },
    replacement: 'ABC',
    richEditor: {
      runs: [{
        text: 'ABC',
        style: textSelection.styleRuns[0]!.style,
        fontId: font.id,
        fontIntent: 'preserve-source',
        decorations: { underline: false, strikethrough: false },
      }],
      allowedRegion: { ...textSelection.bounds, width: allowedWidth },
      maxAllowedWidth,
      substitutionConsents: [],
      fontStatuses: [],
      preview: {
        ...basePreview,
        selectionKey: textSelection.key,
        replacementBounds: { ...textSelection.bounds, width: requiredWidth },
        allowedRegion: { ...textSelection.bounds, width: allowedWidth },
        fits,
        preconditions: {
          ...basePreview.preconditions,
          selectionKey: textSelection.key,
        },
      },
    },
  };
}

it('explains read-only spans without offering an edit field', () => {
  const controller = readyController({
    selection: {
      kind: 'span',
      spanKey: 'span-1',
      span: selectionFixture('Target 02', {
        kind: 'readOnly',
        reasons: ['sharedResource'],
      }),
    },
  });

  render(
    <ReplacementInspector
      controller={controller}
      snapshot={controller.getSnapshot()}
    />,
  );

  expect(screen.getByText(
    'This text is reused elsewhere in the PDF and cannot be changed independently.',
  )).toBeTruthy();
  expect(screen.queryByLabelText('Replace with')).toBeNull();
});

it('requires a matching substitution preview and applies once', async () => {
  const preconditions = {
    spanKey: 'span-1',
    expectedOperatorDigest: 'op',
    expectedGlyphText: 'Target 01',
    expectedNormalisedReplacement: 'Edited',
    expectedSubstitutionAccepted: true,
  } as const;
  const capability = {
    kind: 'replacementWithSubstitution',
    reasons: ['substituteFontRequired'],
  } as const;
  const controller = readyController({
    selection: {
      kind: 'span',
      spanKey: 'span-1',
      span: selectionFixture('Target 01', capability),
    },
    replacement: 'Edited',
    preview: {
      capability,
      normalisedReplacement: 'Edited',
      canApply: false,
      substitutionAccepted: false,
      preconditions: {
        ...preconditions,
        expectedSubstitutionAccepted: false,
      },
    },
  });
  const { rerender } = render(
    <ReplacementInspector
      controller={controller}
      snapshot={controller.getSnapshot()}
    />,
  );
  const apply = screen.getByRole('button', { name: 'Apply replacement' });
  expect(screen.getByText('Font substitution required')).toBeTruthy();
  expect(apply).toHaveProperty('disabled', true);

  await userEvent.click(screen.getByRole('checkbox', { name: 'Use substitute font' }));
  expect(controller.setAcceptSubstitution).toHaveBeenCalledWith(true);

  controller.publish({
    acceptSubstitution: true,
    preview: {
      capability,
      normalisedReplacement: 'Edited',
      canApply: true,
      substitutionAccepted: true,
      preconditions,
    },
  });
  rerender(
    <ReplacementInspector
      controller={controller}
      snapshot={controller.getSnapshot()}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Apply replacement' }));
  expect(controller.applySelection).toHaveBeenCalledTimes(1);
});

it('disables Apply as soon as replacement input invalidates the preview', async () => {
  const controller = readyControllerWithApplicablePreview();
  const { rerender } = render(
    <ReplacementInspector
      controller={controller}
      snapshot={controller.getSnapshot()}
    />,
  );

  await userEvent.clear(screen.getByLabelText('Replace with'));
  await userEvent.type(screen.getByLabelText('Replace with'), 'Changed again');
  expect(controller.setReplacement).toHaveBeenLastCalledWith('Changed again');
  controller.publish({ replacement: 'Changed again', preview: null });
  rerender(
    <ReplacementInspector
      controller={controller}
      snapshot={controller.getSnapshot()}
    />,
  );

  expect(screen.getByRole('button', { name: 'Apply replacement' }))
    .toHaveProperty('disabled', true);
});

it('announces the applying and validation phase', () => {
  const controller = readyControllerWithApplicablePreview();
  controller.publish({ phase: 'applying' });

  render(
    <ReplacementInspector
      controller={controller}
      snapshot={controller.getSnapshot()}
    />,
  );

  expect(screen.getByText('Applying and validating…')).toBeTruthy();
});

it('edits and formats source-backed rich text with fit and font controls', async () => {
  const analysis = textLineAnalysisFixture('ABC');
  const line = analysis.textLayout.lines[0]!;
  const textSelection = buildTextSelection(line, 0, 2);
  const font = fakeFontDescriptor();
  const controller = readyController({
    analysis,
    fonts: [font],
    selection: { kind: 'text', groupKey: 'group-1', textSelection },
    replacement: 'ABC',
    richEditor: {
      runs: [{
        text: 'ABC',
        style: textSelection.styleRuns[0]!.style,
        fontId: font.id,
        fontIntent: 'preserve-source',
        decorations: { underline: false, strikethrough: false },
      }],
      allowedRegion: { ...textSelection.bounds, width: 36 },
      maxAllowedWidth: 72,
      substitutionConsents: [],
      fontStatuses: [{
        key: 'font-status',
        requestedName: 'Helvetica',
        fontId: font.id,
        actualName: 'Example Regular',
        source: 'bundled',
        matchKind: 'substitute',
        reasons: ['family-mismatch'],
      }],
      preview: {
        commandHash: 'rich-command',
        nextRevision: 1,
        selectionKey: textSelection.key,
        replacement: 'ABC',
        replacementBounds: { ...textSelection.bounds, width: 30 },
        allowedRegion: { ...textSelection.bounds, width: 36 },
        fits: true,
        requiredSubstitutionConsents: [font.id],
        fontMatches: [{ fontId: font.id, matchKind: 'substitute' }],
        preconditions: {
          selectionKey: textSelection.key,
          expectedCommandHash: 'rich-command',
          slices: [],
          decorations: [],
        },
      },
    },
  });

  render(
    <ReplacementInspector controller={controller} snapshot={controller.getSnapshot()} />,
  );

  const editor = screen.getByLabelText('Edit selected text') as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: 'AXC' } });
  expect(controller.replaceRichText).toHaveBeenLastCalledWith(
    { start: 1, end: 2 },
    'X',
  );

  editor.setSelectionRange(1, 2);
  fireEvent.select(editor);
  await userEvent.click(screen.getByRole('button', { name: 'Bold' }));
  expect(controller.formatRichText).toHaveBeenCalledWith(
    { start: 1, end: 2 },
    { style: { fontWeight: 700 } },
  );

  const colour = screen.getByLabelText('Text Colour');
  expect(colour.getAttribute('type')).toBe('color');
  expect(colour.closest('label')?.textContent?.trim()).toBe('Text Colour');
  expect(screen.queryByLabelText('Text colour')).toBeNull();

  const appliedFont = fakeFontDescriptor('upload', 'face.ttf');
  controller.registerAndApplyFont.mockResolvedValue({
    descriptor: appliedFont,
    outcome: 'applied',
  });
  await userEvent.upload(
    screen.getByLabelText('Upload and apply font'),
    new File([Uint8Array.of(1, 2, 3)], 'face.ttf', { type: 'font/ttf' }),
  );
  expect(controller.registerAndApplyFont).toHaveBeenCalledWith(
    'upload',
    'face.ttf',
    Uint8Array.of(1, 2, 3),
    {
      generation: 1,
      pageIndex: 0,
      selectionKey: textSelection.key,
      range: { start: 1, end: 2 },
    },
  );

  expect(screen.getByText('Font substitution required')).toBeTruthy();
  await userEvent.click(screen.getByRole('checkbox', {
    name: 'Allow Example Regular for Helvetica',
  }));
  expect(controller.setRichSubstitutionConsent).toHaveBeenCalledWith(font.id, true);

  fireEvent.change(screen.getByLabelText('Allowed width'), { target: { value: '60' } });
  expect(controller.setRichAllowedWidth).toHaveBeenCalledWith(60);
  expect(screen.getByRole('button', { name: 'Apply replacement' }))
    .toHaveProperty('disabled', true);
});

it('fits an overflowing line to the measured width and clamps at the safe maximum', async () => {
  const controller = readyController(richEditorSnapshot({
    requiredWidth: 54,
    allowedWidth: 36,
    maxAllowedWidth: 72,
    fits: false,
  }));
  const { rerender } = render(
    <ReplacementInspector controller={controller} snapshot={controller.getSnapshot()} />,
  );

  await userEvent.click(screen.getByRole('button', { name: 'Fit line' }));
  expect(controller.setRichAllowedWidth).toHaveBeenLastCalledWith(54);

  controller.publish(richEditorSnapshot({
    requiredWidth: 90,
    allowedWidth: 36,
    maxAllowedWidth: 72,
    fits: false,
  }));
  rerender(<ReplacementInspector controller={controller} snapshot={controller.getSnapshot()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Fit line' }));
  expect(controller.setRichAllowedWidth).toHaveBeenLastCalledWith(72);
  expect(screen.getByRole('button', { name: 'Apply replacement' }))
    .toHaveProperty('disabled', true);
});

it('automatically requests a safe horizontal width for rich overflow', () => {
  const controller = readyController(richEditorSnapshot({
    requiredWidth: 54,
    allowedWidth: 36,
    maxAllowedWidth: 72,
    fits: false,
  }));

  render(<ReplacementInspector controller={controller} snapshot={controller.getSnapshot()} />);

  expect(controller.setRichAllowedWidth).toHaveBeenCalledWith(54);
});

it('does not offer Fit line without a measured overflow', () => {
  const controller = readyController(richEditorSnapshot({
    requiredWidth: 30,
    allowedWidth: 36,
    maxAllowedWidth: 72,
    fits: true,
  }));
  const { rerender } = render(
    <ReplacementInspector controller={controller} snapshot={controller.getSnapshot()} />,
  );
  expect(screen.queryByRole('button', { name: 'Fit line' })).toBeNull();

  controller.publish({
    richEditor: { ...controller.getSnapshot().richEditor!, preview: null },
  });
  rerender(<ReplacementInspector controller={controller} snapshot={controller.getSnapshot()} />);
  expect(screen.queryByRole('button', { name: 'Fit line' })).toBeNull();
});

it.each([
  ['90°', [0, 1] as const],
  ['180°', [-1, 0] as const],
  ['270°', [0, -1] as const],
  ['diagonal', [Math.SQRT1_2, Math.SQRT1_2] as const],
])('suppresses automatic fitting for a %s selected-line baseline', (_label, baselineDirection) => {
  const controller = readyController(richEditorSnapshot({
    requiredWidth: 90,
    allowedWidth: 36,
    maxAllowedWidth: 72,
    fits: false,
    baselineDirection,
  }));

  render(<ReplacementInspector controller={controller} snapshot={controller.getSnapshot()} />);

  expect(screen.queryByRole('button', { name: 'Fit line' })).toBeNull();
  expect(screen.getByText('Automatic fitting is unavailable for rotated text.')).toBeTruthy();
  expect(controller.setRichAllowedWidth).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Apply replacement' }))
    .toHaveProperty('disabled', true);
});

it('uses whole-selection mixed state for all four independent style controls', async () => {
  const analysis = textLineAnalysisFixture('AB');
  const line = analysis.textLayout.lines[0]!;
  const textSelection = buildTextSelection(line, 0, 1);
  const font = fakeFontDescriptor();
  const style = textSelection.styleRuns[0]!.style;
  const controller = readyController({
    analysis,
    fonts: [font],
    selection: { kind: 'text', groupKey: 'group-1', textSelection },
    replacement: 'AB',
    richEditor: {
      runs: [{
        text: 'A',
        style: Object.freeze({
          ...style,
          fontWeight: 700,
          italicAngle: -12,
        } satisfies EffectiveTextStyle),
        fontId: font.id,
        fontIntent: 'preserve-source',
        decorations: { underline: true, strikethrough: true },
      }, {
        text: 'B',
        style: Object.freeze({
          ...style,
          fontWeight: 400,
          italicAngle: -12,
        } satisfies EffectiveTextStyle),
        fontId: font.id,
        fontIntent: 'preserve-source',
        decorations: { underline: false, strikethrough: true },
      }],
      allowedRegion: { ...textSelection.bounds, width: 36 },
      maxAllowedWidth: 72,
      substitutionConsents: [],
      fontStatuses: [],
      preview: null,
    },
  });

  render(
    <ReplacementInspector controller={controller} snapshot={controller.getSnapshot()} />,
  );

  const bold = screen.getByRole('button', { name: 'Bold' });
  const italic = screen.getByRole('button', { name: 'Italic' });
  const underline = screen.getByRole('button', { name: 'Underline' });
  const strikethrough = screen.getByRole('button', { name: 'Strikethrough' });
  expect(bold.getAttribute('aria-pressed')).toBe('mixed');
  expect(italic.getAttribute('aria-pressed')).toBe('true');
  expect(underline.getAttribute('aria-pressed')).toBe('mixed');
  expect(strikethrough.getAttribute('aria-pressed')).toBe('true');

  await userEvent.click(bold);
  expect(controller.formatRichText).toHaveBeenLastCalledWith(
    { start: 0, end: 2 },
    { style: { fontWeight: 700 } },
  );
  await userEvent.click(italic);
  expect(controller.formatRichText).toHaveBeenLastCalledWith(
    { start: 0, end: 2 },
    { style: { italicAngle: 0 } },
  );
  await userEvent.click(underline);
  expect(controller.formatRichText).toHaveBeenLastCalledWith(
    { start: 0, end: 2 },
    { decorations: { underline: true } },
  );
  await userEvent.click(strikethrough);
  expect(controller.formatRichText).toHaveBeenLastCalledWith(
    { start: 0, end: 2 },
    { decorations: { strikethrough: false } },
  );
});

it('warns that ambiguous nearby line artwork will be preserved', () => {
  const analysis = textLineAnalysisFixture('AB');
  const line = analysis.textLayout.lines[0]!;
  const sourceSelection = buildTextSelection(line, 0, 1);
  const warning = Object.freeze({
    reason: 'ambiguous-geometry',
    graphic: Object.freeze({
      address: Object.freeze({
        pageRef: Object.freeze({ objectNumber: 1, generationNumber: 0 }),
        streamPath: Object.freeze([]),
        operatorRange: Object.freeze({ start: 0, end: 1 }),
      }),
      referenceCount: 1,
      paint: 'stroke',
      axis: Object.freeze([
        Object.freeze([10, 18] as const),
        Object.freeze([34, 18] as const),
      ] as const),
      quad: Object.freeze([
        Object.freeze([10, 17.5] as const),
        Object.freeze([34, 17.5] as const),
        Object.freeze([34, 18.5] as const),
        Object.freeze([10, 18.5] as const),
      ] as const),
      bounds: Object.freeze({ x: 10, y: 17.5, width: 24, height: 1 }),
      thickness: 1,
      colour: Object.freeze({ colourSpace: 'DeviceGray', components: Object.freeze([0]) }),
    }),
    lineKey: line.key,
    glyphRanges: Object.freeze([Object.freeze({ start: 0, end: 2 })]),
  } satisfies SourceDecorationWarning);
  const textSelection = Object.freeze({
    ...sourceSelection,
    decorationWarnings: Object.freeze([warning]),
  });
  const font = fakeFontDescriptor();
  const controller = readyController({
    analysis,
    fonts: [font],
    selection: { kind: 'text', groupKey: 'group-1', textSelection },
    replacement: 'AB',
    richEditor: {
      runs: [{
        text: 'AB',
        style: textSelection.styleRuns[0]!.style,
        fontId: font.id,
        fontIntent: 'preserve-source',
        decorations: { underline: false, strikethrough: false },
      }],
      allowedRegion: { ...textSelection.bounds, width: 36 },
      maxAllowedWidth: 72,
      substitutionConsents: [],
      fontStatuses: [],
      preview: null,
    },
  });

  render(
    <ReplacementInspector controller={controller} snapshot={controller.getSnapshot()} />,
  );

  expect(screen.getByRole('status').textContent).toContain(
    'Nearby line artwork could not be identified safely. It will be preserved and may not resize with edited text.',
  );
});
