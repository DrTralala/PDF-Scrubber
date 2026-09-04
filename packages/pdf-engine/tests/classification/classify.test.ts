import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { analysePage } from '../../src/analysis/analyse-page';
import {
  classifyBaseline,
  classifyReplacement,
  type ReplacementFontEvidence,
} from '../../src/classification/classify';
import type {
  AnalysedSpan,
  Capability,
  CapabilityReason,
} from '../../src/model';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import { ObjectStore } from '../../src/pdf/object-store';

const READ_ONLY_REASONS: readonly CapabilityReason[] = [
  'replacementOverflow',
  'ambiguousTransform',
  'sharedResource',
  'outlinedText',
  'scannedContent',
  'fontEmbeddingProhibited',
  'unsupportedOperator',
  'malformedContent',
];

function capability(kind: Capability['kind'], reasons: readonly CapabilityReason[]): Capability {
  return Object.freeze({ kind, reasons: Object.freeze([...reasons]) });
}

function span(overrides: Partial<AnalysedSpan> = {}): AnalysedSpan {
  return Object.freeze({
    address: Object.freeze({
      pageRef: Object.freeze({ objectNumber: 1, generationNumber: 0 }),
      streamPath: Object.freeze([
        Object.freeze({
          kind: 'pageContents' as const,
          ref: Object.freeze({ objectNumber: 2, generationNumber: 0 }),
          resourceName: null,
        }),
      ]),
      operatorRange: Object.freeze({ start: 4, end: 5 }),
      glyphRange: Object.freeze({ start: 0, end: 2 }),
    }),
    unicode: 'AB',
    bounds: Object.freeze({ x: 10, y: 20, width: 20, height: 10 }),
    baseline: Object.freeze([10, 20]) as readonly [number, number],
    styleKey: 'F0|12|1',
    style: Object.freeze({
      fontResourceName: 'F0',
      fontBaseName: 'Helvetica',
      fontSize: 12,
      horizontalScaling: 1,
      characterSpacing: 0,
      wordSpacing: 0,
      rise: 0,
      renderingMode: 0,
      fillColour: Object.freeze({
        colourSpace: 'DeviceGray' as const,
        components: Object.freeze([0]),
      }),
      strokeColour: Object.freeze({
        colourSpace: 'DeviceGray' as const,
        components: Object.freeze([0]),
      }),
      fontWeight: 400,
      italicAngle: 0,
    }),
    fontSize: 12,
    horizontalScaling: 1,
    glyphs: Object.freeze([
      Object.freeze({
        glyphIndex: 0,
        sourceCodeStart: 0,
        sourceCodeEnd: 1,
        sourceCode: 65,
        glyphId: 65,
        unicode: 'A',
        advance: 10,
        sourceTextGapBefore: null,
        source: Object.freeze({
          pageRef: Object.freeze({ objectNumber: 1, generationNumber: 0 }),
          streamPath: Object.freeze([
            Object.freeze({
              kind: 'pageContents' as const,
              ref: Object.freeze({ objectNumber: 2, generationNumber: 0 }),
              resourceName: null,
            }),
          ]),
          operatorIndex: 4,
          glyphIndex: 0,
          sourceCodeRange: Object.freeze({ start: 0, end: 1 }),
        }),
        mutationAddress: Object.freeze({
          pageRef: Object.freeze({ objectNumber: 1, generationNumber: 0 }),
          streamPath: Object.freeze([
            Object.freeze({
              kind: 'pageContents' as const,
              ref: Object.freeze({ objectNumber: 2, generationNumber: 0 }),
              resourceName: null,
            }),
          ]),
          operatorRange: Object.freeze({ start: 4, end: 5 }),
          glyphRange: Object.freeze({ start: 0, end: 1 }),
        }),
        bounds: Object.freeze({ x: 10, y: 20, width: 10, height: 10 }),
        baseline: Object.freeze([10, 20]) as readonly [number, number],
        styleKey: 'F0|12|1',
        style: Object.freeze({
          fontResourceName: 'F0', fontBaseName: 'Helvetica', fontSize: 12,
          horizontalScaling: 1, characterSpacing: 0, wordSpacing: 0, rise: 0,
          renderingMode: 0,
          fillColour: Object.freeze({ colourSpace: 'DeviceGray' as const, components: Object.freeze([0]) }),
          strokeColour: Object.freeze({ colourSpace: 'DeviceGray' as const, components: Object.freeze([0]) }),
          fontWeight: 400, italicAngle: 0,
        }),
        decorations: Object.freeze({ underline: false, strikethrough: false }),
      }),
      Object.freeze({
        glyphIndex: 1,
        sourceCodeStart: 1,
        sourceCodeEnd: 2,
        sourceCode: 66,
        glyphId: 66,
        unicode: 'B',
        advance: 10,
        sourceTextGapBefore: null,
        source: Object.freeze({
          pageRef: Object.freeze({ objectNumber: 1, generationNumber: 0 }),
          streamPath: Object.freeze([
            Object.freeze({
              kind: 'pageContents' as const,
              ref: Object.freeze({ objectNumber: 2, generationNumber: 0 }),
              resourceName: null,
            }),
          ]),
          operatorIndex: 4,
          glyphIndex: 1,
          sourceCodeRange: Object.freeze({ start: 1, end: 2 }),
        }),
        mutationAddress: Object.freeze({
          pageRef: Object.freeze({ objectNumber: 1, generationNumber: 0 }),
          streamPath: Object.freeze([
            Object.freeze({
              kind: 'pageContents' as const,
              ref: Object.freeze({ objectNumber: 2, generationNumber: 0 }),
              resourceName: null,
            }),
          ]),
          operatorRange: Object.freeze({ start: 4, end: 5 }),
          glyphRange: Object.freeze({ start: 1, end: 2 }),
        }),
        bounds: Object.freeze({ x: 20, y: 20, width: 10, height: 10 }),
        baseline: Object.freeze([20, 20]) as readonly [number, number],
        styleKey: 'F0|12|1',
        style: Object.freeze({
          fontResourceName: 'F0', fontBaseName: 'Helvetica', fontSize: 12,
          horizontalScaling: 1, characterSpacing: 0, wordSpacing: 0, rise: 0,
          renderingMode: 0,
          fillColour: Object.freeze({ colourSpace: 'DeviceGray' as const, components: Object.freeze([0]) }),
          strokeColour: Object.freeze({ colourSpace: 'DeviceGray' as const, components: Object.freeze([0]) }),
          fontWeight: 400, italicAngle: 0,
        }),
        decorations: Object.freeze({ underline: false, strikethrough: false }),
      }),
    ]),
    textMatrix: Object.freeze([1, 0, 0, 1, 10, 20]) as readonly [
      number, number, number, number, number, number,
    ],
    renderMatrix: Object.freeze([1, 0, 0, 1, 10, 20]) as readonly [
      number, number, number, number, number, number,
    ],
    resource: Object.freeze({
      fontResourceName: 'F0',
      fontBaseName: 'Helvetica',
      fontSubtype: 'Type1',
      fontEmbedded: false,
      writingMode: 0 as const,
      referenceCount: 1,
      fontWeight: 400,
      italicAngle: 0,
    }),
    capability: capability('safeReplacement', ['supportedExistingFont']),
    ...overrides,
  });
}

