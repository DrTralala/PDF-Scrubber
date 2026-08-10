import { fireEvent, render, screen } from '@testing-library/react';
import { buildTextSelection } from '@pdf-editor/pdf-engine';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';

import {
  analysisFixture,
  fakeFontDescriptor,
  readyController,
  textLineAnalysisFixture,
} from '../test/fakes';
import { CapabilityOverlay } from './capability-overlay';

it('uses one roving tab stop and selects with the keyboard', async () => {
  const analysis = analysisFixture([
    {
      text: 'Target 01',
      capability: {
        kind: 'safeReplacement',
        reasons: ['supportedExistingFont'],
      },
    },
    {
      text: 'Target 02',
      capability: { kind: 'readOnly', reasons: ['sharedResource'] },
    },
  ]);
  const controller = readyController({ analysis });

  render(
    <CapabilityOverlay
      controller={controller}
      analysis={analysis}
      selection={null}
      viewport={{ width: 612, height: 792 }}
      showOverlays
      tool="select"
    />,
  );
  const first = screen.getByRole('button', { name: 'Target 01 — Editable' });
  const second = screen.getByRole('button', { name: 'Target 02 — Read-only' });
  expect(first.tabIndex).toBe(0);
  expect(second.tabIndex).toBe(-1);

  first.focus();
  await userEvent.keyboard('{ArrowRight}{Enter}');

  expect(second.tabIndex).toBe(0);
  expect(controller.selectTextRange).toHaveBeenCalledWith(
    'line-2',
    0,
    0,
    'group-2',
  );
});

it('uses one group target while drag-selecting source glyphs on its line', () => {
  const analysis = textLineAnalysisFixture('ABC');
  const controller = readyController({ analysis });
  const { container } = render(
    <CapabilityOverlay
      controller={controller}
      analysis={analysis}
      selection={null}
      viewport={{ width: 612, height: 792 }}
      showOverlays
      tool="select"
    />,
  );

  expect(screen.getAllByRole('button')).toHaveLength(1);
  const hitLayer = container.querySelector<HTMLElement>('.text-selection-hit-layer');
  expect(hitLayer).not.toBeNull();
  Object.defineProperty(hitLayer, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 612, height: 792 }),
  });

  fireEvent.pointerDown(hitLayer!, {
    button: 0,
    pointerId: 7,
    clientX: 15,
    clientY: 766,
  });
  fireEvent.pointerMove(hitLayer!, {
    pointerId: 7,
    clientX: 55,
    clientY: 766,
  });
  fireEvent.pointerUp(hitLayer!, {
    pointerId: 7,
    clientX: 55,
    clientY: 766,
  });

  expect(controller.selectTextRange).toHaveBeenLastCalledWith(
    'line-1',
    0,
    2,
    null,
  );
});

it('does not begin text selection while the pan tool is active', () => {
  const analysis = textLineAnalysisFixture('ABC');
  const controller = readyController({ analysis });
  const { container } = render(
    <CapabilityOverlay
      controller={controller}
      analysis={analysis}
      selection={null}
      viewport={{ width: 612, height: 792 }}
      showOverlays
      tool="pan"
    />,
  );
  const hitLayer = container.querySelector<HTMLElement>('.text-selection-hit-layer');
  fireEvent.pointerDown(hitLayer!, {
    button: 0,
    pointerId: 8,
    clientX: 15,
    clientY: 766,
  });
  fireEvent.pointerUp(hitLayer!, {
    pointerId: 8,
    clientX: 15,
    clientY: 766,
  });

  expect(controller.selectTextRange).not.toHaveBeenCalled();
});

