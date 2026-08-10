import { describe, expect, test } from 'vitest';

import {
  LEGACY_MARKED_CONTENT_TAG,
  PDF_SCRUBBER_MARKED_CONTENT_TAG,
} from '../../src/content/brand-markers';
import { parseControlledRedraw } from '../../src/content/controlled-redraw';
import { tokeniseContentStream } from '../../src/content/tokeniser';
import { PROVISIONAL_LIMITS } from '../../src/limits';

const encoder = new TextEncoder();

describe('controlled redraw v2', () => {
  test('recognises a versioned multi-font redraw and binds each text operation to its font', () => {
    const operations = tokeniseContentStream(encoder.encode([
      'q',
       `/${PDF_SCRUBBER_MARKED_CONTENT_TAG} << /Version 2 /ActualText <FEFF00410042> /CommandHash <0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF> >> BDC`,
      'BT',
      '/M0R_0123456789abcdef_0 12 Tf',
      '1 0 0 1 10 20 Tm',
      '<0001> Tj',
      '/M0R_0123456789abcdef_1 12 Tf',
      '1 0 0 1 17 20 Tm',
      '<0001> Tj',
      'ET',
      'EMC',
      'Q',
      '',
    ].join('\n')), PROVISIONAL_LIMITS);

    expect(parseControlledRedraw(operations)).toEqual({
      version: 2,
      actualText: 'AB',
      commandHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      fontResourceNames: [
        'M0R_0123456789abcdef_0',
        'M0R_0123456789abcdef_1',
      ],
      textOperationIndexes: [5, 8],
      textFontResourceNames: [
        'M0R_0123456789abcdef_0',
        'M0R_0123456789abcdef_1',
      ],
      runGlyphCounts: null,
      runDecorations: null,
      textRunIndexes: null,
      decorationOperationIndexes: [],
    });
  });

  test('recognises a legacy marked-content tag', () => {
    const operations = tokeniseContentStream(encoder.encode([
      'q',
      `/${LEGACY_MARKED_CONTENT_TAG} << /Version 2 /ActualText <FEFF0041> /CommandHash <0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF> >> BDC`,
      'BT',
      '/M0R_0123456789abcdef_0 12 Tf',
      '1 0 0 1 10 20 Tm',
      '<0001> Tj',
      'ET',
      'EMC',
      'Q',
    ].join('\n')), PROVISIONAL_LIMITS);

    expect(parseControlledRedraw(operations)).toMatchObject({
      version: 2,
      actualText: 'A',
    });
  });

  test('rejects a v2 redraw whose text-showing operation has no active controlled font', () => {
    const operations = tokeniseContentStream(encoder.encode([
      'q',
       `/${PDF_SCRUBBER_MARKED_CONTENT_TAG} << /Version 2 /ActualText <FEFF0041> /CommandHash <0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF> >> BDC`,
      'BT',
      '1 0 0 1 10 20 Tm',
      '<0001> Tj',
      'ET',
      'EMC',
      'Q',
    ].join('\n')), PROVISIONAL_LIMITS);

    expect(parseControlledRedraw(operations)).toBeNull();
  });

  test('rejects an empty glyph operand', () => {
    const operations = tokeniseContentStream(encoder.encode([
      'q',
       `/${PDF_SCRUBBER_MARKED_CONTENT_TAG} << /Version 2 /ActualText <FEFF0041> /CommandHash <0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF> >> BDC`,
      'BT',
      '/M0R_0123456789abcdef_0 12 Tf',
      '1 0 0 1 10 20 Tm',
      '<> Tj',
      'ET',
      'EMC',
      'Q',
    ].join('\n')), PROVISIONAL_LIMITS);

    expect(parseControlledRedraw(operations)).toBeNull();
  });
});
