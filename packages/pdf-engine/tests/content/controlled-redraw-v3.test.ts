import { describe, expect, test } from 'vitest';

import {
  LEGACY_MARKED_CONTENT_TAG,
  PDF_SCRUBBER_MARKED_CONTENT_TAG,
} from '../../src/content/brand-markers';
import { parseControlledRedraw } from '../../src/content/controlled-redraw';
import { tokeniseContentStream } from '../../src/content/tokeniser';
import { PROVISIONAL_LIMITS } from '../../src/limits';

const encoder = new TextEncoder();
const hash = '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF';

function parse(lines: readonly string[]) {
  return parseControlledRedraw(tokeniseContentStream(
    encoder.encode(lines.join('\n')),
    PROVISIONAL_LIMITS,
  ));
}

describe('controlled redraw v3', () => {
  test('binds glyph operations and independent decoration flags to each rich run', () => {
    const controlled = parse([
      'q',
       `/${PDF_SCRUBBER_MARKED_CONTENT_TAG} << /Version 3 /ActualText <FEFF00410042> /CommandHash <${hash}> /RunGlyphCounts [1 1] /RunDecorations [1 2] >> BDC`,
      'BT',
      '/M0R_0123456789abcdef_0 12 Tf',
      '1 0 0 1 10 20 Tm',
      '<0001> Tj',
      '/M0R_0123456789abcdef_1 12 Tf',
      '1 0 0 1 17 20 Tm',
      '<0001> Tj',
      'ET',
      '0 g',
      '10 18 m', '16 18 l', '16 19 l', '10 19 l', 'h', 'f',
      '0 g',
      '17 24 m', '23 24 l', '23 25 l', '17 25 l', 'h', 'f',
      'EMC',
      'Q',
    ]);

    expect(controlled).toEqual({
      version: 3,
      actualText: 'AB',
      commandHash: hash.toLowerCase(),
      fontResourceNames: [
        'M0R_0123456789abcdef_0',
        'M0R_0123456789abcdef_1',
      ],
      textOperationIndexes: [5, 8],
      textFontResourceNames: [
        'M0R_0123456789abcdef_0',
        'M0R_0123456789abcdef_1',
      ],
      runGlyphCounts: [1, 1],
      runDecorations: [
        { underline: true, strikethrough: false },
        { underline: false, strikethrough: true },
      ],
      textRunIndexes: [0, 1],
      decorationOperationIndexes: [16, 23],
    });
  });

  test('recognises a legacy marked-content tag', () => {
    const controlled = parse([
      'q',
      `/${LEGACY_MARKED_CONTENT_TAG} << /Version 3 /ActualText <FEFF0041> /CommandHash <${hash}> /RunGlyphCounts [1] /RunDecorations [0] >> BDC`,
      'BT',
      '/M0R_0123456789abcdef_0 12 Tf',
      '1 0 0 1 10 20 Tm', '<0001> Tj',
      'ET',
      'EMC',
      'Q',
    ]);

    expect(controlled).toMatchObject({
      version: 3,
      actualText: 'A',
      commandHash: hash.toLowerCase(),
    });
  });

  test.each([
    ['glyph count does not cover text', '[1 2]', '[1 2]'],
    ['decoration array length differs', '[1 1]', '[1]'],
    ['decoration bitmask is invalid', '[1 1]', '[1 4]'],
  ])('rejects malformed v3 metadata when %s', (_name, counts, decorations) => {
    expect(parse([
      'q',
       `/${PDF_SCRUBBER_MARKED_CONTENT_TAG} << /Version 3 /ActualText <FEFF00410042> /CommandHash <${hash}> /RunGlyphCounts ${counts} /RunDecorations ${decorations} >> BDC`,
      'BT',
      '/M0R_0123456789abcdef_0 12 Tf',
      '1 0 0 1 10 20 Tm', '<0001> Tj',
      '1 0 0 1 17 20 Tm', '<0002> Tj',
      'ET',
      'EMC',
      'Q',
    ])).toBeNull();
  });

  test('rejects missing, additional, or non-quadrilateral decoration graphics', () => {
    const metadata = `/${PDF_SCRUBBER_MARKED_CONTENT_TAG} << /Version 3 /ActualText <FEFF0041> /CommandHash <${hash}> /RunGlyphCounts [1] /RunDecorations [1] >> BDC`;
    const text = [
      'BT', '/M0R_0123456789abcdef_0 12 Tf',
      '1 0 0 1 10 20 Tm', '<0001> Tj', 'ET',
    ];
    expect(parse(['q', metadata, ...text, 'EMC', 'Q'])).toBeNull();
    expect(parse([
      'q', metadata, ...text,
      '0 g', '10 18 m', '16 18 l', '16 19 l', '10 19 l', 'h', 'f',
      '0 g', '10 20 m', '16 20 l', '16 21 l', '10 21 l', 'h', 'f',
      'EMC', 'Q',
    ])).toBeNull();
    expect(parse([
      'q', metadata, ...text,
      '0 g', '10 18 m', '16 18 l', '10 19 l', 'h', 'f',
      'EMC', 'Q',
    ])).toBeNull();
  });

  test('rejects an empty glyph operand', () => {
    expect(parse([
      'q',
       `/${PDF_SCRUBBER_MARKED_CONTENT_TAG} << /Version 3 /ActualText <FEFF0041> /CommandHash <${hash}> /RunGlyphCounts [1] /RunDecorations [0] >> BDC`,
      'BT',
      '/M0R_0123456789abcdef_0 12 Tf',
      '1 0 0 1 10 20 Tm',
      '<> Tj',
      'ET',
      'EMC',
      'Q',
    ])).toBeNull();
  });
});
