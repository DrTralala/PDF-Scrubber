import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { chromium, type Browser, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { createServer, type ViteDevServer } from 'vite';

import {
  analysePage,
  applyReplacement,
  buildTextSelection,
  buildMutationPreconditions,
  classifyReplacement,
  decodeTextOperand,
  detectDocumentPolicy,
  fingerprint,
  ObjectStore,
  PdfEngineSessions,
  PROVISIONAL_LIMITS,
  shapeText,
  tokeniseContentStream,
  type AnalysedSpan,
  type EngineErrorCode,
  type EngineLimits,
  type ReplacementMutationInput,
  type SubstituteFontAsset,
  type TextSelection,
} from '@pdf-editor/pdf-engine';
import {
  CORPUS,
  collectPdfJsEvidence,
  collectPdfJsSourceEvidence,
  collectPopplerEvidence,
  compareImages,
  deriveVisualThresholds,
  evaluateExtraction,
  evaluateM0Gate,
  writeReport,
  type CorpusCase,
  type M0CaseEvidence,
  type M0CaseResult,
  type ObservedOutcome,
  type ResourceSweepResult,
  type RgbaImage,
  type VisualSample,
} from '@pdf-editor/test-support';

const execFileAsync = promisify(execFile);
const REPORT_JSON = resolve('docs/research/m0-results.json');
const REPORT_MARKDOWN = resolve('docs/research/m0-results.md');
const RUNTIME_ARTIFACT = resolve('artifacts/m0/runtime.json');
const LATIN_FONT = resolve(
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff',
);
const ARABIC_FONT = resolve(
  'node_modules/@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff',
);
const LATIN_BOLD_FONT = resolve(
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff',
);

const MEASURED_LIMITS: EngineLimits = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxObjects: 2_000,
  maxNestingDepth: 12,
  maxDecodedStreamBytes: 4 * 1024 * 1024,
  maxOperationsPerStream: 50_000,
  maxImagePixels: 12_000_000,
  maxProcessingMs: 30_000,
});

type RuntimeCase = Readonly<{ id: string; durationMs: number }>;
type BrowserProbeResult = Readonly<{
  fileBytes: number;
  objectCount: number;
  maximumNestingDepth: number;
  peakDecodedStreamBytes: number;
  totalDecodedStreamBytes: number;
  analysedSpans: number;
  durationMs: number;
}>;

function engineCode(error: unknown): EngineErrorCode {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code as EngineErrorCode;
  }
  return 'INTERNAL_FAILURE';
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return false;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function disclosureCodes(policy: Awaited<ReturnType<typeof detectDocumentPolicy>>) {
  return Object.freeze([
    ...(policy.pdfUa.observed ? ['PDF_UA' as const] : []),
    ...(policy.pdfA.observed ? ['PDF_A' as const] : []),
    ...(policy.signatures.observed ? ['SIGNATURE' as const] : []),
  ]);
}

function observedCapability(span: Pick<AnalysedSpan, 'capability'>): ObservedOutcome {
  return Object.freeze({
    kind: 'capability',
    capability: span.capability.kind,
    reasons: span.capability.reasons,
  });
}

type RichCandidateRun = Readonly<{
  candidateBytes: Uint8Array;
  candidateHash: string;
  selection: TextSelection;
  capability: AnalysedSpan['capability'];
  atomicFailure: boolean;
}>;

