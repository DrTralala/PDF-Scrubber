import {
  buildTextSelection,
  canonicalPageSize,
  MAX_PDF_FILE_BYTES,
  resolveFontRequirement,
  type CanonicalBounds,
  type EffectiveTextStyle,
  type FontDescriptor,
  type FontRequirement,
  type FontSourceKind,
  type HalfOpenRange,
} from '@pdf-editor/pdf-engine';
import type {
  RichReplacementPayload,
} from '@pdf-editor/worker-protocol';
import type { PDFPageProxy } from 'pdfjs-dist';

import {
  ProductEngineClient,
} from '../engine/product-engine-client';
import { WorkerTransport } from '../engine/worker-client';
import { TabFontVault } from '../fonts/tab-font-vault';
import {
  RichTextBuffer,
  type EditorRichTextRun,
  type RichTextFormatPatch,
} from '../editing/rich-text-buffer';
import { deriveRichFitRegion } from '../editing/rich-fit-region';
import {
  editorError,
  type EditorError,
  type EditorSelection,
  type EditorRichFontStatus,
  type EditorRichState,
  type EditorSnapshot,
  type EditorTool,
  type FitMode,
} from '../model/editor-state';
import {
  PdfDisplayDocument,
} from '../pdf/display-document';

const RESTORED_STATUS =
  'Replacement was not applied; the last validated document was restored.';
const FILE_LIMIT_RESTORED_STATUS =
  'The edited PDF exceeds the 15 MiB file limit. The last validated document was restored.';

function isFileByteLimit(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const details = (error as { details?: Readonly<Record<string, unknown>> }).details;
  return (error as { code?: unknown }).code === 'RESOURCE_LIMIT'
    && details?.resource === 'fileBytes';
}

export type EditorDependencies = Readonly<{
  createEngine(): ProductEngineClient;
  openDisplay(bytes: Uint8Array): Promise<PdfDisplayDocument>;
  fontVault?: TabFontVault;
}>;

export type DownloadAsset = Readonly<{
  sourceFileName: string;
  bytes: Uint8Array;
}>;

export type FontApplicationTarget = Readonly<{
  generation: number;
  pageIndex: number;
  selectionKey: string;
  range: HalfOpenRange;
}>;

export type FontApplicationResult = Readonly<{
  descriptor: FontDescriptor;
  outcome: 'applied' | 'stale-selection' | 'missing-coverage';
}>;

const INITIAL_STATE: EditorSnapshot = Object.freeze({
  phase: 'empty',
  generation: 0,
  fileName: null,
  pageIndex: 0,
  pageCount: 0,
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
  status: 'Open a PDF to begin',
  error: null,
});

export class EditorController {
  readonly #listeners = new Set<() => void>();
  #state: EditorSnapshot = INITIAL_STATE;
  #generation = 0;
  #engine: ProductEngineClient | null = null;
  #display: PdfDisplayDocument | null = null;
  #originalBytes: Uint8Array | null = null;
  #displayBytes: Uint8Array | null = null;
  #validatedBytes: Uint8Array | null = null;
  readonly #fontVault: TabFontVault;

  constructor(private readonly dependencies: EditorDependencies) {
    this.#fontVault = dependencies.fontVault ?? new TabFontVault();
  }

