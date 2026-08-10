import { describe, expect, it } from 'vitest';

import { PROVISIONAL_LIMITS } from '../../src/limits';
import {
  decodeTextOperand,
  rewriteTextOperand,
  type GlyphSourceMapping,
} from '../../src/content/operands';
import { tokeniseContentStream, type PdfOperand } from '../../src/content/tokeniser';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

function firstOperand(source: string): PdfOperand {
  return tokeniseContentStream(encode(`${source} Tj`), PROVISIONAL_LIMITS)[0]!
    .operands[0]!;
}

function oneBytePerGlyph(count: number): readonly GlyphSourceMapping[] {
  return Array.from({ length: count }, (_, glyphIndex) => ({
    glyphIndex,
    sourceCodeStart: glyphIndex,
    sourceCodeEnd: glyphIndex + 1,
  }));
}

describe('decodeTextOperand', () => {
  it('decodes literal-string escapes without treating source bytes as Unicode', () => {
    const operand = firstOperand('(A\\(B\\051\\n\\r\\t\\b\\f\\\\C)');

    expect([...decodeTextOperand(operand)]).toEqual([
      65, 40, 66, 41, 10, 13, 9, 8, 12, 92, 67,
    ]);
  });

  it('decodes whitespace and odd nibbles in hexadecimal strings', () => {
    expect([...decodeTextOperand(firstOperand('<41 42 4>'))]).toEqual([65, 66, 64]);
  });

  it('concatenates only string codes from a TJ array', () => {
    expect(
      decode(decodeTextOperand(firstOperand('[(A) -40 <4243> 20 (D)]'))),
    ).toBe('ABCD');
  });

  it('rejects non-text operands', () => {
    expect(() => decodeTextOperand(firstOperand('42'))).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_DOCUMENT' }),
    );
  });
});

describe('rewriteTextOperand', () => {
  it('preserves exact literal-string escape bytes around a selected glyph range', () => {
    const result = rewriteTextOperand(
      firstOperand('(A\\(BC\\051D)'),
      oneBytePerGlyph(6),
      { start: 2, end: 4 },
    );

    expect(result.kind).toBe('preserved');
    if (result.kind !== 'preserved') return;
    expect(decode(result.prefixOperandBytes!)).toBe('(A\\()');
    expect(decode(result.suffixOperandBytes!)).toBe('(\\051D)');
  });

  it('preserves exact hexadecimal digits around a selected glyph range', () => {
    const result = rewriteTextOperand(firstOperand('<41424344>'), oneBytePerGlyph(4), {
      start: 1,
      end: 3,
    });

    expect(result.kind).toBe('preserved');
    if (result.kind !== 'preserved') return;
    expect(decode(result.prefixOperandBytes!)).toBe('<41>');
    expect(decode(result.suffixOperandBytes!)).toBe('<44>');
  });

  it('preserves TJ positioning adjustments belonging to retained suffix text', () => {
    const result = rewriteTextOperand(
      firstOperand('[(A) -40 (BC) 20 (D)]'),
      oneBytePerGlyph(4),
      { start: 1, end: 3 },
    );

    expect(result.kind).toBe('preserved');
    if (result.kind !== 'preserved') return;
    expect(decode(result.prefixOperandBytes!)).toBe('[(A) -40]');
    expect(decode(result.suffixOperandBytes!)).toBe('[20 (D)]');
  });

  it('requires expansion when glyph source-code ranges overlap a cut', () => {
    const result = rewriteTextOperand(
      firstOperand('(AB)'),
      [
        { glyphIndex: 0, sourceCodeStart: 0, sourceCodeEnd: 2 },
        { glyphIndex: 1, sourceCodeStart: 1, sourceCodeEnd: 2 },
      ],
      { start: 1, end: 2 },
    );

    expect(result).toEqual({ kind: 'expandRequired' });
  });

  it('returns unsupported for incomplete or invalid mapping evidence', () => {
    const result = rewriteTextOperand(
      firstOperand('(ABC)'),
      [{ glyphIndex: 0, sourceCodeStart: 0, sourceCodeEnd: 1 }],
      { start: 1, end: 2 },
    );

    expect(result).toEqual({ kind: 'unsupported' });
  });
});
