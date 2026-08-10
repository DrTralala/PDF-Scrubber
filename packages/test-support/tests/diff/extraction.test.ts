import { describe, expect, test } from 'vitest';

import {
  evaluateExtraction,
  type ExtractedTextItem,
} from '../../src/diff/extraction';

const targetBounds = Object.freeze({ x: 70, y: 680, width: 90, height: 28 });

function item(text: string, x: number, y: number): ExtractedTextItem {
  return Object.freeze({
    text,
    pageIndex: 0,
    bounds: Object.freeze({ x, y, width: 90, height: 24 }),
  });
}

describe('extraction validation', () => {
  test('requires old text to disappear only at the target while preserving an equal string elsewhere', () => {
    const evidence = evaluateExtraction(
      [item('Edited 01', 72, 682), item('Target 01', 300, 500)],
      {
        pageIndex: 0,
        targetBounds,
        oldText: 'Target 01',
        newText: 'Edited 01',
        expectedOldTextOutsideTarget: 1,
      },
    );

    expect(evidence).toMatchObject({
      oldTextAbsentAtTarget: true,
      newTextPresentAtTarget: true,
      oldTextOutsideTargetCount: 1,
      outsideTextPreserved: true,
      valid: true,
    });
  });

  test('rejects a white-out counterfeit because target extraction still contains the old text', () => {
    const evidence = evaluateExtraction(
      [item('Target 01', 72, 682), item('Target 01', 300, 500)],
      {
        pageIndex: 0,
        targetBounds,
        oldText: 'Target 01',
        newText: 'Edited 01',
        expectedOldTextOutsideTarget: 1,
      },
    );

    expect(evidence.oldTextAbsentAtTarget).toBe(false);
    expect(evidence.valid).toBe(false);
  });
});
