import type {
  AnalysedGlyph,
  AnalysedSpan,
  AnalysedTextGroup,
  AnalysedTextLine,
  Capability,
  DocumentEditingFont,
  FontDescriptor,
  FontSourceKind,
} from '@pdf-editor/pdf-engine';
import { buildTextSelection, DEFAULT_TEXT_DECORATIONS } from '@pdf-editor/pdf-engine';
import type {
  AnalysePageResult,
  OpenDocumentResult,
  RichReplacementPayload,
  RichReplacementPreconditions,
  RichReplacementPreviewResult,
  ReplacementPayload,
  ReplacementPreconditions,
  ReplacementPreviewResult,
} from '@pdf-editor/worker-protocol';
import type { PDFPageProxy } from 'pdfjs-dist';
import { vi } from 'vitest';

import type { ProductEngineClient, ValidatedApplyResult } from '../engine/product-engine-client';
import type { EditorSnapshot } from '../model/editor-state';
import type { PdfDisplayDocument } from '../pdf/display-document';
import { EditorController } from '../session/editor-controller';

export type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}>;

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function selectionFixture(
  text = 'Original',
  capability: Capability = {
    kind: 'safeReplacement',
    reasons: ['supportedExistingFont'],
  },
  index = 0,
): AnalysedSpan {
  return Object.freeze({
    address: {
      pageRef: { objectNumber: 1, generationNumber: 0 },
      streamPath: [{
        kind: 'pageContents',
        ref: { objectNumber: 2, generationNumber: 0 },
        resourceName: null,
      }],
      operatorRange: { start: index, end: index + 1 },
      glyphRange: { start: index, end: index + 1 },
    },
    unicode: text,
    bounds: { x: 10, y: 20 + index * 20, width: 100, height: 12 },
    baseline: [10, 20 + index * 20],
    glyphs: [],
    styleKey: 'F1|12|100',
    style: {
      fontResourceName: 'F1',
      fontBaseName: 'Helvetica',
      fontSize: 12,
      horizontalScaling: 100,
      characterSpacing: 0,
      wordSpacing: 0,
      rise: 0,
      renderingMode: 0,
      fillColour: { colourSpace: 'DeviceGray', components: [0] },
      strokeColour: { colourSpace: 'DeviceGray', components: [0] },
      fontWeight: 400,
      italicAngle: 0,
    },
    fontSize: 12,
    horizontalScaling: 100,
    textMatrix: [1, 0, 0, 1, 10, 20 + index * 20],
    renderMatrix: [1, 0, 0, 1, 10, 20 + index * 20],
    resource: {
      fontResourceName: 'F1',
      fontBaseName: 'Helvetica',
      fontSubtype: 'Type1',
      fontEmbedded: true,
      writingMode: 0,
      referenceCount: 1,
      fontWeight: 400,
      italicAngle: 0,
    },
    capability,
  } satisfies AnalysedSpan);
}

type AnalysisEntry = Readonly<{ text: string; capability: Capability }>;