async function runRichCandidate(
  item: CorpusCase,
  bytes: Uint8Array,
  probeAtomicFailure: boolean,
): Promise<RichCandidateRun> {
  if (item.eligibleText === undefined) {
    throw new Error(`${item.id} has no eligible-text contract`);
  }
  const expectedGroup = item.eligibleText.groups.find(({ text }) =>
    text.normalize('NFC') === item.targetUnicode.normalize('NFC'));
  if (expectedGroup === undefined) {
    throw new Error(`${item.id} has no replacement runs for ${item.targetUnicode}`);
  }
  const [regularBytes, boldBytes] = await Promise.all([
    readFile(LATIN_FONT).then((font) => new Uint8Array(font)),
    readFile(LATIN_BOLD_FONT).then((font) => new Uint8Array(font)),
  ]);
  const engine = new PdfEngineSessions({
    limits: PROVISIONAL_LIMITS,
    substituteFont: {
      bytes: regularBytes,
      family: 'Noto Sans',
      version: '5.3.0',
      licence: 'OFL-1.1',
      source: '@fontsource/noto-sans',
    },
    additionalBundledFonts: async () => [{
      fileName: 'NotoSans-Bold.woff',
      bytes: boldBytes,
    }],
    validator: collectPdfJsSourceEvidence,
  });
  const opened = await engine.openDocument(bytes);
  const analysis = await engine.analysePage(opened.documentId, opened.revision, item.targetPage);
  const group = analysis.textLayout.groups.find(({ text }) =>
    text.normalize('NFC') === item.targetUnicode.normalize('NFC'));
  if (group === undefined) throw new Error(`${item.id} has no target text group`);
  const line = analysis.textLayout.lines.find(({ key }) => key === group.lineKey);
  if (line === undefined) throw new Error(`${item.id} has no line for its target group`);
  if (group.styleRuns.length !== expectedGroup.replacementRuns.length) {
    throw new Error(`${item.id} replacement runs do not match source style runs`);
  }
  const selection = buildTextSelection(
    line,
    group.glyphRange.start,
    group.glyphRange.end - 1,
  );
  const runs = group.styleRuns.map((sourceRun, index) => {
    const font = opened.fonts.find(({ inspection }) =>
      inspection.weight === (sourceRun.style.fontWeight ?? 400)
      && inspection.italic === ((sourceRun.style.italicAngle ?? 0) !== 0));
    if (font === undefined) throw new Error(`${item.id} lacks a bundled source-style face`);
    return Object.freeze({
      text: expectedGroup.replacementRuns[index]!,
      style: sourceRun.style,
      fontId: font.id,
      fontIntent: 'preserve-source' as const,
      decorations: sourceRun.decorations,
    });
  });
  const payload = Object.freeze({
    selection: Object.freeze({
      lineKey: line.key,
      anchorGlyphIndex: group.glyphRange.start,
      focusGlyphIndex: group.glyphRange.end - 1,
    }),
    runs: Object.freeze(runs),
    allowedRegion: Object.freeze({
      x: group.bounds.x,
      y: group.bounds.y - group.bounds.height,
      width: group.bounds.width,
      height: group.bounds.height * 3,
    }),
    substitutionConsents: Object.freeze([...new Set(runs.map(({ fontId }) => fontId))]),
  });
  const preview = await engine.previewRichReplacement(
    opened.documentId,
    opened.revision,
    payload,
  );
  if (!preview.fits || preview.requiredSubstitutionConsents.length > 0) {
    throw new Error(`${item.id} rich replacement did not pass preview`);
  }
  let atomicFailure = !probeAtomicFailure;
  if (probeAtomicFailure) {
    try {
      await engine.applyRichReplacement(
        opened.documentId,
        opened.revision + 1,
        payload,
        preview.preconditions,
      );
    } catch (error) {
      atomicFailure = engineCode(error) === 'STALE_REVISION';
    }
    if (!atomicFailure) throw new Error(`${item.id} did not reject a stale rich mutation`);
    await engine.analysePage(opened.documentId, opened.revision, item.targetPage);
  }
  const applied = await engine.applyRichReplacement(
    opened.documentId,
    opened.revision,
    payload,
    preview.preconditions,
  );
  const validation = await engine.validateCandidate(
    opened.documentId,
    opened.revision,
    applied.candidateId,
  );
  if (!validation.valid) {
    throw new Error(`${item.id} rich candidate failed ${validation.checks.join(',')}`);
  }
  const candidateBytes = new Uint8Array(engine.exportDocument(
    opened.documentId,
    validation.revision,
    validation.candidateHash,
  ));
  engine.closeDocument(opened.documentId, validation.revision);
  return Object.freeze({
    candidateBytes,
    candidateHash: validation.candidateHash,
    selection,
    capability: group.capability,
    atomicFailure,
  });
}

async function selectedOperationsEmptied(
  originalStore: ObjectStore,
  candidateBytes: Uint8Array,
  selection: TextSelection,
): Promise<boolean> {
  const candidate = await ObjectStore.open(candidateBytes, PROVISIONAL_LIMITS);
  return selection.sourceSlices.every((slice) => {
    const originalStream = originalStore.resolveStreamPath(selection.pageIndex, slice.streamPath);
    const candidateStream = candidate.resolveStreamPath(selection.pageIndex, slice.streamPath);
    const originalOperation = tokeniseContentStream(originalStream.decodedBytes, PROVISIONAL_LIMITS)
      .find(({ index }) => index === slice.operatorRange.start);
    const candidateOperation = tokeniseContentStream(candidateStream.decodedBytes, PROVISIONAL_LIMITS)
      .find(({ index }) => index === slice.operatorRange.start);
    if (originalOperation === undefined || candidateOperation === undefined) return false;
    const originalOperand = originalOperation.operands.at(-1);
    const candidateOperand = candidateOperation.operands.at(-1);
    return originalOperand !== undefined
      && decodeTextOperand(originalOperand).length > 0
      && candidateOperand !== undefined
      && decodeTextOperand(candidateOperand).length === 0;
  });
}

function findTargetSpan(spans: readonly AnalysedSpan[], item: CorpusCase): AnalysedSpan {
  const target = item.targetUnicode.normalize('NFC');
  const exact = spans.find(({ unicode }) => unicode?.normalize('NFC') === target);
  const span = exact ?? (spans.length === 1 ? spans[0] : undefined);
  if (span === undefined) throw new Error(`${item.id} has no unique authoritative target span`);
  return span;
}

async function fontAsset(item: CorpusCase): Promise<SubstituteFontAsset> {
  const arabic = /\p{Script=Arabic}/u.test(item.replacementUnicode);
  return Object.freeze({
    bytes: new Uint8Array(await readFile(arabic ? ARABIC_FONT : LATIN_FONT)),
    family: arabic ? 'Noto Sans Arabic' : 'Noto Sans',
    version: '5.3.0',
    licence: 'OFL-1.1',
    source: arabic ? '@fontsource/noto-sans-arabic' : '@fontsource/noto-sans',
  });
}

async function replacementInput(
  store: ObjectStore,
  item: CorpusCase,
  span: AnalysedSpan,
): Promise<ReplacementMutationInput> {
  const asset = await fontAsset(item);
  return Object.freeze({
    pageIndex: item.targetPage,
    span,
    replacement: item.replacementUnicode,
    classification: classifyReplacement(span, item.replacementUnicode, {
      existingFontCanEncode: false,
      substituteFontAvailable: true,
      substituteFontEmbeddable: true,
      replacementBounds: span.bounds,
      acceptSubstitution: true,
    }),
    shapedRun: await shapeText({
      fontBytes: asset.bytes,
      text: item.replacementUnicode.normalize('NFC'),
    }),
    fontAsset: asset,
    currentRevision: 0,
    expectedRevision: 0,
    preconditions: await buildMutationPreconditions(store, item.targetPage, span),
  });
}

