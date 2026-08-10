import type {
  AssetProvenance,
  CorpusCase,
  CorpusClass,
  DisclosureCode,
  ExpectedBaseline,
  EligibleTextExpectation,
} from './types';

const NOTO_SANS: AssetProvenance = Object.freeze({
  package: '@fontsource/noto-sans',
  version: '5.3.0',
  licence: 'OFL-1.1',
});

const NOTO_SANS_ARABIC: AssetProvenance = Object.freeze({
  package: '@fontsource/noto-sans-arabic',
  version: '5.3.0',
  licence: 'OFL-1.1',
});

type CaseOptions = Readonly<{
  expected?: ExpectedBaseline;
  disclosures?: readonly DisclosureCode[];
  usesNoto?: boolean;
  asset?: AssetProvenance;
  target?: string;
  replacement?: string;
  eligibleText?: EligibleTextExpectation;
}>;

function corpusCase(
  id: string,
  classes: readonly CorpusClass[],
  options: CaseOptions = {},
): CorpusCase {
  const sequence = id.slice(0, 2);
  return Object.freeze({
    id,
    source: 'synthetic',
    generatorVersion: 1,
    classes: Object.freeze([...classes]),
    targetPage: 0,
    targetUnicode: options.target ?? `Target ${sequence}`,
    replacementUnicode: options.replacement ?? `Edited ${sequence}`,
    expected:
      options.expected ??
      ({ kind: 'capability', capability: 'safeReplacement' } as const),
    expectedDisclosureCodes: Object.freeze([...(options.disclosures ?? [])]),
    assets: Object.freeze(options.asset === undefined
      ? options.usesNoto ? [NOTO_SANS] : []
      : [options.asset]),
    ...(options.eligibleText === undefined
      ? {}
      : { eligibleText: Object.freeze(options.eligibleText) }),
  });
}

const SUBSTITUTE: ExpectedBaseline = Object.freeze({
  kind: 'capability',
  capability: 'replacementWithSubstitution',
});

export const CORPUS: readonly CorpusCase[] = Object.freeze([
  corpusCase('01-simple-tj', ['tj']),
  corpusCase('02-kerned-tj-array', ['tjArray']),
  corpusCase('03-single-quote', ['singleQuote']),
  corpusCase('04-double-quote', ['doubleQuote']),
  corpusCase('05-spacing-rise-scale', ['textState']),
  corpusCase('06-subset-font', ['subsetFont'], {
    expected: SUBSTITUTE,
    usesNoto: true,
  }),
  corpusCase('07-ligature', ['ligature'], {
    expected: SUBSTITUTE,
    usesNoto: true,
    target: 'office',
    replacement: 'affinity',
  }),
  corpusCase('08-combining-marks', ['combiningMarks'], {
    expected: SUBSTITUTE,
    usesNoto: true,
    target: 'Café 08',
    replacement: 'Résumé 08',
  }),
  corpusCase('09-bidirectional', ['bidirectional'], {
    expected: SUBSTITUTE,
    asset: NOTO_SANS_ARABIC,
    target: 'العربية ٠٩',
    replacement: 'إيصال ٠٩',
  }),
  corpusCase('10-vertical-writing', ['verticalWriting'], {
    expected: {
      kind: 'capability',
      capability: 'readOnly',
      reason: 'unsupportedEncoding',
    },
    usesNoto: true,
    target: 'Vertical 10',
  }),
  corpusCase('11-rotate-90', ['rotation']),
  corpusCase('12-rotate-180', ['rotation']),
  corpusCase('13-rotate-270', ['rotation']),
  corpusCase('14-crop-nonzero-origin', ['cropBox']),
  corpusCase('15-user-unit', ['userUnit']),
  corpusCase('16-form-xobject', ['formXObject']),
  corpusCase('17-nested-form-xobject', ['nestedFormXObject']),
  corpusCase('18-shared-form-xobject', ['sharedFormXObject'], {
    expected: {
      kind: 'capability',
      capability: 'readOnly',
      reason: 'sharedResource',
    },
  }),
  corpusCase('19-custom-encoding', ['customEncoding'], {
    expected: SUBSTITUTE,
  }),
  corpusCase('20-missing-tounicode', ['missingToUnicode'], {
    expected: SUBSTITUTE,
  }),
  corpusCase('21-incorrect-tounicode', ['incorrectToUnicode'], {
    expected: SUBSTITUTE,
  }),
  corpusCase('22-tagged-pdfua-marker', ['pdfUaMarker'], {
    disclosures: ['PDF_UA'],
  }),
  corpusCase('23-pdfa-marker', ['pdfAMarker'], {
    disclosures: ['PDF_A'],
  }),
  corpusCase('24-signature-marker', ['signatureMarker'], {
    disclosures: ['SIGNATURE'],
  }),
  corpusCase('25-encryption-marker', ['encryptionMarker'], {
    expected: { kind: 'rejected', error: 'UNSUPPORTED_DOCUMENT' },
  }),
  corpusCase('26-malformed-stream', ['malformedStream'], {
    expected: { kind: 'rejected', error: 'MALFORMED_INPUT' },
  }),
  corpusCase('27-decompression-abuse', ['decompressionAbuse'], {
    expected: { kind: 'rejected', error: 'RESOURCE_LIMIT' },
  }),
  corpusCase('28-added-text-control', ['addedTextControl'], {
    expected: { kind: 'crossConsumerControl' },
    usesNoto: true,
  }),
  corpusCase('29-added-image-control', ['addedImageControl'], {
    expected: { kind: 'crossConsumerControl' },
  }),
  corpusCase('30-wkhtmltopdf-rich-line', ['wkhtmltopdfRichLine'], {
    expected: SUBSTITUTE,
    usesNoto: true,
    target: 'Customer Name:',
    replacement: 'Account Name:',
    eligibleText: {
      sourceGlyphCount: 50,
      groups: [
        { text: 'Shopee', styleRunCount: 1, replacementRuns: ['Store'] },
        { text: 'Customer Name:', styleRunCount: 1, replacementRuns: ['Account Name:'] },
        { text: 'Alex Morgan', styleRunCount: 1, replacementRuns: ['Alex Moreno'] },
        {
          text: 'this is a bold text',
          styleRunCount: 3,
          replacementRuns: ['this is a ', 'firm', ' text'],
        },
      ],
      excludedGraphicCount: 1,
    },
  }),
]);