it('keeps a drag on its starting visual line', () => {
  const base = textLineAnalysisFixture('ABC');
  const firstLine = base.textLayout.lines[0]!;
  const secondGlyphs = firstLine.glyphs.map((glyph) => Object.freeze({
    ...glyph,
    bounds: Object.freeze({ ...glyph.bounds, y: 100 }),
    baseline: Object.freeze([glyph.baseline[0], 100] as const),
  }));
  const secondGroup = Object.freeze({
    ...firstLine.groups[0]!,
    key: 'group-2',
    lineKey: 'line-2',
    bounds: Object.freeze({ ...firstLine.groups[0]!.bounds, y: 100 }),
  });
  const secondLine = Object.freeze({
    ...firstLine,
    key: 'line-2',
    glyphs: Object.freeze(secondGlyphs),
    groups: Object.freeze([secondGroup]),
    bounds: Object.freeze({ ...firstLine.bounds, y: 100 }),
  });
  const analysis = Object.freeze({
    ...base,
    textLayout: Object.freeze({
      ...base.textLayout,
      lines: Object.freeze([firstLine, secondLine]),
      groups: Object.freeze([firstLine.groups[0]!, secondGroup]),
      eligibleSourceGlyphCount: 6,
    }),
  });
  const controller = readyController({ analysis });
  const { container } = render(
    <CapabilityOverlay
      controller={controller}
      analysis={analysis}
      selection={null}
      viewport={{ width: 612, height: 792 }}
      showOverlays
      tool="select"
    />,
  );
  const hitLayer = container.querySelector<HTMLElement>('.text-selection-hit-layer')!;
  Object.defineProperty(hitLayer, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 612, height: 792 }),
  });

  fireEvent.pointerDown(hitLayer, {
    button: 0,
    pointerId: 9,
    clientX: 15,
    clientY: 766,
  });
  fireEvent.pointerMove(hitLayer, {
    pointerId: 9,
    clientX: 35,
    clientY: 686,
  });
  fireEvent.pointerUp(hitLayer, {
    pointerId: 9,
    clientX: 35,
    clientY: 686,
  });

  expect(controller.selectTextRange).toHaveBeenLastCalledWith(
    'line-1',
    0,
    2,
    'group-1',
  );
});

it('discards a cancelled pointer selection', () => {
  const analysis = textLineAnalysisFixture('ABC');
  const controller = readyController({ analysis });
  const { container } = render(
    <CapabilityOverlay
      controller={controller}
      analysis={analysis}
      selection={null}
      viewport={{ width: 612, height: 792 }}
      showOverlays
      tool="select"
    />,
  );
  const hitLayer = container.querySelector<HTMLElement>('.text-selection-hit-layer')!;
  Object.defineProperty(hitLayer, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 612, height: 792 }),
  });

  fireEvent.pointerDown(hitLayer, {
    button: 0,
    pointerId: 10,
    clientX: 15,
    clientY: 766,
  });
  fireEvent.pointerCancel(hitLayer, {
    pointerId: 10,
    clientX: 15,
    clientY: 766,
  });

  expect(controller.selectTextRange).not.toHaveBeenCalled();
});

it('shows the authorised line region and shaped rich preview in page space', () => {
  const analysis = textLineAnalysisFixture('ABC');
  const line = analysis.textLayout.lines[0]!;
  const textSelection = buildTextSelection(line, 0, 2);
  const font = fakeFontDescriptor();
  const previewStyle = Object.freeze({
    ...textSelection.styleRuns[0]!.style,
    characterSpacing: 1.5,
    wordSpacing: 2.5,
  });
  const richEditor = {
    runs: [{
      text: 'AXC',
      style: previewStyle,
      fontId: font.id,
      fontIntent: 'preserve-source' as const,
      decorations: { underline: false, strikethrough: false },
    }],
    allowedRegion: { ...textSelection.bounds, width: 50 },
    maxAllowedWidth: 80,
    substitutionConsents: [],
    fontStatuses: [],
    preview: {
      commandHash: 'rich-command',
      nextRevision: 1,
      selectionKey: textSelection.key,
      replacement: 'AXC',
      replacementBounds: { ...textSelection.bounds, width: 30 },
      allowedRegion: { ...textSelection.bounds, width: 50 },
      fits: true,
      requiredSubstitutionConsents: [],
      fontMatches: [{ fontId: font.id, matchKind: 'substitute' as const }],
      preconditions: {
        selectionKey: textSelection.key,
        expectedCommandHash: 'rich-command',
        slices: [],
        decorations: [],
      },
    },
  };

  const { container } = render(
    <CapabilityOverlay
      controller={readyController({ analysis })}
      analysis={analysis}
      selection={{ kind: 'text', groupKey: 'group-1', textSelection }}
      richEditor={richEditor}
      fonts={[font]}
      viewport={{ width: 612, height: 792 }}
      showOverlays
      tool="select"
    />,
  );

  expect(container.querySelector('.rich-allowed-region')).not.toBeNull();
  expect(container.querySelector('.rich-preview-bounds')).not.toBeNull();
  expect(container.querySelector('.rich-preview-text')?.textContent).toBe('AXC');
  const previewRun = container.querySelector<HTMLElement>('.rich-preview-text span');
  expect(previewRun?.style.letterSpacing).toBe('1.5px');
  expect(previewRun?.style.wordSpacing).toBe('2.5px');
});