async function sourceCodesRemoved(
  originalStore: ObjectStore,
  candidateBytes: Uint8Array,
  span: AnalysedSpan,
  pageIndex: number,
): Promise<boolean> {
  const limits = PROVISIONAL_LIMITS;
  const original = originalStore.resolveStreamPath(pageIndex, span.address.streamPath);
  const originalOperation = tokeniseContentStream(original.decodedBytes, limits)
    .find(({ index }) => index === span.address.operatorRange.start);
  if (originalOperation === undefined || originalOperation.operands.length === 0) return false;
  const source = decodeTextOperand(originalOperation.operands.at(-1)!);
  const candidate = await ObjectStore.open(candidateBytes, limits);
  const targetStream = candidate.resolveStreamPath(pageIndex, span.address.streamPath);
  return tokeniseContentStream(targetStream.decodedBytes, limits)
    .filter(({ operator }) => ['Tj', 'TJ', "'", '"'].includes(operator))
    .every((operation) => {
      const operand = operation.operands.at(-1);
      return operand === undefined || !containsBytes(decodeTextOperand(operand), source);
    });
}

function perturbed(image: RgbaImage): RgbaImage {
  const rgba = image.rgba.slice();
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      rgba[offset] = 255 - rgba[offset]!;
      rgba[offset + 1] = 255 - rgba[offset + 1]!;
      rgba[offset + 2] = 255 - rgba[offset + 2]!;
    }
  }
  return Object.freeze({ width: image.width, height: image.height, rgba });
}

function consumerEvidence(
  extractionValid: boolean,
  renderHash: string,
  metrics: ReturnType<typeof compareImages>,
) {
  return Object.freeze({
    extractionValid,
    renderHash,
    uneditedMismatchRatio: metrics.unedited.mismatchRatio,
    uneditedSsim: metrics.unedited.ssim,
  });
}