export function analysisFixture(
  value: string | readonly AnalysisEntry[] = 'Original',
): AnalysePageResult {
  const entries = typeof value === 'string'
    ? [{ text: value, capability: {
        kind: 'safeReplacement',
        reasons: ['supportedExistingFont'],
      } as Capability }]
    : value;
  const spans = entries.map((entry, index) => selectionFixture(
    entry.text,
    entry.capability,
    index,
  ));
  const lines = spans.map((span, index): AnalysedTextLine => {
    const unicode = span.unicode ?? '';
    const glyph: AnalysedGlyph = Object.freeze({
      glyphIndex: 0,
      sourceCodeStart: 0,
      sourceCodeEnd: 1,
      sourceCode: unicode.codePointAt(0) ?? 0,
      glyphId: index + 1,
      unicode,
      advance: span.bounds.width,
      sourceTextGapBefore: null,
      source: Object.freeze({
        pageRef: span.address.pageRef,
        streamPath: span.address.streamPath,
        operatorIndex: index,
        glyphIndex: 0,
        sourceCodeRange: Object.freeze({ start: 0, end: 1 }),
      }),
      mutationAddress: span.address,
      bounds: span.bounds,
      baseline: span.baseline,
      styleKey: span.styleKey,
      style: span.style,
      decorations: DEFAULT_TEXT_DECORATIONS,
    });
    const key = `line-${index + 1}`;
    const group: AnalysedTextGroup = Object.freeze({
      key: `group-${index + 1}`,
      lineKey: key,
      glyphRange: Object.freeze({ start: 0, end: 1 }),
      text: unicode,
      bounds: span.bounds,
      styleRuns: Object.freeze([Object.freeze({
        glyphRange: Object.freeze({ start: 0, end: 1 }),
        text: unicode,
        styleKey: span.styleKey,
        style: span.style,
        decorations: DEFAULT_TEXT_DECORATIONS,
      })]),
      capability: span.capability,
    });
    return Object.freeze({
      key,
      pageIndex: 0,
      glyphs: Object.freeze([glyph]),
      groups: Object.freeze([group]),
      bounds: span.bounds,
      baselineDirection: Object.freeze([1, 0] as const),
      sourceDecorations: Object.freeze([]),
      decorationWarnings: Object.freeze([]),
      capability: span.capability,
    });
  });
  const groups = lines.flatMap((line) => line.groups);
  return Object.freeze({
    pageIndex: 0,
    pageSpace: { mediaBox: [0, 0, 612, 792] as const, rotate: 0, userUnit: 1 },
    spans,
    spanKeys: spans.map((_, index) => `span-${index + 1}`),
    textLayout: {
      pageIndex: 0,
      lines: Object.freeze(lines),
      groups: Object.freeze(groups),
      decorationWarnings: Object.freeze([]),
      eligibleSourceGlyphCount: lines.reduce((total, line) => total + line.glyphs.length, 0),
    },
  });
}

export function textLineAnalysisFixture(
  text = 'ABC',
  capability: Capability = {
    kind: 'safeReplacement',
    reasons: ['supportedExistingFont'],
  },
): AnalysePageResult {
  const glyphs = [...text].map((unicode, index): AnalysedGlyph => {
    const span = selectionFixture(unicode, capability, index);
    const address = Object.freeze({
      ...span.address,
      glyphRange: Object.freeze({ start: 0, end: 1 }),
    });
    const bounds = Object.freeze({
      x: 10 + index * 12,
      y: 20,
      width: 12,
      height: 12,
    });
    return Object.freeze({
      glyphIndex: 0,
      sourceCodeStart: 0,
      sourceCodeEnd: 1,
      sourceCode: unicode.codePointAt(0) ?? 0,
      glyphId: index + 1,
      unicode,
      advance: 12,
      sourceTextGapBefore: null,
      source: Object.freeze({
        pageRef: address.pageRef,
        streamPath: address.streamPath,
        operatorIndex: index,
        glyphIndex: 0,
        sourceCodeRange: Object.freeze({ start: 0, end: 1 }),
      }),
      mutationAddress: address,
      bounds,
      baseline: Object.freeze([bounds.x, 20] as const),
      styleKey: span.styleKey,
      style: span.style,
      decorations: DEFAULT_TEXT_DECORATIONS,
    });
  });
  const bounds = Object.freeze({
    x: 10,
    y: 20,
    width: Math.max(12, glyphs.length * 12),
    height: 12,
  });
  const group: AnalysedTextGroup = Object.freeze({
    key: 'group-1',
    lineKey: 'line-1',
    glyphRange: Object.freeze({ start: 0, end: glyphs.length }),
    text,
    bounds,
    styleRuns: Object.freeze([Object.freeze({
      glyphRange: Object.freeze({ start: 0, end: glyphs.length }),
      text,
      styleKey: glyphs[0]?.styleKey ?? 'F1|12|100',
      style: glyphs[0]?.style ?? selectionFixture().style,
      decorations: DEFAULT_TEXT_DECORATIONS,
    })]),
    capability,
  });
  const line: AnalysedTextLine = Object.freeze({
    key: 'line-1',
    pageIndex: 0,
    glyphs: Object.freeze(glyphs),
    groups: Object.freeze([group]),
    bounds,
    baselineDirection: Object.freeze([1, 0] as const),
    sourceDecorations: Object.freeze([]),
    decorationWarnings: Object.freeze([]),
    capability,
  });
  const spans = glyphs.map((glyph, index) => Object.freeze({
    ...selectionFixture(glyph.unicode ?? '', capability, index),
    address: glyph.mutationAddress,
    glyphs: Object.freeze([glyph]),
    bounds: glyph.bounds,
    baseline: glyph.baseline,
  }));
  return Object.freeze({
    pageIndex: 0,
    pageSpace: { mediaBox: [0, 0, 612, 792] as const, rotate: 0, userUnit: 1 },
    spans,
    spanKeys: spans.map((_, index) => `span-${index + 1}`),
    textLayout: Object.freeze({
      pageIndex: 0,
      lines: Object.freeze([line]),
      groups: Object.freeze([group]),
      decorationWarnings: Object.freeze([]),
      eligibleSourceGlyphCount: glyphs.length,
    }),
  });
}

