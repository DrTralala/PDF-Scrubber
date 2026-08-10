import { buildTextSelection } from '@pdf-editor/pdf-engine';
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { fakeFontDescriptor, readyController, textLineAnalysisFixture } from '../test/fakes';
import { useEditor } from './use-editor';

afterEach(() => vi.useRealTimers());

test('automatically requests a rich preview after source-backed edits settle', () => {
  vi.useFakeTimers();
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
      allowedRegion: textSelection.bounds,
      maxAllowedWidth: textSelection.bounds.width,
      substitutionConsents: [],
      fontStatuses: [],
      preview: null,
    },
  });

  renderHook(() => useEditor(controller));
  act(() => vi.advanceTimersByTime(250));

  expect(controller.previewSelection).toHaveBeenCalledTimes(1);
});