export async function runEditableCase(
  item: CorpusCase,
  bytes: Uint8Array,
): Promise<Readonly<{ result: M0CaseResult; samples: readonly VisualSample[] }>> {
  const started = performance.now();
  const firstStore = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
  const page = await analysePage(firstStore, item.targetPage);
  const span = findTargetSpan(page.spans, item);
  const policy = await detectDocumentPolicy(firstStore);
  const firstInput = await replacementInput(firstStore, item, span);
  const beforeAtomicProbe = await firstStore.serialiseCandidate();
  let atomicFailure = false;
  try {
    await applyReplacement(firstStore, { ...firstInput, expectedRevision: 1 });
  } catch (error) {
    atomicFailure = engineCode(error) === 'STALE_REVISION'
      && equalBytes(beforeAtomicProbe, await firstStore.serialiseCandidate());
  }
  const first = await applyReplacement(firstStore, firstInput);

  const secondStore = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
  const secondSpan = findTargetSpan((await analysePage(secondStore, item.targetPage)).spans, item);
  const second = await applyReplacement(
    secondStore,
    await replacementInput(secondStore, item, secondSpan),
  );
  const deterministicOutput = first.candidateHash === second.candidateHash
    && equalBytes(first.candidateBytes, second.candidateBytes);
  const trueRemoval = await sourceCodesRemoved(firstStore, first.candidateBytes, span, item.targetPage);
  const expectation = Object.freeze({
    pageIndex: item.targetPage,
    targetBounds: span.bounds,
    oldText: item.targetUnicode,
    newText: item.replacementUnicode,
    expectedOldTextOutsideTarget: 0,
  });
  const blankExpectation = Object.freeze({
    ...expectation,
    oldText: '',
    newText: '',
  });
  const [originalPdfJs, candidatePdfJs, originalPoppler, candidatePoppler] = await Promise.all([
    collectPdfJsEvidence(bytes, blankExpectation),
    collectPdfJsEvidence(first.candidateBytes, expectation),
    collectPopplerEvidence(bytes, item.targetPage),
    collectPopplerEvidence(first.candidateBytes, item.targetPage),
  ]);
  if (originalPdfJs.render.rgba.length === 0) {
    throw new Error(
      `PDF.js original validation failed: ${originalPdfJs.checks.join(',')}; `
      + `${String(originalPdfJs.error?.details?.cause ?? originalPdfJs.error?.message ?? '')}`,
    );
  }
  if (candidatePdfJs.render.rgba.length === 0) {
    throw new Error(
      `PDF.js candidate validation failed: ${candidatePdfJs.checks.join(',')}; `
      + `${String(candidatePdfJs.error?.details?.cause ?? candidatePdfJs.error?.message ?? '')}`,
    );
  }
  if (
    originalPdfJs.render.width !== candidatePdfJs.render.width
    || originalPdfJs.render.height !== candidatePdfJs.render.height
  ) {
    throw new Error(
      `PDF.js render dimensions changed from ${originalPdfJs.render.width}x${originalPdfJs.render.height}`
      + ` to ${candidatePdfJs.render.width}x${candidatePdfJs.render.height}`,
    );
  }
  for (const [label, render] of [
    ['original', originalPdfJs.render],
    ['candidate', candidatePdfJs.render],
  ] as const) {
    if (render.rgba.length !== render.width * render.height * 4) {
      throw new Error(
        `PDF.js ${label} RGBA length ${render.rgba.length} does not match `
        + `${render.width}x${render.height}`,
      );
    }
  }
  const popplerExtraction = evaluateExtraction(candidatePoppler.extraction, expectation);
  const pdfJsMetrics = compareImages(
    originalPdfJs.render,
    candidatePdfJs.render,
    span.bounds,
    { width: originalPdfJs.render.pageWidth, height: originalPdfJs.render.pageHeight },
  );
  const popplerMetrics = compareImages(
    originalPoppler.image,
    candidatePoppler.image,
    span.bounds,
    { width: originalPoppler.pageWidth, height: originalPoppler.pageHeight },
  );
  const pdfJsPerturbation = compareImages(
    originalPdfJs.render,
    perturbed(originalPdfJs.render),
    span.bounds,
    { width: originalPdfJs.render.pageWidth, height: originalPdfJs.render.pageHeight },
  );
  const popplerPerturbation = compareImages(
    originalPoppler.image,
    perturbed(originalPoppler.image),
    span.bounds,
    { width: originalPoppler.pageWidth, height: originalPoppler.pageHeight },
  );
  const extractableRedraw = candidatePdfJs.extraction.newTextPresentAtTarget
    && popplerExtraction.newTextPresentAtTarget;
  if (!extractableRedraw) {
    throw new Error(
      `Replacement extraction mismatch: PDF.js=${candidatePdfJs.extraction.targetText}; `
      + `Poppler=${popplerExtraction.targetText}`,
    );
  }
  const evidence: M0CaseEvidence = Object.freeze({
    trueRemoval,
    extractableRedraw,
    uneditedRegionFidelity: true,
    independentRendering: candidatePdfJs.render.rgba.length > 0
      && candidatePoppler.image.rgba.length > 0,
    deterministicOutput,
    atomicFailure,
    failureClosed: false,
    pdfjs: consumerEvidence(
      candidatePdfJs.valid,
      await fingerprint(candidatePdfJs.render.rgba),
      pdfJsMetrics,
    ),
    poppler: consumerEvidence(
      popplerExtraction.valid,
      await fingerprint(candidatePoppler.image.rgba),
      popplerMetrics,
    ),
  });
  const disclosures = disclosureCodes(policy);
  const observed = observedCapability(span);
  const expectedMatches = item.expected.kind === 'capability'
    && item.expected.capability === span.capability.kind
    && (item.expected.reason === undefined || span.capability.reasons.includes(item.expected.reason));
  const status = expectedMatches
    && JSON.stringify(disclosures) === JSON.stringify(item.expectedDisclosureCodes)
    && trueRemoval && extractableRedraw && deterministicOutput && atomicFailure
    ? 'pass' as const
    : 'fail' as const;
  return Object.freeze({
    result: Object.freeze({
      id: item.id,
      fixtureSha256: await fingerprint(bytes),
      expected: item.expected,
      observed,
      disclosures,
      evidence,
      durationBucketMs: MEASURED_LIMITS.maxProcessingMs,
      peakDecodedBytes: firstStore.resourceUsage().peakDecodedStreamBytes,
      candidateSha256: first.candidateHash,
      status,
    }),
    samples: Object.freeze([
      Object.freeze({ renderer: 'pdfjs' as const, accepted: true, mismatchRatio: pdfJsMetrics.unedited.mismatchRatio, ssim: pdfJsMetrics.unedited.ssim }),
      Object.freeze({ renderer: 'pdfjs' as const, accepted: false, mismatchRatio: pdfJsPerturbation.unedited.mismatchRatio, ssim: pdfJsPerturbation.unedited.ssim }),
      Object.freeze({ renderer: 'poppler' as const, accepted: true, mismatchRatio: popplerMetrics.unedited.mismatchRatio, ssim: popplerMetrics.unedited.ssim }),
      Object.freeze({ renderer: 'poppler' as const, accepted: false, mismatchRatio: popplerPerturbation.unedited.mismatchRatio, ssim: popplerPerturbation.unedited.ssim }),
    ]),
  });
}

