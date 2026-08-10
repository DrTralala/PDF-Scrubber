import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PROVISIONAL_LIMITS } from '../../src/limits';
import { tokeniseContentStream } from '../../src/content/tokeniser';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

const whitespace = fc.constantFrom(' ', '\t', '\n', '\r', '\r\n', '\f');
const comment = fc
  .string({ unit: fc.constantFrom('a', 'b', '0', ' ', '#'), maxLength: 12 })
  .map((body) => `%${body}\n`);
const separator = fc.array(fc.oneof(whitespace, comment), { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join(''));
const numberOperand = fc
  .tuple(fc.constantFrom('', '-', '+'), fc.integer({ min: 0, max: 999 }), fc.option(fc.integer({ min: 0, max: 999 }), { nil: undefined }))
  .map(([sign, whole, fraction]) =>
    fraction === undefined ? `${sign}${whole}` : `${sign}${whole}.${fraction}`,
  );
const literalBody = fc
  .array(fc.constantFrom('a', 'Z', '0', ' ', '\\(', '\\)', '\\\\', '\\101'), {
    maxLength: 12,
  })
  .map((parts) => parts.join(''));
const literalOperand = literalBody.map((body) => `(${body})`);
const arrayOperand = fc
  .tuple(literalOperand, separator, numberOperand, separator, literalOperand)
  .map(([left, firstSeparator, adjustment, secondSeparator, right]) =>
    `[${left}${firstSeparator}${adjustment}${secondSeparator}${right}]`,
  );
const validStream = fc
  .tuple(
    fc.oneof(numberOperand, literalOperand, arrayOperand),
    separator,
    fc.constantFrom('Tj', 'TJ', 'Op'),
    fc.option(separator, { nil: '' }),
  )
  .map(([operand, between, operator, trailing]) => `${operand}${between}${operator}${trailing}`);
const malformedStream = fc.oneof(
  literalBody.map((body) => `(${body}`),
  literalBody.map((body) => `<${body.replaceAll(' ', '')}Z>`),
  fc.integer({ min: 1, max: 80 }).map((depth) => `${'['.repeat(depth)}1 Op`),
);

describe('content tokeniser properties', () => {
  it('is lossless for supported streams and terminates quickly for malformed streams', () => {
    fc.assert(
      fc.property(fc.oneof(
        validStream.map((source) => ({ kind: 'valid' as const, source })),
        malformedStream.map((source) => ({ kind: 'malformed' as const, source })),
      ), (sample) => {
        const startedAt = performance.now();
        if (sample.kind === 'valid') {
          const first = tokeniseContentStream(encode(sample.source), PROVISIONAL_LIMITS);
          const reparsed = tokeniseContentStream(first[0]!.rawBytes, PROVISIONAL_LIMITS);
          expect(reparsed.map((operation) => operation.operator)).toEqual(
            first.map((operation) => operation.operator),
          );
          expect(reparsed.map((operation) => decode(operation.rawBytes))).toEqual(
            first.map((operation) => decode(operation.rawBytes)),
          );
        } else {
          expect(() =>
            tokeniseContentStream(encode(sample.source), PROVISIONAL_LIMITS),
          ).toThrowError(expect.objectContaining({ code: expect.any(String) }));
        }
        expect(performance.now() - startedAt).toBeLessThan(100);
      }),
      { numRuns: 10_000, seed: 20_260_726 },
    );
  }, 30_000);
});