function fonts(overrides: Partial<ReplacementFontEvidence> = {}): ReplacementFontEvidence {
  return Object.freeze({
    existingFontCanEncode: true,
    substituteFontAvailable: true,
    substituteFontEmbeddable: true,
    replacementBounds: Object.freeze({ x: 10, y: 20, width: 18, height: 10 }),
    acceptSubstitution: false,
    ...overrides,
  });
}

describe('classifyBaseline', () => {
  test('classifies supported, uniquely owned horizontal text without replacement assumptions', () => {
    expect(classifyBaseline(span())).toEqual({
      kind: 'safeReplacement',
      reasons: ['supportedExistingFont'],
    });
  });

  test('classifies a shared Form as read-only before font rules', () => {
    const input = span({
      resource: Object.freeze({ ...span().resource, referenceCount: 2 }),
      unicode: null,
    });

    expect(classifyBaseline(input)).toEqual({
      kind: 'readOnly',
      reasons: ['unsupportedEncoding', 'sharedResource'],
    });
  });

  test('classifies vertical writing as read-only', () => {
    const input = span({
      resource: Object.freeze({ ...span().resource, writingMode: 1 }),
    });
    expect(classifyBaseline(input)).toEqual({
      kind: 'readOnly',
      reasons: ['unsupportedEncoding'],
    });
  });

  test('does not assume an embedded Type0 subset can encode an unknown replacement', () => {
    const input = span({
      resource: Object.freeze({
        ...span().resource,
        fontBaseName: 'M0Subset',
        fontSubtype: 'Type0',
        fontEmbedded: true,
      }),
    });
    expect(classifyBaseline(input)).toEqual({
      kind: 'replacementWithSubstitution',
      reasons: ['substituteFontRequired'],
    });
  });

  test('allows substitution for missing Unicode only when exact operator excision is provable', () => {
    const withoutUnicode = span({
      unicode: null,
      glyphs: Object.freeze(span().glyphs.map((glyph) => Object.freeze({
        ...glyph,
        unicode: null,
      }))),
    });
    expect(classifyBaseline(withoutUnicode)).toEqual({
      kind: 'replacementWithSubstitution',
      reasons: ['substituteFontRequired', 'unsupportedEncoding'],
    });

    const incompleteEvidence = span({
      unicode: null,
      glyphs: Object.freeze([
        withoutUnicode.glyphs[0]!,
        Object.freeze({ ...withoutUnicode.glyphs[1]!, sourceCodeStart: 2 }),
      ]),
    });
    expect(classifyBaseline(incompleteEvidence)).toEqual({
      kind: 'readOnly',
      reasons: ['unsupportedEncoding'],
    });
  });

  test.each(READ_ONLY_REASONS)(
    'never upgrades inherited read-only reason %s',
    (reason) => {
      expect(classifyBaseline(span({
        capability: capability('readOnly', [reason]),
      }))).toEqual({ kind: 'readOnly', reasons: [reason] });
    },
  );

  test.each([
    ['01-simple-tj', 'safeReplacement', ['supportedExistingFont']],
    ['06-subset-font', 'replacementWithSubstitution', ['substituteFontRequired']],
    ['18-shared-form-xobject', 'readOnly', ['sharedResource']],
    ['19-custom-encoding', 'replacementWithSubstitution', ['substituteFontRequired']],
    [
      '20-missing-tounicode',
      'replacementWithSubstitution',
      ['substituteFontRequired', 'unsupportedEncoding'],
    ],
    ['21-incorrect-tounicode', 'replacementWithSubstitution', ['substituteFontRequired']],
  ] as const)(
    'publishes the final baseline classification from analysis for %s',
    async (id, kind, expectedReasons) => {
      const bytes = await readFile(resolve('fixtures/generated', `${id}.pdf`));
      const store = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
      const analysed = await analysePage(store, 0);

      expect(analysed.spans[0]?.capability).toEqual({ kind, reasons: expectedReasons });
    },
  );
});