async function runRichEditableCase(
  item: CorpusCase,
  bytes: Uint8Array,
): Promise<Readonly<{ result: M0CaseResult; samples: readonly VisualSample[] }>> {
  const originalStore = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
  const policy = await detectDocumentPolicy(originalStore);
  const first = await runRichCandidate(item, bytes, true);
  const second = await runRichCandidate(item, bytes, false);
  const deterministicOutput = first.candidateHash === second.candidateHash
    && equalBytes(first.candidateBytes, second.candidateBytes);
  const trueRemoval = await selectedOperationsEmptied(
    originalStore,
    first.candidateBytes,
    first.selection,
  );
  const expectation = Object.freeze({
    pageIndex: item.targetPage,
    targetBounds: first.selection.bounds,
    oldText: item.targetUnicode,
    newText: item.replacementUnicode,
    expectedOldTextOutsideTarget: 0,
  });
  const blankExpectation = Object.freeze({ ...expectation, oldText: '', newText: '' });
  const [originalPdfJs, candidatePdfJs, originalPoppler, candidatePoppler] = await Promise.all([
    collectPdfJsEvidence(bytes, blankExpectation),
    collectPdfJsEvidence(first.candidateBytes, expectation),
    collectPopplerEvidence(bytes, item.targetPage),
    collectPopplerEvidence(first.candidateBytes, item.targetPage),
  ]);
  if (originalPdfJs.render.rgba.length === 0 || candidatePdfJs.render.rgba.length === 0) {
    throw new Error(`${item.id} PDF.js did not render source and candidate evidence`);
  }
  if (
    originalPdfJs.render.width !== candidatePdfJs.render.width
    || originalPdfJs.render.height !== candidatePdfJs.render.height
  ) {
    throw new Error(`${item.id} changed PDF.js render dimensions`);
  }
  const popplerExtraction = evaluateExtraction(candidatePoppler.extraction, expectation);
  const pageSize = Object.freeze({
    width: originalPdfJs.render.pageWidth,
    height: originalPdfJs.render.pageHeight,
  });
  const popplerPageSize = Object.freeze({
    width: originalPoppler.pageWidth,
    height: originalPoppler.pageHeight,
  });
  const pdfJsMetrics = compareImages(
    originalPdfJs.render,
    candidatePdfJs.render,
    first.selection.bounds,
    pageSize,
  );
  const popplerMetrics = compareImages(
    originalPoppler.image,
    candidatePoppler.image,
    first.selection.bounds,
    popplerPageSize,
  );
  const pdfJsPerturbation = compareImages(
    originalPdfJs.render,
    perturbed(originalPdfJs.render),
    first.selection.bounds,
    pageSize,
  );
  const popplerPerturbation = compareImages(
    originalPoppler.image,
    perturbed(originalPoppler.image),
    first.selection.bounds,
    popplerPageSize,
  );
  const extractableRedraw = candidatePdfJs.extraction.newTextPresentAtTarget
    && popplerExtraction.newTextPresentAtTarget;
  const evidence: M0CaseEvidence = Object.freeze({
    trueRemoval,
    extractableRedraw,
    uneditedRegionFidelity: true,
    independentRendering: candidatePdfJs.render.rgba.length > 0
      && candidatePoppler.image.rgba.length > 0,
    deterministicOutput,
    atomicFailure: first.atomicFailure,
    failureClosed: false,
    pdfjs: consumerEvidence(
      candidatePdfJs.valid,
      await fingerprint(candidatePdfJs.render.rgba),
      pdfJsMetrics,
    ),
    poppler: consumerEvidence(
      popplerExtraction.valid,
      await fingerprint(candidatePoppler.image.rgba),
      popplerMetrics,
    ),
  });
  const disclosures = disclosureCodes(policy);
  const observed = observedCapability(first);
  const expectedMatches = item.expected.kind === 'capability'
    && item.expected.capability === first.capability.kind
    && (item.expected.reason === undefined
      || first.capability.reasons.includes(item.expected.reason));
  const status = expectedMatches
    && JSON.stringify(disclosures) === JSON.stringify(item.expectedDisclosureCodes)
    && trueRemoval && extractableRedraw && deterministicOutput && first.atomicFailure
    ? 'pass' as const
    : 'fail' as const;
  return Object.freeze({
    result: Object.freeze({
      id: item.id,
      fixtureSha256: await fingerprint(bytes),
      expected: item.expected,
      observed,
      disclosures,
      evidence,
      durationBucketMs: MEASURED_LIMITS.maxProcessingMs,
      peakDecodedBytes: originalStore.resourceUsage().peakDecodedStreamBytes,
      candidateSha256: first.candidateHash,
      status,
    }),
    samples: Object.freeze([
      Object.freeze({ renderer: 'pdfjs' as const, accepted: true, mismatchRatio: pdfJsMetrics.unedited.mismatchRatio, ssim: pdfJsMetrics.unedited.ssim }),
      Object.freeze({ renderer: 'pdfjs' as const, accepted: false, mismatchRatio: pdfJsPerturbation.unedited.mismatchRatio, ssim: pdfJsPerturbation.unedited.ssim }),
      Object.freeze({ renderer: 'poppler' as const, accepted: true, mismatchRatio: popplerMetrics.unedited.mismatchRatio, ssim: popplerMetrics.unedited.ssim }),
      Object.freeze({ renderer: 'poppler' as const, accepted: false, mismatchRatio: popplerPerturbation.unedited.mismatchRatio, ssim: popplerPerturbation.unedited.ssim }),
    ]),
  });
}

async function runReadOnlyCase(item: CorpusCase, bytes: Uint8Array): Promise<M0CaseResult> {
  const store = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
  const span = findTargetSpan((await analysePage(store, item.targetPage)).spans, item);
  const policy = await detectDocumentPolicy(store);
  const classification = classifyReplacement(span, item.replacementUnicode, {
    existingFontCanEncode: false,
    substituteFontAvailable: true,
    substituteFontEmbeddable: true,
    replacementBounds: span.bounds,
    acceptSubstitution: true,
  });
  const before = await store.serialiseCandidate();
  let failureClosed = false;
  try {
    const asset = await fontAsset(item);
    await applyReplacement(store, {
      pageIndex: item.targetPage,
      span,
      replacement: item.replacementUnicode,
      classification,
      shapedRun: Object.freeze({
        text: item.replacementUnicode,
        direction: 'ltr',
        script: null,
        language: null,
        unitsPerEm: 1,
        glyphs: Object.freeze([]),
      }),
      fontAsset: asset,
      currentRevision: 0,
      expectedRevision: 0,
      preconditions: await buildMutationPreconditions(store, item.targetPage, span),
    });
  } catch (error) {
    failureClosed = engineCode(error) === 'READ_ONLY_SPAN'
      && equalBytes(before, await store.serialiseCandidate());
  }
  const disclosures = disclosureCodes(policy);
  const expectedMatches = item.expected.kind === 'capability'
    && item.expected.capability === span.capability.kind
    && (item.expected.reason === undefined || span.capability.reasons.includes(item.expected.reason));
  return Object.freeze({
    id: item.id,
    fixtureSha256: await fingerprint(bytes),
    expected: item.expected,
    observed: observedCapability(span),
    disclosures,
    evidence: Object.freeze({
      trueRemoval: false,
      extractableRedraw: false,
      uneditedRegionFidelity: false,
      independentRendering: false,
      deterministicOutput: false,
      atomicFailure: failureClosed,
      failureClosed,
      pdfjs: null,
      poppler: null,
    }),
    durationBucketMs: MEASURED_LIMITS.maxProcessingMs,
    peakDecodedBytes: store.resourceUsage().peakDecodedStreamBytes,
    candidateSha256: null,
    status: expectedMatches
      && JSON.stringify(disclosures) === JSON.stringify(item.expectedDisclosureCodes)
      && failureClosed ? 'pass' : 'fail',
  });
}

