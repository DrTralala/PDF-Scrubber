import { describe, expect, test } from 'vitest';

import {
  deriveVisualThresholds,
  evaluateGate,
  evaluateM0Gate,
  type M0CaseResult,
} from '../../src/report/results';
import { CORPUS } from '../../src/corpus/manifest';
import { serialiseResults } from '../../src/report/write-report';

const COMPLETE_EVIDENCE = Object.freeze({
  trueRemoval: true,
  extractableRedraw: true,
  uneditedRegionFidelity: true,
  independentRendering: true,
  deterministicOutput: true,
  atomicFailure: true,
  failureClosed: false,
  pdfjs: Object.freeze({
    extractionValid: true,
    renderHash: 'a'.repeat(64),
    uneditedMismatchRatio: 0,
    uneditedSsim: 1,
  }),
  poppler: Object.freeze({
    extractionValid: true,
    renderHash: 'b'.repeat(64),
    uneditedMismatchRatio: 0,
    uneditedSsim: 1,
  }),
});

function safeResult(overrides: Partial<M0CaseResult> = {}): M0CaseResult {
  return {
    id: '01-simple-tj',
    fixtureSha256: 'c'.repeat(64),
    expected: Object.freeze({ kind: 'capability', capability: 'safeReplacement' }),
    observed: Object.freeze({ kind: 'capability', capability: 'safeReplacement', reasons: [] }),
    disclosures: Object.freeze([]),
    evidence: COMPLETE_EVIDENCE,
    durationBucketMs: 1_000,
    peakDecodedBytes: 128,
    candidateSha256: 'd'.repeat(64),
    status: 'pass',
    ...overrides,
  };
}

describe('M0 report gate', () => {
  test('missing Poppler evidence is a NO_GO rather than a skip', () => {
    const result = safeResult({
      evidence: Object.freeze({ ...COMPLETE_EVIDENCE, poppler: null }),
    });

    expect(evaluateGate([result])).toEqual({
      decision: 'NO_GO',
      reasons: ['missing-independent-validation'],
    });
  });

  test('complete safe and fail-closed unsupported evidence produces GO', () => {
    const unsupported: M0CaseResult = {
      ...safeResult(),
      id: '18-shared-form-xobject',
      expected: Object.freeze({
        kind: 'capability',
        capability: 'readOnly',
        reason: 'sharedResource',
      }),
      observed: Object.freeze({
        kind: 'capability',
        capability: 'readOnly',
        reasons: Object.freeze(['sharedResource'] as const),
      }),
      evidence: Object.freeze({
        ...COMPLETE_EVIDENCE,
        trueRemoval: false,
        extractableRedraw: false,
        uneditedRegionFidelity: false,
        independentRendering: false,
        deterministicOutput: false,
        failureClosed: true,
        pdfjs: null,
        poppler: null,
      }),
      candidateSha256: null,
    };

    expect(evaluateGate([safeResult(), unsupported])).toEqual({
      decision: 'GO',
      reasons: [],
    });
  });

  test('a category mismatch and non-atomic rejection are reported deterministically', () => {
    const result = safeResult({
      expected: Object.freeze({ kind: 'rejected', error: 'RESOURCE_LIMIT' }),
      observed: Object.freeze({ kind: 'rejected', error: 'MALFORMED_INPUT' }),
      evidence: Object.freeze({
        ...COMPLETE_EVIDENCE,
        trueRemoval: false,
        extractableRedraw: false,
        uneditedRegionFidelity: false,
        independentRendering: false,
        deterministicOutput: false,
        atomicFailure: false,
        failureClosed: false,
        pdfjs: null,
        poppler: null,
      }),
      candidateSha256: null,
      status: 'fail',
    });

    expect(evaluateGate([result])).toEqual({
      decision: 'NO_GO',
      reasons: [
        'unexpected-outcome:01-simple-tj',
        'non-atomic-failure:01-simple-tj',
        'failure-not-closed:01-simple-tj',
        'case-failed:01-simple-tj',
      ],
    });
  });
});

describe('visual threshold derivation', () => {
  test('publishes the smallest separating mismatch and structural thresholds', () => {
    const thresholds = deriveVisualThresholds([
      { renderer: 'pdfjs', accepted: true, mismatchRatio: 0, ssim: 1 },
      { renderer: 'pdfjs', accepted: true, mismatchRatio: 0.000002, ssim: 0.99999 },
      { renderer: 'pdfjs', accepted: false, mismatchRatio: 0.02, ssim: 0.95 },
      { renderer: 'poppler', accepted: true, mismatchRatio: 0.00001, ssim: 0.9999 },
      { renderer: 'poppler', accepted: false, mismatchRatio: 0.03, ssim: 0.94 },
    ]);

    expect(thresholds.pdfjs).toMatchObject({
      acceptedMaximumMismatchRatio: 0.000002,
      mismatchRatioThreshold: 0.000003,
      acceptedMinimumSsim: 0.99999,
      ssimThreshold: 0.999989,
      separatesPerturbation: true,
    });
    expect(thresholds.poppler.separatesPerturbation).toBe(true);
  });

  test('marks the threshold unusable when no accepted/perturbed separation exists', () => {
    const thresholds = deriveVisualThresholds([
      { renderer: 'pdfjs', accepted: true, mismatchRatio: 0.02, ssim: 0.95 },
      { renderer: 'pdfjs', accepted: false, mismatchRatio: 0.01, ssim: 0.96 },
    ]);

    expect(thresholds.pdfjs.separatesPerturbation).toBe(false);
  });
});