describe('classifyReplacement', () => {
  test('normalises replacement text and reports safe existing-font replacement', () => {
    expect(classifyReplacement(span(), 'A\u0301', fonts())).toEqual({
      kind: 'safeReplacement',
      reasons: ['supportedExistingFont'],
      normalisedReplacement: 'Á',
      canApply: true,
      substitutionAccepted: false,
    });
  });

  test('requires explicit acceptance for an embeddable Noto substitution', () => {
    const evidence = fonts({ existingFontCanEncode: false });
    expect(classifyReplacement(span(), 'سلام', evidence)).toEqual({
      kind: 'replacementWithSubstitution',
      reasons: ['substituteFontRequired'],
      normalisedReplacement: 'سلام',
      canApply: false,
      substitutionAccepted: false,
    });
    expect(classifyReplacement(span(), 'سلام', {
      ...evidence,
      acceptSubstitution: true,
    })).toEqual({
      kind: 'replacementWithSubstitution',
      reasons: ['substituteFontRequired'],
      normalisedReplacement: 'سلام',
      canApply: true,
      substitutionAccepted: true,
    });
  });

  test('reports overflow before mutation and prohibits apply', () => {
    expect(classifyReplacement(span(), 'Too wide', fonts({
      replacementBounds: Object.freeze({ x: 10, y: 20, width: 21, height: 10 }),
    }))).toEqual({
      kind: 'readOnly',
      reasons: ['replacementOverflow'],
      normalisedReplacement: 'Too wide',
      canApply: false,
      substitutionAccepted: false,
    });
  });

  test('reports prohibited embedding and unavailable replacement fonts deterministically', () => {
    expect(classifyReplacement(span(), 'Ω', fonts({
      existingFontCanEncode: false,
      substituteFontEmbeddable: false,
    }))).toMatchObject({
      kind: 'readOnly',
      reasons: ['fontEmbeddingProhibited'],
      canApply: false,
    });
    expect(classifyReplacement(span(), 'Ω', fonts({
      existingFontCanEncode: false,
      substituteFontAvailable: false,
    }))).toMatchObject({
      kind: 'readOnly',
      reasons: ['unsupportedEncoding'],
      canApply: false,
    });
  });

  test('cannot override a read-only baseline and returns sorted stable reasons', () => {
    const readonly = span({
      capability: capability('readOnly', ['malformedContent', 'outlinedText']),
    });
    const first = classifyReplacement(readonly, 'Edited', fonts({
      existingFontCanEncode: false,
      acceptSubstitution: true,
    }));
    const second = classifyReplacement(readonly, 'Edited', fonts({
      existingFontCanEncode: false,
      acceptSubstitution: true,
    }));

    expect(first).toEqual({
      kind: 'readOnly',
      reasons: ['outlinedText', 'malformedContent'],
      normalisedReplacement: 'Edited',
      canApply: false,
      substitutionAccepted: true,
    });
    expect(second).toEqual(first);
  });
});