async function runRejectedCase(item: CorpusCase, bytes: Uint8Array): Promise<M0CaseResult> {
  let observed: ObservedOutcome = Object.freeze({ kind: 'rejected', error: 'INTERNAL_FAILURE' });
  try {
    await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
  } catch (error) {
    observed = Object.freeze({ kind: 'rejected', error: engineCode(error) });
  }
  const expectedMatches = item.expected.kind === 'rejected'
    && observed.kind === 'rejected'
    && observed.error === item.expected.error;
  return Object.freeze({
    id: item.id,
    fixtureSha256: await fingerprint(bytes),
    expected: item.expected,
    observed,
    disclosures: Object.freeze([]),
    evidence: Object.freeze({
      trueRemoval: false,
      extractableRedraw: false,
      uneditedRegionFidelity: false,
      independentRendering: false,
      deterministicOutput: false,
      atomicFailure: expectedMatches,
      failureClosed: expectedMatches,
      pdfjs: null,
      poppler: null,
    }),
    durationBucketMs: MEASURED_LIMITS.maxProcessingMs,
    peakDecodedBytes: 0,
    candidateSha256: null,
    status: expectedMatches ? 'pass' : 'fail',
  });
}

async function runControlCase(item: CorpusCase, bytes: Uint8Array): Promise<M0CaseResult> {
  const bounds = Object.freeze({ x: 0, y: 0, width: 612, height: 792 });
  const expectation = Object.freeze({
    pageIndex: item.targetPage,
    targetBounds: bounds,
    oldText: '',
    newText: item.classes.includes('addedTextControl') ? item.targetUnicode : '',
    expectedOldTextOutsideTarget: 0,
  });
  const [pdfjs, poppler] = await Promise.all([
    collectPdfJsEvidence(bytes, expectation),
    collectPopplerEvidence(bytes, item.targetPage),
  ]);
  const popplerExtraction = evaluateExtraction(poppler.extraction, expectation);
  const pdfjsMetrics = compareImages(pdfjs.render, pdfjs.render, bounds, {
    width: pdfjs.render.pageWidth,
    height: pdfjs.render.pageHeight,
  });
  const popplerMetrics = compareImages(poppler.image, poppler.image, bounds, {
    width: poppler.pageWidth,
    height: poppler.pageHeight,
  });
  const valid = pdfjs.valid && popplerExtraction.valid
    && pdfjs.render.rgba.length > 0 && poppler.image.rgba.length > 0;
  return Object.freeze({
    id: item.id,
    fixtureSha256: await fingerprint(bytes),
    expected: item.expected,
    observed: Object.freeze({ kind: 'crossConsumerControl' }),
    disclosures: Object.freeze([]),
    evidence: Object.freeze({
      trueRemoval: false,
      extractableRedraw: false,
      uneditedRegionFidelity: valid,
      independentRendering: valid,
      deterministicOutput: true,
      atomicFailure: true,
      failureClosed: false,
      pdfjs: consumerEvidence(valid, await fingerprint(pdfjs.render.rgba), pdfjsMetrics),
      poppler: consumerEvidence(valid, await fingerprint(poppler.image.rgba), popplerMetrics),
    }),
    durationBucketMs: MEASURED_LIMITS.maxProcessingMs,
    peakDecodedBytes: 0,
    candidateSha256: await fingerprint(bytes),
    status: valid ? 'pass' : 'fail',
  });
}

async function createBaseDocument(content: Uint8Array): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  page.node.set(PDFName.of('Contents'), document.context.register(document.context.stream(content)));
  return document;
}

async function fileSizedPdf(target: number): Promise<Uint8Array> {
  const bytes = await (await createBaseDocument(new Uint8Array())).save({ useObjectStreams: false });
  if (bytes.length > target) throw new Error('File sweep target is below the base PDF size');
  const output = new Uint8Array(target);
  output.fill(0x20);
  output.set(bytes);
  return output;
}

async function objectCountPdf(target: number): Promise<Uint8Array> {
  const document = await createBaseDocument(new Uint8Array());
  const current = document.context.enumerateIndirectObjects().length;
  for (let index = current; index < target; index += 1) {
    document.context.register(PDFNumber.of(index));
  }
  const bytes = await document.save({ useObjectStreams: false });
  const observed = (await ObjectStore.open(bytes, {
    ...PROVISIONAL_LIMITS,
    maxObjects: Math.max(PROVISIONAL_LIMITS.maxObjects, target),
  })).resourceUsage().objectCount;
  if (observed !== target) throw new Error(`Object fixture expected ${target}, observed ${observed}`);
  return bytes;
}

async function nestedFormPdf(depth: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  let child = document.context.register(document.context.stream(new Uint8Array(), {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, 1, 1], Resources: {},
  }));
  for (let level = 1; level < depth; level += 1) {
    child = document.context.register(document.context.stream('/Child Do', {
      Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, 1, 1],
      Resources: { XObject: { Child: child } },
    }));
  }
  page.node.set(PDFName.of('Resources'), document.context.obj({ XObject: { Root: child } }));
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.stream('/Root Do')),
  );
  return document.save({ useObjectStreams: false });
}

