import { describe, expect, test } from 'vitest';

import { parseControlledRedraw } from '../../src/content/controlled-redraw';
import { tokeniseContentStream } from '../../src/content/tokeniser';
import { PROVISIONAL_LIMITS } from '../../src/limits';

const encoder = new TextEncoder();

function parse(glyphOperand: string) {
  return parseControlledRedraw(tokeniseContentStream(encoder.encode([
    'q',
    'BT',
    '/M0R_0123456789abcdef 12 Tf',
    '/Span << /ActualText <FEFF0041> >> BDC',
    '1 0 0 1 10 20 Tm',
    `${glyphOperand} Tj`,
    'EMC',
    'ET',
    'Q',
  ].join('\n')), PROVISIONAL_LIMITS));
}

describe('controlled redraw v1', () => {
  test('recognises a redraw with a non-empty glyph operand', () => {
    expect(parse('<0001>')).toMatchObject({
      version: 1,
      actualText: 'A',
      textOperationIndexes: [5],
    });
  });

  test('rejects an empty glyph operand', () => {
    expect(parse('<>')).toBeNull();
  });
});