test('complete M0 gate rejects missing corpus and non-separating renderer evidence', () => {
  const thresholds = deriveVisualThresholds([
    { renderer: 'pdfjs', accepted: true, mismatchRatio: 0.02, ssim: 0.95 },
    { renderer: 'pdfjs', accepted: false, mismatchRatio: 0.01, ssim: 0.96 },
    { renderer: 'poppler', accepted: true, mismatchRatio: 0, ssim: 1 },
    { renderer: 'poppler', accepted: false, mismatchRatio: 0.01, ssim: 0.9 },
  ]);

  expect(evaluateM0Gate([safeResult()], CORPUS.map(({ id }) => id), thresholds)).toEqual({
    decision: 'NO_GO',
    reasons: [
      'missing-case:02-kerned-tj-array',
      'missing-case:03-single-quote',
      'missing-case:04-double-quote',
      'missing-case:05-spacing-rise-scale',
      'missing-case:06-subset-font',
      'missing-case:07-ligature',
      'missing-case:08-combining-marks',
      'missing-case:09-bidirectional',
      'missing-case:10-vertical-writing',
      'missing-case:11-rotate-90',
      'missing-case:12-rotate-180',
      'missing-case:13-rotate-270',
      'missing-case:14-crop-nonzero-origin',
      'missing-case:15-user-unit',
      'missing-case:16-form-xobject',
      'missing-case:17-nested-form-xobject',
      'missing-case:18-shared-form-xobject',
      'missing-case:19-custom-encoding',
      'missing-case:20-missing-tounicode',
      'missing-case:21-incorrect-tounicode',
      'missing-case:22-tagged-pdfua-marker',
      'missing-case:23-pdfa-marker',
      'missing-case:24-signature-marker',
      'missing-case:25-encryption-marker',
      'missing-case:26-malformed-stream',
      'missing-case:27-decompression-abuse',
      'missing-case:28-added-text-control',
      'missing-case:29-added-image-control',
      'missing-case:30-wkhtmltopdf-rich-line',
      'visual-threshold-not-separated:pdfjs',
    ],
  });
});

test('complete M0 gate rejects a missing image-pixel resource sweep', () => {
  const thresholds = deriveVisualThresholds([
    { renderer: 'pdfjs', accepted: true, mismatchRatio: 0, ssim: 1 },
    { renderer: 'pdfjs', accepted: false, mismatchRatio: 0.01, ssim: 0.9 },
    { renderer: 'poppler', accepted: true, mismatchRatio: 0, ssim: 1 },
    { renderer: 'poppler', accepted: false, mismatchRatio: 0.01, ssim: 0.9 },
  ]);
  const sweep = (limit: 'maxFileBytes' | 'maxObjects' | 'maxNestingDepth'
    | 'maxDecodedStreamBytes' | 'maxOperationsPerStream') => Object.freeze({
    limit,
    unit: 'bytes' as const,
    testedValues: Object.freeze([1, 2, 3]),
    largestPassing: 2,
    smallestRejected: 3,
    repeatedChromiumRuns: 3 as const,
    safetyMargin: 0.25,
  });

  expect(evaluateM0Gate(
    [safeResult()],
    ['01-simple-tj'],
    thresholds,
    [
      sweep('maxFileBytes'),
      sweep('maxObjects'),
      sweep('maxNestingDepth'),
      sweep('maxDecodedStreamBytes'),
      sweep('maxOperationsPerStream'),
    ],
  )).toEqual({
    decision: 'NO_GO',
    reasons: ['missing-resource-sweep:maxImagePixels'],
  });
});

test('report JSON serialisation is byte-stable and strips raw image bytes', () => {
  const report = {
    schemaVersion: 1 as const,
    decision: Object.freeze({ decision: 'GO' as const, reasons: Object.freeze([]) }),
    environment: Object.freeze({ node: '25.9.0', chromium: '151.0.7922.34', poppler: '21.01.0' }),
    dependencies: Object.freeze({ 'pdf-lib': '1.17.1' }),
    cases: Object.freeze([safeResult()]),
    resourceLimits: Object.freeze({
      maxFileBytes: 1024,
      maxObjects: 100,
      maxNestingDepth: 8,
      maxDecodedStreamBytes: 2048,
      maxOperationsPerStream: 1000,
      maxImagePixels: 1_000_000,
      maxProcessingMs: 1000,
    }),
    resourceSweeps: Object.freeze([]),
    visualThresholds: deriveVisualThresholds([
      { renderer: 'pdfjs', accepted: true, mismatchRatio: 0, ssim: 1 },
      { renderer: 'pdfjs', accepted: false, mismatchRatio: 0.01, ssim: 0.9 },
    ]),
    licences: Object.freeze(['MIT', 'Apache-2.0', 'OFL-1.1']),
    excludedDependencies: Object.freeze(['MuPDF: AGPL-3.0-or-later']),
  };

  expect(serialiseResults(report)).toBe(serialiseResults(structuredClone(report)));
  expect(serialiseResults(report)).not.toContain('rgba');
});