export function validatedResult(
  revision: number,
  bytes: Uint8Array,
): ValidatedApplyResult {
  return Object.freeze({
    revision,
    candidateHash: `candidate-${revision}`,
    bytes: bytes.slice(),
  });
}

export function pdfFile(name: string, bytes: Uint8Array): File {
  return new File([bytes.slice()], name, { type: 'application/pdf' });
}

export function fakeFontDescriptor(
  source: FontSourceKind = 'bundled',
  fileName = 'Example-Regular.ttf',
  hash = 'bundled-example',
): FontDescriptor {
  return Object.freeze({
    id: `font:${hash}`,
    hash,
    source,
    fileName,
    byteLength: 3,
    inspection: {
      sourceFormat: 'truetype',
      outlineFormat: 'truetype',
      postscriptName: 'Example-Regular',
      fullName: 'Example Regular',
      familyName: 'Example',
      subfamilyName: 'Regular',
      version: 'Version 1',
      unitsPerEm: 1000,
      ascent: 800,
      descent: -200,
      lineGap: 0,
      capHeight: 700,
      xHeight: 500,
      underlinePosition: null,
      underlineThickness: null,
      strikeoutPosition: null,
      strikeoutThickness: null,
      italicAngle: 0,
      weight: 400,
      width: 5,
      italic: false,
      numGlyphs: 128,
      codePoints: Array.from({ length: 95 }, (_, index) => index + 32),
      metricsFingerprint: 'metrics',
      embedding: {
        usage: 'installable',
        documentEditingAllowed: true,
        subsettingAllowed: true,
        bitmapOnly: false,
      },
    },
  } satisfies FontDescriptor);
}

type AnalysisReply = AnalysePageResult | Promise<AnalysePageResult>;
type ApplyReply = ValidatedApplyResult | Error | Promise<ValidatedApplyResult>;
type OpenReply = OpenDocumentResult | Error | Promise<OpenDocumentResult>;
type RichPreviewReply =
  | RichReplacementPreviewResult
  | Error
  | Promise<RichReplacementPreviewResult>;
type FontRegistrationReply = FontDescriptor | Error | Promise<FontDescriptor>;
type FontInventoryReply =
  | readonly DocumentEditingFont[]
  | Error
  | Promise<readonly DocumentEditingFont[]>;