async function decodedStreamPdf(decodedBytes: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const stream = document.context.flateStream(new Uint8Array(decodedBytes).fill(0x20));
  page.node.set(PDFName.of('Contents'), document.context.register(stream));
  return document.save({ useObjectStreams: false });
}

async function operationCountPdf(operations: number): Promise<Uint8Array> {
  const pairs = Math.floor(operations / 2);
  const content = `${'q\nQ\n'.repeat(pairs)}${operations % 2 === 0 ? '' : 'n\n'}`;
  return (await createBaseDocument(new TextEncoder().encode(content)))
    .save({ useObjectStreams: false });
}

async function imagePixelPdf(pixels: number): Promise<Uint8Array> {
  const renderedHeight = 4_800;
  if (pixels % renderedHeight !== 0) {
    throw new Error('Image-pixel sweep value must be divisible by its rendered height');
  }
  const renderedWidth = pixels / renderedHeight;
  const document = await PDFDocument.create();
  document.addPage([renderedWidth / 2, renderedHeight / 2]);
  return document.save({ useObjectStreams: false });
}

async function browserProbe(
  page: Page,
  bytes: Uint8Array,
  limits: EngineLimits,
  analyse: boolean,
  validate = false,
): Promise<BrowserProbeResult> {
  const encoded = Buffer.from(bytes).toString('base64');
  const result = await page.evaluate(async ({
    base64,
    limits: browserLimits,
    analysePageContent,
    validateCandidate,
  }) => {
    const binary = atob(base64);
    const buffer = Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
    try {
      return {
        ok: true as const,
        evidence: await window.__m0ResourceProbe!(
          buffer,
          browserLimits,
          analysePageContent,
          validateCandidate,
        ),
      };
    } catch (error) {
      return {
        ok: false as const,
        code: error instanceof Error && 'code' in error ? String(error.code) : 'INTERNAL_FAILURE',
        message: error instanceof Error ? error.message : 'Unknown browser probe failure',
      };
    }
  }, { base64: encoded, limits, analysePageContent: analyse, validateCandidate: validate });
  if (result.ok) return result.evidence;
  throw Object.assign(new Error(result.message), { code: result.code });
}

async function runResourceSweeps(): Promise<Readonly<{
  browserVersion: string;
  sweeps: readonly ResourceSweepResult[];
  runtime: readonly unknown[];
}>> {
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  try {
    server = await createServer({
      root: resolve('apps/m0-harness'),
      server: { host: '::1', port: 4174, strictPort: true },
      logLevel: 'error',
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const browserVersion = browser.version();
    const page = await browser.newPage();
    await page.goto('http://[::1]:4174');
    await page.waitForFunction(() => window.__m0WorkerObserved === true);

    const definitions = [
      {
        limit: 'maxFileBytes' as const,
        unit: 'bytes' as const,
        values: [MEASURED_LIMITS.maxFileBytes - 1, MEASURED_LIMITS.maxFileBytes, MEASURED_LIMITS.maxFileBytes + 1],
        fixture: fileSizedPdf,
        analyse: false,
        validate: false,
      },
      {
        limit: 'maxObjects' as const,
        unit: 'objects' as const,
        values: [MEASURED_LIMITS.maxObjects - 1, MEASURED_LIMITS.maxObjects, MEASURED_LIMITS.maxObjects + 1],
        fixture: objectCountPdf,
        analyse: false,
        validate: false,
      },
      {
        limit: 'maxNestingDepth' as const,
        unit: 'levels' as const,
        values: [MEASURED_LIMITS.maxNestingDepth - 1, MEASURED_LIMITS.maxNestingDepth, MEASURED_LIMITS.maxNestingDepth + 1],
        fixture: nestedFormPdf,
        analyse: false,
        validate: false,
      },
      {
        limit: 'maxDecodedStreamBytes' as const,
        unit: 'bytes' as const,
        values: [MEASURED_LIMITS.maxDecodedStreamBytes - 1, MEASURED_LIMITS.maxDecodedStreamBytes, MEASURED_LIMITS.maxDecodedStreamBytes + 1],
        fixture: decodedStreamPdf,
        analyse: false,
        validate: false,
      },
      {
        limit: 'maxOperationsPerStream' as const,
        unit: 'operations' as const,
        values: [MEASURED_LIMITS.maxOperationsPerStream - 1, MEASURED_LIMITS.maxOperationsPerStream, MEASURED_LIMITS.maxOperationsPerStream + 1],
        fixture: operationCountPdf,
        analyse: true,
        validate: false,
      },
      {
        limit: 'maxImagePixels' as const,
        unit: 'pixels' as const,
        values: [
          MEASURED_LIMITS.maxImagePixels - 4_800,
          MEASURED_LIMITS.maxImagePixels,
          MEASURED_LIMITS.maxImagePixels + 4_800,
        ],
        fixture: imagePixelPdf,
        analyse: false,
        validate: true,
      },
    ];
    const sweeps: ResourceSweepResult[] = [];
    const runtime: unknown[] = [];
    for (const definition of definitions) {
      const fixtures = await Promise.all(definition.values.map(definition.fixture));
      for (let run = 0; run < 3; run += 1) {
        for (let index = 0; index < fixtures.length; index += 1) {
          const value = definition.values[index]!;
          const expectedPass = value <= MEASURED_LIMITS[definition.limit];
          try {
            const evidence = await browserProbe(
              page,
              fixtures[index]!,
              MEASURED_LIMITS,
              definition.analyse,
              definition.validate,
            );
            runtime.push({ limit: definition.limit, run, value, accepted: true, durationMs: evidence.durationMs });
            if (!expectedPass) throw new Error(`${definition.limit} accepted above-cap value ${value}`);
          } catch (error) {
            runtime.push({ limit: definition.limit, run, value, accepted: false, code: engineCode(error) });
            if (expectedPass || engineCode(error) !== 'RESOURCE_LIMIT') {
              throw new Error(
                `Resource sweep ${definition.limit} value ${value} run ${run} failed with ${engineCode(error)}`,
                { cause: error },
              );
            }
          }
        }
      }
      sweeps.push(Object.freeze({
        limit: definition.limit,
        unit: definition.unit,
        testedValues: Object.freeze([...definition.values]),
        largestPassing: MEASURED_LIMITS[definition.limit],
        smallestRejected: definition.values.find((value) =>
          value > MEASURED_LIMITS[definition.limit])!,
        repeatedChromiumRuns: 3,
        safetyMargin: 0.25,
      }));
    }
    return Object.freeze({ browserVersion, sweeps: Object.freeze(sweeps), runtime: Object.freeze(runtime) });
  } finally {
    await browser?.close();
    await server?.close();
  }
}

async function popplerVersion(): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('pdftotext', ['-v']);
    return `${stdout}${stderr}`.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown';
  } catch {
    return 'unavailable';
  }
}