  getSnapshot(): EditorSnapshot {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async open(file: File): Promise<void> {
    if (
      file.type.toLowerCase() !== 'application/pdf'
      && !file.name.toLowerCase().endsWith('.pdf')
    ) {
      const error = editorError({ code: 'UNSUPPORTED_DOCUMENT' });
      this.#setState({
        phase: 'recoverableError',
        error,
        status: error.message,
      });
      return;
    }
    if (file.size > MAX_PDF_FILE_BYTES) {
      const error = editorError({
        code: 'RESOURCE_LIMIT',
        details: { resource: 'fileBytes', limit: MAX_PDF_FILE_BYTES },
      });
      this.#setState({
        phase: 'recoverableError',
        error,
        status: error.message,
      });
      return;
    }

    const generation = ++this.#generation;
    this.#engine?.terminate();
    this.#engine = null;
    const previousDisplay = this.#display;
    this.#display = null;
    this.#originalBytes = null;
    this.#displayBytes = null;
    this.#validatedBytes = null;
    this.#state = Object.freeze({
      ...INITIAL_STATE,
      generation,
      phase: 'opening',
      fontInventoryState: 'scanning',
      editingFonts: [],
      displayVersion: this.#state.displayVersion + 1,
      status: 'Opening PDF…',
    });
    this.#notify();
    if (previousDisplay !== null) await previousDisplay.destroy();

    let engine: ProductEngineClient | null = null;
    let display: PdfDisplayDocument | null = null;
    try {
      const source = new Uint8Array(await file.arrayBuffer());
      if (generation !== this.#generation) return;
      const originalBytes = Uint8Array.from(source);
      const engineBytes = Uint8Array.from(source);
      const displayBytes = Uint8Array.from(source);
      engine = this.dependencies.createEngine();
      await this.#fontVault.registerAllWith(engine);
      if (generation !== this.#generation) {
        engine.terminate();
        return;
      }
      const opened = await engine.open(engineBytes);
      if (generation !== this.#generation) {
        engine.terminate();
        return;
      }
      display = await this.dependencies.openDisplay(displayBytes);
      if (generation !== this.#generation) {
        engine.terminate();
        await display.destroy();
        return;
      }

      const analysis = await engine.analysePage(0);
      if (generation !== this.#generation) {
        engine.terminate();
        await display.destroy();
        return;
      }

      this.#engine = engine;
      this.#display = display;
      this.#originalBytes = originalBytes;
      this.#displayBytes = Uint8Array.from(source);
      this.#validatedBytes = null;
      this.#setState({
        phase: 'ready',
        fileName: file.name,
        pageIndex: 0,
        pageCount: display.pageCount,
        analysis,
        fonts: opened.fonts,
        status: 'Ready',
        error: null,
      }, generation);
      void this.#inspectDocumentFonts(engine, generation);
    } catch (error) {
      engine?.terminate();
      if (display !== null) await display.destroy();
      if (generation !== this.#generation) return;
      const mapped = editorError(error);
      this.#setState({
        phase: 'recoverableError',
        error: mapped,
        status: mapped.message,
      }, generation);
    }
  }

  async setPage(pageIndex: number): Promise<void> {
    if (this.#state.pageCount === 0) return;
    const clamped = Math.max(0, Math.min(
      this.#state.pageCount - 1,
      Math.trunc(pageIndex),
    ));
    this.#setState({
      pageIndex: clamped,
      phase: 'analysing',
      status: 'Checking page text…',
      ...this.#clearedSelection(),
    });
    if (await this.#analyseCurrentPage()) {
      this.#setState({ phase: 'ready', status: 'Ready' });
    }
  }

  setZoom(zoom: number, fitMode: FitMode = 'custom'): void {
    if (!Number.isFinite(zoom)) throw new RangeError('Zoom must be finite');
    this.#setState({
      zoom: Math.max(0.1, Math.min(4, zoom)),
      fitMode,
    });
  }

  setTool(tool: EditorTool): void {
    this.#setState({ tool });
  }

  setShowOverlays(value: boolean): void {
    this.#setState({ showOverlays: value });
  }

  async registerFont(
    source: Extract<FontSourceKind, 'local' | 'upload'>,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<FontDescriptor> {
    const engine = this.#engine;
    if (engine === null) throw new Error('Open a PDF before adding fonts');
    const descriptor = await this.#fontVault.register({ source, fileName, bytes }, engine);
    const currentEngine = this.#engine;
    if (currentEngine !== null && currentEngine !== engine) {
      await this.#fontVault.registerAllWith(currentEngine);
    }
    const fonts = this.#mergeFonts(this.#state.fonts, descriptor);
    const richEditor = this.#refreshRichEditorFonts(this.#state.richEditor, fonts);
    this.#setState(richEditor === null
      ? { fonts, richEditor }
      : { fonts, ...this.#invalidatedRichPreview(richEditor) });
    return descriptor;
  }

  async registerAndApplyFont(
    source: Extract<FontSourceKind, 'local' | 'upload'>,
    fileName: string,
    bytes: Uint8Array,
    target: FontApplicationTarget,
  ): Promise<FontApplicationResult> {
    const descriptor = await this.registerFont(source, fileName, bytes);
    const selection = this.#state.selection;
    const richEditor = this.#state.richEditor;
    if (
      target.generation !== this.#generation
      || target.pageIndex !== this.#state.pageIndex
      || selection?.kind !== 'text'
      || selection.textSelection.key !== target.selectionKey
      || richEditor === null
    ) {
      return Object.freeze({ descriptor, outcome: 'stale-selection' });
    }
    const textLength = richEditor.runs.reduce((total, run) => total + run.text.length, 0);
    const { start, end } = target.range;
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || end < start
      || end > textLength
    ) {
      return Object.freeze({ descriptor, outcome: 'stale-selection' });
    }
    const range = start === end
      ? Object.freeze({ start: 0, end: textLength })
      : Object.freeze({ start, end });
    if (range.start === range.end) {
      return Object.freeze({ descriptor, outcome: 'stale-selection' });
    }
    const selectedText = RichTextBuffer.fromRuns(richEditor.runs).text
      .slice(range.start, range.end)
      .normalize('NFC');
    const available = new Set(descriptor.inspection.codePoints);
    if ([...selectedText].some((character) => !available.has(character.codePointAt(0)!))) {
      return Object.freeze({ descriptor, outcome: 'missing-coverage' });
    }
    this.formatRichText(range, Object.freeze({
      fontId: descriptor.id,
      fontIntent: 'explicit-choice',
      style: Object.freeze({
        fontWeight: descriptor.inspection.weight,
        italicAngle: descriptor.inspection.italic
          ? descriptor.inspection.italicAngle || -12
          : 0,
      }),
    }));
    return Object.freeze({ descriptor, outcome: 'applied' });
  }

  listSessionFonts(): readonly FontDescriptor[] {
    return this.#fontVault.list();
  }

  selectSpan(spanKey: string): void {
    const analysis = this.#state.analysis;
    const index = analysis?.spanKeys.indexOf(spanKey) ?? -1;
    if (analysis === null || index < 0 || analysis.spans[index] === undefined) {
      this.#setState(this.#clearedSelection());
      return;
    }
    const selection: EditorSelection = Object.freeze({
      kind: 'span',
      spanKey,
      span: analysis.spans[index],
    });
    this.#setState({
      selection,
      replacement: selection.span.unicode ?? '',
      acceptSubstitution: false,
      preview: null,
      error: null,
      status: selection.span.capability.kind === 'readOnly'
        ? 'This text is available for inspection only'
        : 'Text selected',
    });
  }

  selectTextRange(
    lineKey: string,
    anchorGlyphIndex: number,
    focusGlyphIndex: number,
    groupKey: string | null,
  ): void {
    const analysis = this.#state.analysis;
    const line = analysis?.textLayout.lines.find((candidate) => candidate.key === lineKey);
    if (analysis === null || line === undefined) {
      this.#setState(this.#clearedSelection());
      return;
    }

    try {
      const textSelection = buildTextSelection(
        line,
        anchorGlyphIndex,
        focusGlyphIndex,
      );
      const selectedGroup = groupKey === null
        ? null
        : line.groups.find((group) => group.key === groupKey) ?? null;
      const exactGroupKey = selectedGroup !== null
        && selectedGroup.glyphRange.start === textSelection.glyphRange.start
        && selectedGroup.glyphRange.end === textSelection.glyphRange.end
        ? selectedGroup.key
        : null;
      const selection: EditorSelection = Object.freeze({
        kind: 'text',
        groupKey: exactGroupKey,
        textSelection,
      });
      const richEditor = this.#createRichEditor(textSelection, line, analysis.pageSpace);
      this.#setState({
        selection,
        replacement: textSelection.text,
        acceptSubstitution: false,
        preview: null,
        richEditor,
        error: null,
        status: textSelection.capability.kind === 'readOnly'
          ? 'This text is available for inspection only'
          : exactGroupKey === null
            ? 'Custom text selected'
            : 'Text group selected',
      });
    } catch {
      this.#setState(this.#clearedSelection());
    }
  }

  setReplacement(value: string): void {
    this.#setState({ replacement: value, preview: null });
  }

  replaceRichText(range: HalfOpenRange, text: string): void {
    const richEditor = this.#state.richEditor;
    if (this.#state.selection?.kind !== 'text' || richEditor === null) return;
    const buffer = RichTextBuffer.fromRuns(richEditor.runs).replace(range, text);
    this.#setRichRuns(buffer.runs);
  }

  formatRichText(range: HalfOpenRange, patch: RichTextFormatPatch): void {
    const richEditor = this.#state.richEditor;
    if (this.#state.selection?.kind !== 'text' || richEditor === null) return;
    const buffer = RichTextBuffer.fromRuns(richEditor.runs).format(range, patch);
    this.#setRichRuns(buffer.runs);
  }

  setRichAllowedWidth(width: number): void {
    const richEditor = this.#state.richEditor;
    if (richEditor === null || !Number.isFinite(width)) return;
    const bounded = Math.max(
      this.#state.selection?.kind === 'text'
        ? this.#state.selection.textSelection.bounds.width
        : 0,
      Math.min(richEditor.maxAllowedWidth, width),
    );
    this.#setState(this.#invalidatedRichPreview(richEditor, {
      allowedRegion: Object.freeze({ ...richEditor.allowedRegion, width: bounded }),
    }));
  }

  setRichSubstitutionConsent(fontId: string, accepted: boolean): void {
    const richEditor = this.#state.richEditor;
    if (richEditor === null) return;
    const consent = new Set(richEditor.substitutionConsents);
    if (accepted) consent.add(fontId);
    else consent.delete(fontId);
    this.#setState(this.#invalidatedRichPreview(richEditor, {
      substitutionConsents: Object.freeze([...consent].sort()),
    }));
  }

  setAcceptSubstitution(value: boolean): void {
    this.#setState({ acceptSubstitution: value, preview: null });
  }

  async previewSelection(): Promise<void> {
    const engine = this.#engine;
    const selection = this.#state.selection;
    if (engine === null || selection === null) return;
    if (selection.kind === 'text') {
      await this.#previewRichSelection(engine, selection);
      return;
    }
    const generation = this.#generation;
    const revision = engine.revision;
    const pageIndex = this.#state.pageIndex;
    const replacement = this.#state.replacement;
    const acceptSubstitution = this.#state.acceptSubstitution;
    this.#setState({
      phase: 'previewing',
      preview: null,
      status: 'Checking replacement…',
      error: null,
    });

    try {
      const preview = await engine.previewReplacement(
        selection.spanKey,
        replacement,
        acceptSubstitution,
      );
      if (
        generation !== this.#generation
        || revision !== engine.revision
        || pageIndex !== this.#state.pageIndex
        || this.#state.selection?.kind !== 'span'
        || selection.spanKey !== this.#state.selection.spanKey
        || replacement !== this.#state.replacement
        || acceptSubstitution !== this.#state.acceptSubstitution
      ) return;
      this.#setState({
        phase: 'ready',
        preview,
        status: preview.canApply ? 'Replacement is ready to apply' : 'Replacement cannot be applied',
      }, generation);
    } catch (error) {
      if (generation !== this.#generation) return;
      const mapped = editorError(error);
      this.#setState({
        phase: 'recoverableError',
        preview: null,
        error: mapped,
        status: mapped.message,
      }, generation);
    }
  }

  async applySelection(): Promise<void> {
    const engine = this.#engine;
    const selection = this.#state.selection;
    if (engine !== null && selection?.kind === 'text') {
      await this.#applyRichSelection(engine, selection);
      return;
    }
    const preview = this.#state.preview;
    const replacement = this.#state.replacement;
    const acceptSubstitution = this.#state.acceptSubstitution;
    if (
      engine === null
      || selection === null
      || selection.kind !== 'span'
      || preview === null
      || !preview.canApply
      || preview.normalisedReplacement.length === 0
      || preview.preconditions.spanKey !== selection.spanKey
      || preview.preconditions.expectedNormalisedReplacement
        !== preview.normalisedReplacement
      || preview.preconditions.expectedSubstitutionAccepted
        !== preview.substitutionAccepted
      || preview.substitutionAccepted !== acceptSubstitution
      || (
        preview.capability.kind === 'replacementWithSubstitution'
        && !acceptSubstitution
      )
      || this.#displayBytes === null
    ) return;

    const generation = this.#generation;
    const revision = engine.revision;
    const pageIndex = this.#state.pageIndex;
    const previousDisplay = this.#displayBytes.slice();
    this.#setState({
      phase: 'applying',
      status: 'Applying replacement…',
      error: null,
    });

    try {
      const result = await engine.applyValidated({
        spanKey: selection.spanKey,
        replacement,
        acceptSubstitution,
        preconditions: preview.preconditions,
      });
      if (
        generation !== this.#generation
        || revision === null
        || pageIndex !== this.#state.pageIndex
        || this.#state.selection?.kind !== 'span'
        || selection.spanKey !== this.#state.selection.spanKey
        || replacement !== this.#state.replacement
        || acceptSubstitution !== this.#state.acceptSubstitution
        || preview !== this.#state.preview
      ) return;

      const nextDisplay = await this.dependencies.openDisplay(result.bytes.slice());
      if (generation !== this.#generation) {
        await nextDisplay.destroy();
        return;
      }
      await this.#display?.destroy();
      this.#display = nextDisplay;
      this.#displayBytes = result.bytes.slice();
      this.#validatedBytes = result.bytes.slice();
      this.#setState({
        phase: 'analysing',
        hasEdits: true,
        downloadAvailable: true,
        displayVersion: this.#state.displayVersion + 1,
        status: 'Checking the edited page…',
        error: null,
        ...this.#clearedSelection(),
      }, generation);
      if (await this.#analyseCurrentPage()) {
        this.#setState({ phase: 'ready', status: 'Replacement applied' }, generation);
      }
    } catch (error) {
      if (generation !== this.#generation) return;
      await this.#recoverFrom(previousDisplay, error);
    }
  }

  async reset(): Promise<void> {
    if (this.#originalBytes === null || this.#state.fileName === null) return;
    const original = this.#originalBytes.slice();
    const fileName = this.#state.fileName;
    const pageIndex = this.#state.pageIndex;
    const generation = ++this.#generation;
    this.#setState({
      generation,
      phase: 'recovering',
      fontInventoryState: 'scanning',
      editingFonts: [],
      status: 'Restoring original PDF…',
      error: null,
    });
    this.#engine?.terminate();
    this.#engine = null;
    const previousDisplay = this.#display;
    this.#display = null;
    if (previousDisplay !== null) await previousDisplay.destroy();

    await this.#openKnownGood({
      bytes: original,
      fileName,
      pageIndex,
      generation,
      hasEdits: false,
      validatedBytes: null,
      status: 'Original restored',
    });
  }

  getDisplayPage(pageIndex: number): Promise<PDFPageProxy> {
    if (this.#display === null) {
      return Promise.reject(new Error('No PDF document is open'));
    }
    return this.#display.getPage(pageIndex);
  }

  download(): DownloadAsset {
    if (this.#validatedBytes === null || this.#state.fileName === null) {
      throw new Error('Download requires at least one validated edit');
    }
    return Object.freeze({
      sourceFileName: this.#state.fileName,
      bytes: this.#validatedBytes.slice(),
    });
  }

  reportDisplayError(error: unknown): void {
    const mapped = editorError(error);
    this.#setState({
      phase: 'recoverableError',
      error: mapped,
      status: mapped.message,
    });
  }

  async close(): Promise<void> {
    const generation = ++this.#generation;
    const engine = this.#engine;
    const display = this.#display;
    this.#engine = null;
    this.#display = null;
    this.#originalBytes = null;
    this.#displayBytes = null;
    this.#validatedBytes = null;
    this.#fontVault.dispose();
    engine?.terminate();
    if (display !== null) await display.destroy();
    this.#state = Object.freeze({ ...INITIAL_STATE, generation });
    this.#notify();
  }

  #createRichEditor(
    selection: Extract<EditorSelection, { kind: 'text' }>['textSelection'],
    line: NonNullable<EditorSnapshot['analysis']>['textLayout']['lines'][number],
    pageSpace: NonNullable<EditorSnapshot['analysis']>['pageSpace'],
  ): EditorRichState {
    const unresolved = selection.styleRuns.map((run): EditorRichTextRun => Object.freeze({
      text: run.text,
      style: run.style,
      fontId: '',
      fontIntent: 'preserve-source',
      decorations: run.decorations,
    }));
    const resolved = this.#resolveRichRuns(unresolved, this.#state.fonts);
    const allowedRegion = deriveRichFitRegion(
      selection.bounds,
      line.glyphs
        .slice(selection.glyphRange.start, selection.glyphRange.end)
        .map(({ bounds }) => bounds),
      line.baselineDirection,
    );
    const nextGlyph = line.glyphs[selection.glyphRange.end];
    const [pageWidth] = canonicalPageSize(pageSpace);
    const maxRight = nextGlyph?.bounds.x ?? pageWidth;
    const maxAllowedWidth = Math.max(allowedRegion.width, maxRight - allowedRegion.x);
    return Object.freeze({
      runs: resolved.runs,
      allowedRegion,
      maxAllowedWidth,
      substitutionConsents: Object.freeze([]),
      fontStatuses: resolved.statuses,
      preview: null,
    });
  }

  #setRichRuns(runs: readonly EditorRichTextRun[]): void {
    const current = this.#state.richEditor;
    if (current === null) return;
    const resolved = this.#resolveRichRuns(runs, this.#state.fonts);
    this.#setState({
      replacement: resolved.runs.map(({ text }) => text).join(''),
      ...this.#invalidatedRichPreview(current, {
        runs: resolved.runs,
        fontStatuses: resolved.statuses,
      }),
    });
  }

  #invalidatedRichPreview(
    current: EditorRichState,
    patch: Partial<EditorRichState> = {},
  ): Partial<EditorSnapshot> {
    return {
      phase: 'ready',
      status: 'Waiting to shape the latest text…',
      error: null,
      richEditor: Object.freeze({ ...current, ...patch, preview: null }),
    };
  }

  #refreshRichEditorFonts(
    current: EditorRichState | null,
    fonts: readonly FontDescriptor[],
  ): EditorRichState | null {
    if (current === null) return null;
    const resolved = this.#resolveRichRuns(current.runs, fonts);
    return Object.freeze({
      ...current,
      runs: resolved.runs,
      fontStatuses: resolved.statuses,
      preview: null,
    });
  }

  #resolveRichRuns(
    runs: readonly EditorRichTextRun[],
    fonts: readonly FontDescriptor[],
  ): Readonly<{
    runs: readonly EditorRichTextRun[];
    statuses: readonly EditorRichFontStatus[];
  }> {
    const statuses = new Map<string, EditorRichFontStatus>();
    const resolvedRuns = runs.map((run, index): EditorRichTextRun => {
      const explicit = run.fontIntent === 'explicit-choice'
        ? fonts.find(({ id }) => id === run.fontId)
        : undefined;
      const requirement: FontRequirement = Object.freeze({
        postscriptName: run.style.fontBaseName,
        familyName: run.style.fontBaseName,
        subfamilyName: null,
        weight: run.style.fontWeight ?? 400,
        italic: (run.style.italicAngle ?? 0) !== 0,
        requiredCodePoints: Object.freeze([...new Set(
          [...run.text].map((character) => character.codePointAt(0)!),
        )]),
        exactByteHash: null,
        metricsFingerprint: null,
      });
      const styleCompatibleFonts = run.fontIntent === 'preserve-source'
        ? fonts.filter(({ inspection }) =>
            inspection.weight === requirement.weight &&
            inspection.italic === requirement.italic)
        : fonts;
      const resolution = explicit === undefined
        ? resolveFontRequirement(requirement, styleCompatibleFonts)
        : Object.freeze({ kind: 'exact' as const, font: explicit, reasons: ['user-selected'] });
      const statusKey = `${run.style.fontBaseName ?? 'unknown'}:${run.style.fontWeight ?? 400}:${index}`;
      if (resolution.kind === 'unavailable') {
        statuses.set(statusKey, Object.freeze({
          key: statusKey,
          requestedName: run.style.fontBaseName,
          fontId: null,
          actualName: null,
          source: null,
          matchKind: 'unavailable',
          reasons: resolution.reasons,
        }));
        return Object.freeze({ ...run, fontId: '' });
      }
      const descriptor = resolution.font;
      statuses.set(statusKey, Object.freeze({
        key: statusKey,
        requestedName: run.style.fontBaseName,
        fontId: descriptor.id,
        actualName: descriptor.inspection.fullName ?? descriptor.inspection.postscriptName,
        source: descriptor.source,
        matchKind: resolution.kind,
        reasons: resolution.reasons,
      }));
      return Object.freeze({ ...run, fontId: descriptor.id });
    });
    return Object.freeze({
      runs: Object.freeze(resolvedRuns),
      statuses: Object.freeze([...statuses.values()]),
    });
  }

  #richPayload(
    selection: Extract<EditorSelection, { kind: 'text' }>,
    richEditor: EditorRichState,
  ): RichReplacementPayload {
    return Object.freeze({
      selection: Object.freeze({
        lineKey: selection.textSelection.lineKey,
        anchorGlyphIndex: selection.textSelection.glyphRange.start,
        focusGlyphIndex: selection.textSelection.glyphRange.end - 1,
      }),
      runs: Object.freeze(richEditor.runs
        .filter(({ text }) => text.length > 0)
        .map((run) => Object.freeze({
          ...run,
          style: Object.freeze({ ...run.style }),
          decorations: Object.freeze({ ...run.decorations }),
        }))),
      allowedRegion: Object.freeze({ ...richEditor.allowedRegion }),
      substitutionConsents: Object.freeze([...richEditor.substitutionConsents]),
    });
  }

  async #previewRichSelection(
    engine: ProductEngineClient,
    selection: Extract<EditorSelection, { kind: 'text' }>,
  ): Promise<void> {
    const current = this.#state.richEditor;
    const replacement = current?.runs.map(({ text }) => text).join('') ?? '';
    if (
      current === null || replacement.length === 0 ||
      current.runs.some(({ fontId }) => fontId.length === 0)
    ) return;
    const pending = Object.freeze({ ...current, preview: null });
    const generation = this.#generation;
    const revision = engine.revision;
    const pageIndex = this.#state.pageIndex;
    this.#setState({
      phase: 'previewing',
      richEditor: pending,
      status: 'Checking rich text and fit…',
      error: null,
    });
    try {
      const preview = await engine.previewRichReplacement(this.#richPayload(selection, pending));
      if (!this.#isCurrentRichPreview(
        engine,
        generation,
        revision,
        pageIndex,
        selection.textSelection.key,
        pending,
      )) return;
      this.#setState({
        phase: 'ready',
        richEditor: Object.freeze({ ...pending, preview }),
        status: !preview.fits
          ? 'Replacement does not fit the allowed line region'
          : preview.requiredSubstitutionConsents.length > 0
            ? 'Review and accept the font substitution'
            : 'Replacement is ready to apply',
      }, generation);
    } catch (error) {
      if (!this.#isCurrentRichPreview(
        engine,
        generation,
        revision,
        pageIndex,
        selection.textSelection.key,
        pending,
      )) return;
      const mapped = editorError(error);
      this.#setState({
        phase: 'recoverableError',
        richEditor: Object.freeze({ ...pending, preview: null }),
        error: mapped,
        status: mapped.message,
      }, generation);
    }
  }

  #isCurrentRichPreview(
    engine: ProductEngineClient,
    generation: number,
    revision: number | null,
    pageIndex: number,
    selectionKey: string,
    pending: EditorRichState,
  ): boolean {
    return generation === this.#generation
      && revision === engine.revision
      && pageIndex === this.#state.pageIndex
      && this.#state.selection?.kind === 'text'
      && this.#state.selection.textSelection.key === selectionKey
      && this.#state.richEditor === pending;
  }

  async #applyRichSelection(
    engine: ProductEngineClient,
    selection: Extract<EditorSelection, { kind: 'text' }>,
  ): Promise<void> {
    const richEditor = this.#state.richEditor;
    const preview = richEditor?.preview;
    if (
      richEditor === null || preview == null || !preview.fits ||
      preview.requiredSubstitutionConsents.length > 0 || this.#displayBytes === null ||
      preview.selectionKey !== selection.textSelection.key
    ) return;
    const payload = this.#richPayload(selection, richEditor);
    const generation = this.#generation;
    const revision = engine.revision;
    const pageIndex = this.#state.pageIndex;
    const previousDisplay = this.#displayBytes.slice();
    this.#setState({ phase: 'applying', status: 'Applying replacement…', error: null });
    try {
      const result = await engine.applyRichValidated(payload, preview.preconditions);
      if (
        generation !== this.#generation || revision === null ||
        pageIndex !== this.#state.pageIndex || this.#state.selection?.kind !== 'text' ||
        this.#state.selection.textSelection.key !== selection.textSelection.key ||
        this.#state.richEditor !== richEditor
      ) return;
      const nextDisplay = await this.dependencies.openDisplay(result.bytes.slice());
      if (generation !== this.#generation) {
        await nextDisplay.destroy();
        return;
      }
      await this.#display?.destroy();
      this.#display = nextDisplay;
      this.#displayBytes = result.bytes.slice();
      this.#validatedBytes = result.bytes.slice();
      this.#setState({
        phase: 'analysing',
        hasEdits: true,
        downloadAvailable: true,
        displayVersion: this.#state.displayVersion + 1,
        status: 'Checking the edited page…',
        error: null,
        ...this.#clearedSelection(),
      }, generation);
      if (await this.#analyseCurrentPage()) {
        this.#setState({ phase: 'ready', status: 'Replacement applied' }, generation);
      }
    } catch (error) {
      if (generation !== this.#generation) return;
      await this.#recoverFrom(previousDisplay, error);
    }
  }

  #mergeFonts(
    fonts: readonly FontDescriptor[],
    descriptor: FontDescriptor,
  ): readonly FontDescriptor[] {
    return Object.freeze([
      ...fonts.filter(({ id }) => id !== descriptor.id),
      descriptor,
    ]);
  }

  async #analyseCurrentPage(): Promise<boolean> {
    const engine = this.#engine;
    if (engine === null) return false;
    const generation = this.#generation;
    const pageIndex = this.#state.pageIndex;
    try {
      const analysis = await engine.analysePage(pageIndex);
      if (
        generation !== this.#generation
        || pageIndex !== this.#state.pageIndex
        || engine !== this.#engine
      ) return false;
      this.#setState({ analysis }, generation);
      return true;
    } catch (error) {
      if (generation !== this.#generation) return false;
      const mapped = editorError(error);
      this.#setState({
        phase: 'recoverableError',
        analysis: null,
        error: mapped,
        status: mapped.message,
      }, generation);
      return false;
    }
  }

  async #recoverFrom(previousDisplay: Uint8Array, cause: unknown): Promise<void> {
    const fileName = this.#state.fileName;
    if (fileName === null) return;
    const pageIndex = this.#state.pageIndex;
    const generation = ++this.#generation;
    const hasEdits = this.#validatedBytes !== null;
    const validatedBytes = this.#validatedBytes?.slice() ?? null;
    this.#setState({
      generation,
      phase: 'recovering',
      fontInventoryState: 'scanning',
      editingFonts: [],
      status: 'Restoring the last validated document…',
      error: null,
      ...this.#clearedSelection(),
    });
    this.#engine?.terminate();
    this.#engine = null;
    const display = this.#display;
    this.#display = null;
    if (display !== null) await display.destroy();

    await this.#openKnownGood({
      bytes: previousDisplay,
      fileName,
      pageIndex,
      generation,
      hasEdits,
      validatedBytes,
      status: isFileByteLimit(cause) ? FILE_LIMIT_RESTORED_STATUS : RESTORED_STATUS,
    });
  }

  async #openKnownGood(input: Readonly<{
    bytes: Uint8Array;
    fileName: string;
    pageIndex: number;
    generation: number;
    hasEdits: boolean;
    validatedBytes: Uint8Array | null;
    status: string;
  }>): Promise<void> {
    const engine = this.dependencies.createEngine();
    let display: PdfDisplayDocument | null = null;
    try {
      await this.#fontVault.registerAllWith(engine);
      if (input.generation !== this.#generation) {
        engine.terminate();
        return;
      }
      const [opened, openedDisplay] = await Promise.all([
        engine.open(input.bytes.slice()),
        this.dependencies.openDisplay(input.bytes.slice()),
      ]);
      display = openedDisplay;
      if (input.generation !== this.#generation) {
        engine.terminate();
        await display.destroy();
        return;
      }
      const pageIndex = Math.max(0, Math.min(
        display.pageCount - 1,
        input.pageIndex,
      ));
      const analysis = await engine.analysePage(pageIndex);
      if (input.generation !== this.#generation) {
        engine.terminate();
        await display.destroy();
        return;
      }
      this.#engine = engine;
      this.#display = display;
      this.#displayBytes = input.bytes.slice();
      this.#validatedBytes = input.validatedBytes?.slice() ?? null;
      this.#setState({
        phase: 'ready',
        fileName: input.fileName,
        pageIndex,
        pageCount: display.pageCount,
        analysis,
        fonts: opened.fonts,
        hasEdits: input.hasEdits,
        downloadAvailable: input.validatedBytes !== null,
        displayVersion: this.#state.displayVersion + 1,
        status: input.status,
        error: null,
        ...this.#clearedSelection(),
      }, input.generation);
      void this.#inspectDocumentFonts(engine, input.generation);
    } catch (error) {
      engine.terminate();
      if (display !== null) await display.destroy();
      if (input.generation !== this.#generation) return;
      const mapped = editorError(error);
      this.#setState({
        phase: 'fatalError',
        error: mapped,
        status: mapped.message,
      }, input.generation);
    }
  }

  async #inspectDocumentFonts(
    engine: ProductEngineClient,
    generation: number,
  ): Promise<void> {
    try {
      const editingFonts = await engine.inspectDocumentFonts();
      if (generation !== this.#generation || engine !== this.#engine) return;
      this.#setState({
        fontInventoryState: 'ready',
        editingFonts: Object.freeze([...editingFonts]),
      }, generation);
    } catch {
      if (generation !== this.#generation || engine !== this.#engine) return;
      this.#setState({
        fontInventoryState: 'failed',
        editingFonts: [],
      }, generation);
    }
  }

  #clearedSelection(): Pick<
    EditorSnapshot,
    'selection' | 'replacement' | 'acceptSubstitution' | 'preview' | 'richEditor'
  > {
    return {
      selection: null,
      replacement: '',
      acceptSubstitution: false,
      preview: null,
      richEditor: null,
    };
  }

  #setState(
    patch: Partial<EditorSnapshot>,
    generation = this.#generation,
  ): void {
    if (generation !== this.#generation) return;
    this.#state = Object.freeze({
      ...this.#state,
      ...patch,
      generation: this.#generation,
    });
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

export function createDefaultEditorController(): EditorController {
  return new EditorController({
    createEngine: () => new ProductEngineClient(new WorkerTransport()),
    openDisplay: (bytes) => PdfDisplayDocument.open(bytes),
  });
}