export function richPreviewResult(
  replacement = 'ABC',
): RichReplacementPreviewResult {
  return Object.freeze({
    commandHash: 'rich-command',
    nextRevision: 1,
    selectionKey: 'stale-selection',
    replacement,
    replacementBounds: { x: 10, y: 8, width: replacement.length * 6, height: 12 },
    allowedRegion: { x: 10, y: 8, width: 100, height: 36 },
    fits: true,
    requiredSubstitutionConsents: [],
    fontMatches: [],
    preconditions: {
      selectionKey: 'stale-selection',
      expectedCommandHash: 'rich-command',
      slices: [],
      decorations: [],
    },
  });
}

export class FakeEngineClient {
  readonly openInputs: Uint8Array[] = [];
  readonly analyseCalls: number[] = [];
  readonly applyInputs: Array<ReplacementPayload & Readonly<{
    preconditions: ReplacementPreconditions;
  }>> = [];
  readonly applyRevisions: number[] = [];
  readonly fontRegistrations: Array<Readonly<{
    source: Extract<FontSourceKind, 'local' | 'upload'>;
    fileName: string;
    bytes: Uint8Array;
  }>> = [];
  readonly richPreviewInputs: RichReplacementPayload[] = [];
  readonly richApplyInputs: Array<Readonly<{
    payload: RichReplacementPayload;
    preconditions: RichReplacementPreconditions;
  }>> = [];
  fontInventoryCalls = 0;
  terminated = false;
  revision: number | null = null;
  #lastAnalysis: AnalysePageResult | null = null;

  constructor(
    private readonly analyses: AnalysisReply[],
    private readonly applyResults: ApplyReply[],
    private readonly openResults: OpenReply[],
    private readonly richPreviewResults: RichPreviewReply[],
    private readonly fontRegistrationResults: FontRegistrationReply[],
    private readonly fontInventoryResults: FontInventoryReply[],
  ) {}

  async open(bytes: Uint8Array): Promise<OpenDocumentResult> {
    this.openInputs.push(bytes.slice());
    const reply = this.openResults.shift();
    if (reply instanceof Error) throw reply;
    if (reply !== undefined) {
      const result = await reply;
      this.revision = result.revision;
      return result;
    }
    this.revision = 0;
    return {
      documentId: 'fake-document',
      fingerprint: 'fake',
      revision: 0,
      fonts: [fakeFontDescriptor()],
    };
  }

  async analysePage(pageIndex: number): Promise<AnalysePageResult> {
    this.analyseCalls.push(pageIndex);
    const reply = this.analyses.shift();
    if (reply === undefined) throw new Error('No scripted analysis result');
    const analysis = await reply;
    this.#lastAnalysis = analysis;
    return analysis;
  }

  async inspectDocumentFonts(): Promise<readonly DocumentEditingFont[]> {
    this.fontInventoryCalls += 1;
    const reply = this.fontInventoryResults.shift();
    if (reply instanceof Error) throw reply;
    return reply === undefined ? [] : reply;
  }

  async registerFont(
    source: Extract<FontSourceKind, 'local' | 'upload'>,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<FontDescriptor> {
    const owned = bytes.slice();
    this.fontRegistrations.push(Object.freeze({ source, fileName, bytes: owned }));
    const scripted = this.fontRegistrationResults.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted !== undefined) return scripted;
    const hash = [...owned].join('-');
    return Object.freeze({
      ...fakeFontDescriptor(source, fileName, hash),
      byteLength: owned.byteLength,
    });
  }

  async previewReplacement(
    spanKey: string,
    replacement: string,
    acceptSubstitution: boolean,
  ): Promise<ReplacementPreviewResult> {
    return {
      capability: { kind: 'safeReplacement', reasons: ['supportedExistingFont'] },
      normalisedReplacement: replacement.normalize('NFC'),
      canApply: replacement.length > 0,
      substitutionAccepted: acceptSubstitution,
      preconditions: {
        spanKey,
        expectedOperatorDigest: 'operator',
        expectedGlyphText: 'Original',
        expectedNormalisedReplacement: replacement.normalize('NFC'),
        expectedSubstitutionAccepted: acceptSubstitution,
      },
    };
  }