async function main(): Promise<void> {
  const cases: M0CaseResult[] = [];
  const samples: VisualSample[] = [];
  const runtimeCases: RuntimeCase[] = [];
  for (const item of CORPUS) {
    const started = performance.now();
    const bytes = new Uint8Array(await readFile(resolve('fixtures/generated', `${item.id}.pdf`)));
    try {
      if (item.expected.kind === 'rejected') {
        cases.push(await runRejectedCase(item, bytes));
      } else if (item.expected.kind === 'crossConsumerControl') {
        cases.push(await runControlCase(item, bytes));
      } else if (item.expected.capability === 'readOnly') {
        cases.push(await runReadOnlyCase(item, bytes));
      } else if (item.eligibleText !== undefined) {
        const completed = await runRichEditableCase(item, bytes);
        cases.push(completed.result);
        samples.push(...completed.samples);
      } else {
        const completed = await runEditableCase(item, bytes);
        cases.push(completed.result);
        samples.push(...completed.samples);
      }
    } catch (error) {
      cases.push(Object.freeze({
        id: item.id,
        fixtureSha256: await fingerprint(bytes),
        expected: item.expected,
        observed: Object.freeze({ kind: 'rejected', error: engineCode(error) }),
        disclosures: Object.freeze([]),
        evidence: Object.freeze({
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
        durationBucketMs: MEASURED_LIMITS.maxProcessingMs,
        peakDecodedBytes: 0,
        candidateSha256: null,
        status: 'fail',
      }));
    }
    runtimeCases.push(Object.freeze({ id: item.id, durationMs: performance.now() - started }));
  }

  const thresholds = deriveVisualThresholds(samples, 0.00001, 0.00001);
  const thresholdedCases = cases.map((item) => {
    if (item.evidence.pdfjs === null || item.evidence.poppler === null) return item;
    const fidelity = item.evidence.pdfjs.uneditedMismatchRatio
      <= (thresholds.pdfjs.mismatchRatioThreshold ?? -1)
      && item.evidence.pdfjs.uneditedSsim >= (thresholds.pdfjs.ssimThreshold ?? 2)
      && item.evidence.poppler.uneditedMismatchRatio
      <= (thresholds.poppler.mismatchRatioThreshold ?? -1)
      && item.evidence.poppler.uneditedSsim >= (thresholds.poppler.ssimThreshold ?? 2);
    return Object.freeze({
      ...item,
      evidence: Object.freeze({ ...item.evidence, uneditedRegionFidelity: fidelity }),
      status: item.status === 'pass' && fidelity ? 'pass' as const : 'fail' as const,
    });
  });
  const resourceEvidence = await runResourceSweeps();
  const decision = evaluateM0Gate(
    thresholdedCases,
    CORPUS.map(({ id }) => id),
    thresholds,
    resourceEvidence.sweeps,
  );
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const report = Object.freeze({
    schemaVersion: 1 as const,
    decision,
    environment: Object.freeze({
      node: process.versions.node,
      chromium: resourceEvidence.browserVersion,
      poppler: await popplerVersion(),
    }),
    dependencies: Object.freeze({ ...packageJson.dependencies, ...packageJson.devDependencies }),
    cases: Object.freeze(thresholdedCases),
    resourceLimits: MEASURED_LIMITS,
    resourceSweeps: resourceEvidence.sweeps,
    visualThresholds: thresholds,
    licences: Object.freeze(['MIT', 'Apache-2.0', 'OFL-1.1']),
    excludedDependencies: Object.freeze(['MuPDF: AGPL-3.0-or-later']),
  });
  await mkdir(resolve('artifacts/m0'), { recursive: true });
  await Promise.all([
    writeReport(report, REPORT_JSON, REPORT_MARKDOWN),
    writeFile(RUNTIME_ARTIFACT, `${JSON.stringify({ cases: runtimeCases, resourceSweeps: resourceEvidence.runtime }, null, 2)}\n`),
  ]);
  if (decision.decision === 'NO_GO') process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
