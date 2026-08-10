import { describe, expect, test } from 'vitest';

import { tokeniseContentStream } from '../../src/content/tokeniser';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import {
  applyTextStateOperation,
  createTextState,
} from '../../src/analysis/text-state';

function operations(source: string) {
  return tokeniseContentStream(new TextEncoder().encode(source), PROVISIONAL_LIMITS);
}

describe('text and graphics state', () => {
  test('tracks the mutation-relevant text-state operators exactly', () => {
    let state = createTextState();
    for (const operation of operations(
      'BT /F0 12 Tf 1 Tc 2 Tw 80 Tz 14 TL 3 Ts 1 0 0 1 20 30 Tm 4 5 Td 6 7 TD T*',
    )) {
      state = applyTextStateOperation(state, operation);
    }

    expect(state).toMatchObject({
      inTextObject: true,
      fontResourceName: 'F0',
      fontSize: 12,
      characterSpacing: 1,
      wordSpacing: 2,
      horizontalScaling: 0.8,
      leading: -7,
      rise: 3,
    });
    expect(state.textMatrix).toEqual([1, 0, 0, 1, 30, 49]);
    expect(state.lineMatrix).toEqual([1, 0, 0, 1, 30, 49]);
  });

  test('applies quote operators as line movement and spacing state', () => {
    let state = createTextState();
    const source = 'BT /F0 10 Tf 12 TL 40 50 Td (A) \' 3 4 (B) "';
    for (const operation of operations(source)) {
      state = applyTextStateOperation(state, operation);
    }

    expect(state.wordSpacing).toBe(3);
    expect(state.characterSpacing).toBe(4);
    expect(state.textMatrix).toEqual([1, 0, 0, 1, 40, 26]);
  });

  test('rejects state-dependent text outside a text object', () => {
    const [operation] = operations('/F0 12 Tf');
    expect(() => applyTextStateOperation(createTextState(), operation!)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_DOCUMENT' }),
    );
  });
});