  async applyValidated(
    input: ReplacementPayload & Readonly<{
      preconditions: ReplacementPreconditions;
    }>,
  ): Promise<ValidatedApplyResult> {
    this.applyInputs.push(input);
    this.applyRevisions.push(this.revision ?? -1);
    const reply = this.applyResults.shift();
    if (reply === undefined) throw new Error('No scripted apply result');
    if (reply instanceof Error) throw reply;
    const result = await reply;
    this.revision = result.revision;
    return result;
  }

  async previewRichReplacement(
    payload: RichReplacementPayload,
  ): Promise<RichReplacementPreviewResult> {
    this.richPreviewInputs.push(payload);
    const scripted = this.richPreviewResults.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted !== undefined) return scripted;
    const replacement = payload.runs.map(({ text }) => text).join('');
    const line = this.#lastAnalysis?.textLayout.lines.find(
      ({ key }) => key === payload.selection.lineKey,
    );
    if (line === undefined) throw new Error('Rich preview line was not analysed');
    const selection = buildTextSelection(
      line,
      payload.selection.anchorGlyphIndex,
      payload.selection.focusGlyphIndex,
    );
    const replacementBounds = {
      ...payload.allowedRegion,
      width: replacement.length * 6,
    };
    const fontMatches = [...new Map(payload.runs.map((run) => [run.fontId, {
      fontId: run.fontId,
      matchKind: run.fontIntent === 'explicit-choice' ? 'exact' as const : 'substitute' as const,
    }])).values()];
    const consent = new Set(payload.substitutionConsents);
    const requiredSubstitutionConsents = fontMatches
      .filter(({ matchKind, fontId }) => matchKind !== 'exact' && !consent.has(fontId))
      .map(({ fontId }) => fontId);
    return Object.freeze({
      commandHash: 'rich-command',
      nextRevision: (this.revision ?? 0) + 1,
      selectionKey: selection.key,
      replacement,
      replacementBounds,
      allowedRegion: payload.allowedRegion,
      fits: replacementBounds.width <= payload.allowedRegion.width,
      requiredSubstitutionConsents,
      fontMatches,
      preconditions: {
        selectionKey: selection.key,
        expectedCommandHash: 'rich-command',
        slices: [],
        decorations: [],
      },
    });
  }

  async applyRichValidated(
    payload: RichReplacementPayload,
    preconditions: RichReplacementPreconditions,
  ): Promise<ValidatedApplyResult> {
    this.richApplyInputs.push(Object.freeze({ payload, preconditions }));
    this.applyRevisions.push(this.revision ?? -1);
    const reply = this.applyResults.shift();
    if (reply === undefined) throw new Error('No scripted rich apply result');
    if (reply instanceof Error) throw reply;
    const result = await reply;
    this.revision = result.revision;
    return result;
  }

  async close(): Promise<void> {
    this.revision = null;
  }

  terminate(): void {
    this.terminated = true;
    this.revision = null;
  }
}

export class FakeDisplayDocument {
  readonly pageCount = 1;
  destroyed = false;

