import { describe, expect, it } from 'vitest';

import { PROVISIONAL_LIMITS, type EngineLimits } from '../../src/limits';
import {
  tokeniseContentStream,
  type PdfOperand,
} from '../../src/content/tokeniser';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);
const TEST_LIMITS: EngineLimits = {
  ...PROVISIONAL_LIMITS,
  maxNestingDepth: 8,
  maxOperationsPerStream: 20,
};

describe('tokeniseContentStream', () => {
  it.each([
    ['(Hello) Tj', 'Tj'],
    ['[(Hel) -40 (lo)] TJ', 'TJ'],
    ["(Hello) '\n", "'"],
    ['10 20 (Hello) "', '"'],
  ])('records exact byte ranges for %s', (source, operator) => {
    const bytes = encode(source);
    const [operation] = tokeniseContentStream(bytes, TEST_LIMITS);

    expect(operation?.operator).toBe(operator);
    expect(decode(operation!.rawBytes)).toBe(source.trim());
    expect(operation?.startOffset).toBe(0);
    expect(operation?.endOffset).toBe(source.trim().length);
  });

  it('parses nested arrays and every supported primitive operand losslessly', () => {
    const source = '/A#20B -1.25 true false null [(a\\(b\\051) <4142> [3]] Op';
    const [operation] = tokeniseContentStream(encode(source), TEST_LIMITS);

    expect(operation?.operator).toBe('Op');
    expect(operation?.operands.map((operand) => operand.kind)).toEqual([
      'name',
      'number',
      'boolean',
      'boolean',
      'null',
      'array',
    ]);
    expect(operation?.operands.map((operand) => decode(operand.rawBytes))).toEqual([
      '/A#20B',
      '-1.25',
      'true',
      'false',
      'null',
      '[(a\\(b\\051) <4142> [3]]',
    ]);
    expect((operation?.operands[0] as Extract<PdfOperand, { kind: 'name' }>).value).toBe(
      'A B',
    );
  });

  it('handles comments and all PDF line-ending forms without changing operation bytes', () => {
    const source = '% first\r\n(One) Tj\r% second\n(Two) Tj\r\n';
    const operations = tokeniseContentStream(encode(source), TEST_LIMITS);

    expect(operations.map((operation) => operation.operator)).toEqual(['Tj', 'Tj']);
    expect(operations.map((operation) => decode(operation.rawBytes))).toEqual([
      '(One) Tj',
      '(Two) Tj',
    ]);
  });

  it('rejects inline images rather than scanning binary data as operators', () => {
    expect(() =>
      tokeniseContentStream(encode('BI /W 1 /H 1 ID abc EI'), TEST_LIMITS),
    ).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_DOCUMENT' }),
    );
  });

  it.each(['(truncated Tj', '<414 Tj', '[1 2 Op']) (
    'rejects malformed input %j with a typed error',
    (source) => {
      expect(() => tokeniseContentStream(encode(source), TEST_LIMITS)).toThrowError(
        expect.objectContaining({ code: 'MALFORMED_INPUT' }),
      );
    },
  );

  it('enforces the nesting-depth limit', () => {
    const limits = { ...TEST_LIMITS, maxNestingDepth: 2 };

    expect(() => tokeniseContentStream(encode('[[[1]]] Op'), limits)).toThrowError(
      expect.objectContaining({
        code: 'RESOURCE_LIMIT',
        details: expect.objectContaining({ resource: 'nestingDepth', limit: 2 }),
      }),
    );
    expect(() => tokeniseContentStream(encode('(((text))) Tj'), limits)).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_LIMIT' }),
    );
  });

  it('rejects decoded input larger than the configured stream-byte limit', () => {
    const limits = { ...TEST_LIMITS, maxDecodedStreamBytes: 4 };

    expect(() => tokeniseContentStream(encode('(abc) Tj'), limits)).toThrowError(
      expect.objectContaining({
        code: 'RESOURCE_LIMIT',
        details: {
          resource: 'decodedStreamBytes',
          limit: 4,
          observedBytes: 8,
        },
      }),
    );
  });

  it('enforces the operation-count limit before appending another operation', () => {
    const limits = { ...TEST_LIMITS, maxOperationsPerStream: 2 };

    expect(() => tokeniseContentStream(encode('q Q BT'), limits)).toThrowError(
      expect.objectContaining({
        code: 'RESOURCE_LIMIT',
        details: { resource: 'operations', limit: 2 },
      }),
    );
  });
});