  async getPage(_pageIndex: number): Promise<PDFPageProxy> {
    return {} as PDFPageProxy;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

export type ControllerHarness = Readonly<{
  controller: EditorController;
  engines: FakeEngineClient[];
  displayInputs: Uint8Array[];
  waitForAnalysisCall(index: number): Promise<void>;
}>;

export function createControllerHarness(options: Readonly<{
  analyses?: AnalysisReply[];
  applyResults?: ApplyReply[];
  openResults?: OpenReply[];
  richPreviewResults?: RichPreviewReply[];
  fontRegistrationResults?: FontRegistrationReply[];
  fontInventoryResults?: FontInventoryReply[];
}> = {}): ControllerHarness {
  const analyses = [...(options.analyses ?? [])];
  const applyResults = [...(options.applyResults ?? [])];
  const openResults = [...(options.openResults ?? [])];
  const richPreviewResults = [...(options.richPreviewResults ?? [])];
  const fontRegistrationResults = [...(options.fontRegistrationResults ?? [])];
  const fontInventoryResults = [...(options.fontInventoryResults ?? [])];
  const engines: FakeEngineClient[] = [];
  const displayInputs: Uint8Array[] = [];
  const controller = new EditorController({
    createEngine: () => {
      const engine = new FakeEngineClient(
        analyses,
        applyResults,
        openResults,
        richPreviewResults,
        fontRegistrationResults,
        fontInventoryResults,
      );
      engines.push(engine);
      return engine as unknown as ProductEngineClient;
    },
    openDisplay: async (bytes) => {
      displayInputs.push(bytes.slice());
      return new FakeDisplayDocument() as unknown as PdfDisplayDocument;
    },
  });

  return {
    controller,
    engines,
    displayInputs,
    async waitForAnalysisCall(index: number): Promise<void> {
      await viWaitFor(() => engines[index]?.analyseCalls.length === 1);
    },
  };
}

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for fake analysis call');
}

export type TestEditorController = EditorController & Readonly<{
  publish(patch: Partial<EditorSnapshot>): void;
  selectTextRange: ReturnType<typeof vi.fn>;
  registerAndApplyFont: ReturnType<typeof vi.fn>;
}>;

export function readyController(
  overrides: Partial<EditorSnapshot> = {},
): TestEditorController {
  let snapshot: EditorSnapshot = {
    phase: 'ready',
    generation: 1,
    fileName: 'report.pdf',
    pageIndex: 0,
    pageCount: 1,
    zoom: 1,
    fitMode: 'page',
    tool: 'select',
    showOverlays: true,
    analysis: null,
    fonts: [],
    fontInventoryState: 'ready',
    editingFonts: [],
    selection: null,
    replacement: '',
    acceptSubstitution: false,
    preview: null,
    richEditor: null,
    hasEdits: false,
    downloadAvailable: false,
    displayVersion: 0,
    status: 'Ready',
    error: null,
    ...overrides,
  };
  const listeners = new Set<() => void>();
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (patch: Partial<EditorSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getDisplayPage: vi.fn(() => new Promise(() => undefined)),
    setPage: vi.fn().mockResolvedValue(undefined),
    setZoom: vi.fn(),
    setTool: vi.fn(),
    setShowOverlays: vi.fn(),
    registerFont: vi.fn(),
    registerAndApplyFont: vi.fn(),
    listSessionFonts: vi.fn(() => []),
    selectSpan: vi.fn(),
    selectTextRange: vi.fn(),
    setReplacement: vi.fn(),
    setAcceptSubstitution: vi.fn(),
    replaceRichText: vi.fn(),
    formatRichText: vi.fn(),
    setRichAllowedWidth: vi.fn(),
    setRichSubstitutionConsent: vi.fn(),
    previewSelection: vi.fn().mockResolvedValue(undefined),
    applySelection: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue(undefined),
    download: vi.fn(() => ({
      sourceFileName: snapshot.fileName ?? 'document.pdf',
      bytes: Uint8Array.of(1),
    })),
    reportDisplayError: vi.fn(),
  };
  return controller as unknown as TestEditorController;
}

export function readyControllerWithApplicablePreview(
  replacement = 'Edited',
): TestEditorController {
  const span = selectionFixture();
  return readyController({
    analysis: analysisFixture(),
    selection: { kind: 'span', spanKey: 'span-1', span },
    replacement,
    acceptSubstitution: false,
    preview: {
      capability: span.capability,
      normalisedReplacement: replacement,
      canApply: true,
      substitutionAccepted: false,
      preconditions: {
        spanKey: 'span-1',
        expectedOperatorDigest: 'operator',
        expectedGlyphText: span.unicode ?? '',
        expectedNormalisedReplacement: replacement,
        expectedSubstitutionAccepted: false,
      },
    },
  });
}
