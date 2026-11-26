import {
  buildTextSelection,
  canonicalPageSize,
  MAX_PDF_FILE_BYTES,
  parsePositionedImageDimensions,
  PROVISIONAL_LIMITS,
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
import {
  FileAccessError,
  requestWritePermission,
  writePdfFile,
  type WritablePdfHandle,
} from '../file-access';
import { TabFontVault } from '../fonts/tab-font-vault';
import {
  RichTextBuffer,
  type EditorRichTextRun,
  type RichTextFormatPatch,
} from '../editing/rich-text-buffer';
import { deriveRichFitRegion } from '../editing/rich-fit-region';
import {
  IMAGE_INSERTION_POLICY_MESSAGE,
  editorError,
  type EditorError,
  type EditorImagePlacement,
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

export type ImageInsertionContext = Readonly<{
  generation: number;
  pageIndex: number;
  center: Readonly<{ x: number; y: number }>;
}>;

type SessionImage = Readonly<{
  placement: EditorImagePlacement;
  bytes: Uint8Array;
}>;

type SavedImage = Readonly<{
  pageIndex: number;
  bounds: CanonicalBounds;
  format: 'png' | 'jpeg';
  bytes: Uint8Array;
}>;

type SavedDocumentCheckpoint = Readonly<{
  baseBytes: Uint8Array;
  persistedBytes: Uint8Array;
  images: readonly SavedImage[];
}>;

type SavePayload = Readonly<{
  generation: number;
  checkpoint: SavedDocumentCheckpoint;
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
  images: [],
  selectedImageId: null,
  imageError: null,
  isDownloading: false,
  isSaving: false,
  hasEdits: false,
  hasUnsavedChanges: false,
  hasWritableFileHandle: false,
  downloadAvailable: false,
  displayVersion: 0,
  status: 'Open a PDF to begin',
  error: null,
});

const MAX_IMAGE_FILE_BYTES = MAX_PDF_FILE_BYTES;

function imageFormat(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  return null;
}

function encodeOrientedJpeg(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (context === null) return Promise.reject(new Error('Image normalisation canvas is unavailable'));
  context.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('Oriented JPEG could not be encoded'));
      else resolve(blob);
    }, 'image/jpeg', 0.95);
  });
}

function validImageBounds(bounds: CanonicalBounds): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    && bounds.width > 0
    && bounds.height > 0
    && Number.isFinite(bounds.x + bounds.width)
    && Number.isFinite(bounds.y + bounds.height);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left === right) return true;
  const cached = byteEqualityCache.get(left)?.get(right);
  if (cached !== undefined) return cached;
  const equal = left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
  const leftResults = byteEqualityCache.get(left) ?? new WeakMap<Uint8Array, boolean>();
  const rightResults = byteEqualityCache.get(right) ?? new WeakMap<Uint8Array, boolean>();
  leftResults.set(right, equal);
  rightResults.set(left, equal);
  byteEqualityCache.set(left, leftResults);
  byteEqualityCache.set(right, rightResults);
  return equal;
}

const byteEqualityCache = new WeakMap<Uint8Array, WeakMap<Uint8Array, boolean>>();

function draftSignature(snapshot: EditorSnapshot): string | null {
  const selection = snapshot.selection;
  if (selection === null) return null;
  if (selection.kind === 'span') {
    return JSON.stringify({
      selection: selection.spanKey,
      replacement: snapshot.replacement,
    });
  }
  return JSON.stringify({
    selection: selection.textSelection.key,
    runs: (snapshot.richEditor?.runs ?? []).map((run) => ({
      text: run.text,
      style: run.style,
      decorations: run.decorations,
      fontIntent: run.fontIntent,
      explicitFontId: run.fontIntent === 'explicit-choice' ? run.fontId : null,
    })),
  });
}

export class EditorController {
  readonly #listeners = new Set<() => void>();
  #state: EditorSnapshot = INITIAL_STATE;
  #generation = 0;
  #engine: ProductEngineClient | null = null;
  #display: PdfDisplayDocument | null = null;
  #originalBytes: Uint8Array | null = null;
  #displayBytes: Uint8Array | null = null;
  #validatedBytes: Uint8Array | null = null;
  #activeFileHandle: WritablePdfHandle | null = null;
  #savedCheckpoint: SavedDocumentCheckpoint | null = null;
  #draftCheckpoint: string | null = null;
  #saveQueue: Promise<void> = Promise.resolve();
  #activeSaveCount = 0;
  readonly #fontVault: TabFontVault;
  readonly #imageAssets = new Map<string, SessionImage>();
  #imageInsertionRequest = 0;
  #imageInsertionAllowed = true;
  #imagePlacementVersion = 0;
  #nextImageId = 1;

  constructor(private readonly dependencies: EditorDependencies) {
    this.#fontVault = dependencies.fontVault ?? new TabFontVault();
  }

  getSnapshot(): EditorSnapshot {
    return this.#state;
  }

  canInsertImages(): boolean {
    return this.#imageInsertionAllowed;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async open(file: File, fileHandle?: WritablePdfHandle): Promise<void> {
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
    this.#imageInsertionRequest += 1;
    this.#imageInsertionAllowed = true;
    this.#releaseImages();
    this.#engine?.terminate();
    this.#engine = null;
    const previousDisplay = this.#display;
    this.#display = null;
    this.#originalBytes = null;
    this.#displayBytes = null;
    this.#validatedBytes = null;
    this.#activeFileHandle = null;
    this.#savedCheckpoint = null;
    this.#draftCheckpoint = null;
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
      this.#imageInsertionAllowed = opened.imageInsertionAllowed;
      this.#originalBytes = originalBytes;
      this.#displayBytes = Uint8Array.from(source);
      this.#validatedBytes = null;
      this.#activeFileHandle = fileHandle ?? null;
      this.#savedCheckpoint = Object.freeze({
        baseBytes: originalBytes,
        persistedBytes: originalBytes.slice(),
        images: Object.freeze([]),
      });
      this.#setState({
        phase: 'ready',
        fileName: file.name,
        pageIndex: 0,
        pageCount: display.pageCount,
        analysis,
        fonts: opened.fonts,
        status: 'Ready',
        error: null,
        imageError: opened.imageInsertionAllowed ? null : IMAGE_INSERTION_POLICY_MESSAGE,
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
    if (this.#state.phase === 'applying') return;
    const analysis = this.#state.analysis;
    const index = analysis?.spanKeys.indexOf(spanKey) ?? -1;
    if (analysis === null || index < 0 || analysis.spans[index] === undefined) {
      this.#draftCheckpoint = null;
      this.#setState(this.#clearedSelection());
      return;
    }
    const selection: EditorSelection = Object.freeze({
      kind: 'span',
      spanKey,
      span: analysis.spans[index],
    });
    const patch = {
      selection,
      selectedImageId: null,
      replacement: selection.span.unicode ?? '',
      acceptSubstitution: false,
      preview: null,
      error: null,
      status: selection.span.capability.kind === 'readOnly'
        ? 'This text is available for inspection only'
        : 'Text selected',
    };
    this.#rememberDraft(patch);
    this.#setState(patch);
  }

  clearSelection(): void {
    if (this.#state.phase === 'applying') return;
    if (
      this.#state.selection === null
      && this.#state.selectedImageId === null
      && this.#state.phase !== 'previewing'
    ) return;
    this.#draftCheckpoint = null;
    this.#setState({
      ...this.#clearedSelection(),
      phase: 'ready',
      status: 'Ready',
      error: null,
    });
  }

  async insertImage(file: File, context: ImageInsertionContext): Promise<void> {
    const request = ++this.#imageInsertionRequest;
    if (!this.#imageInsertionAllowed) {
      this.#setState({ imageError: IMAGE_INSERTION_POLICY_MESSAGE });
      return;
    }
    if (
      this.#engine === null
      || context.generation !== this.#generation
      || context.pageIndex !== this.#state.pageIndex
      || !Number.isFinite(context.center.x)
      || !Number.isFinite(context.center.y)
    ) return;

    const isCurrent = (): boolean => request === this.#imageInsertionRequest
      && context.generation === this.#generation
      && context.pageIndex === this.#state.pageIndex
      && this.#engine !== null;
    if (file.size <= 0 || file.size > MAX_IMAGE_FILE_BYTES) {
      this.#setState({ imageError: file.size > MAX_IMAGE_FILE_BYTES
        ? 'This image exceeds the 15 MiB image file limit.'
        : 'Choose a readable PNG or JPEG image.' });
      return;
    }

    let bytes: Uint8Array;
    let format: 'png' | 'jpeg';
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
      if (!isCurrent()) return;
      const detectedFormat = imageFormat(bytes);
      if (detectedFormat === null) {
        this.#setState({ imageError: 'Choose a readable PNG or JPEG image.' });
        return;
      }
      format = detectedFormat;
    } catch {
      if (isCurrent()) this.#setState({ imageError: 'This image could not be read. Choose another file.' });
      return;
    }
    if (!isCurrent()) return;

    let dimensions: ReturnType<typeof parsePositionedImageDimensions>;
    try {
      dimensions = parsePositionedImageDimensions(bytes, format);
    } catch {
      this.#setState({ imageError: 'Choose a readable PNG or JPEG image.' });
      return;
    }
    if (dimensions.pixels > PROVISIONAL_LIMITS.maxImagePixels) {
      this.#setState({ imageError: 'This image exceeds the supported 12-megapixel limit.' });
      return;
    }

    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
    let bitmap: ImageBitmap | null = null;
    const swapsDimensions = dimensions.orientation >= 5;
    const intrinsicWidth = swapsDimensions ? dimensions.height : dimensions.width;
    const intrinsicHeight = swapsDimensions ? dimensions.width : dimensions.height;
    let previewUrl: string;
    try {
      bitmap = await createImageBitmap(
        new Blob([bytes.slice().buffer], { type: mimeType }),
        { imageOrientation: 'from-image' },
      );
      if (!isCurrent()) return;
      if (
        bitmap.width !== intrinsicWidth
        || bitmap.height !== intrinsicHeight
      ) {
        this.#setState({ imageError: 'This image has invalid dimensions.' });
        return;
      }
      if (format === 'jpeg' && dimensions.orientation !== 1) {
        const oriented = await encodeOrientedJpeg(bitmap);
        if (!isCurrent()) return;
        if (oriented.size <= 0 || oriented.size > MAX_IMAGE_FILE_BYTES) {
          this.#setState({ imageError: 'The oriented JPEG exceeds the 15 MiB image file limit.' });
          return;
        }
        bytes = new Uint8Array(await oriented.arrayBuffer());
        if (!isCurrent()) return;
      }
      previewUrl = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mimeType }));
    } catch {
      if (isCurrent()) this.#setState({ imageError: 'This image could not be decoded. Choose a readable PNG or JPEG.' });
      return;
    } finally {
      bitmap?.close();
    }
    if (this.#state.phase === 'applying') {
      await this.#waitForApplyToFinish(context.generation, context.pageIndex);
    }
    if (!isCurrent()) {
      URL.revokeObjectURL(previewUrl);
      return;
    }

    const id = `image-${this.#nextImageId++}`;
    const width = intrinsicWidth;
    const height = intrinsicHeight;
    const placement: EditorImagePlacement = Object.freeze({
      id,
      pageIndex: context.pageIndex,
      bounds: Object.freeze({
        x: context.center.x - width / 2,
        y: context.center.y - height / 2,
        width,
        height,
      }),
      format,
      previewUrl,
    });
    this.#imageAssets.set(id, Object.freeze({ placement, bytes: bytes.slice() }));
    this.#imagePlacementVersion += 1;
    this.#setState({
      ...this.#clearedSelection(),
      images: Object.freeze([...this.#state.images, placement]),
      selectedImageId: id,
      imageError: null,
      hasEdits: true,
      downloadAvailable: true,
      status: 'Image inserted',
    }, context.generation);
  }

  selectImage(imageId: string): void {
    const asset = this.#imageAssets.get(imageId);
    if (
      asset === undefined
      || asset.placement.pageIndex !== this.#state.pageIndex
      || this.#state.phase === 'applying'
    ) return;
    this.#setState({
      ...this.#clearedSelection(),
      selectedImageId: imageId,
      imageError: null,
      status: 'Image selected',
    });
  }

  moveImage(imageId: string, bounds: CanonicalBounds): void {
    this.#setImageBounds(imageId, bounds);
  }

  setImageBounds(imageId: string, bounds: CanonicalBounds): void {
    this.#setImageBounds(imageId, bounds);
  }

  selectTextRange(
    lineKey: string,
    anchorGlyphIndex: number,
    focusGlyphIndex: number,
    groupKey: string | null,
  ): void {
    if (this.#state.phase === 'applying') return;
    const analysis = this.#state.analysis;
    const line = analysis?.textLayout.lines.find((candidate) => candidate.key === lineKey);
    if (analysis === null || line === undefined) {
      this.#draftCheckpoint = null;
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
      const patch = {
        selection,
        selectedImageId: null,
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
      };
      this.#rememberDraft(patch);
      this.#setState(patch);
    } catch {
      this.#draftCheckpoint = null;
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
    const isCurrent = (): boolean => (
      generation === this.#generation
      && revision === engine.revision
      && pageIndex === this.#state.pageIndex
      && this.#state.selection?.kind === 'span'
      && selection.spanKey === this.#state.selection.spanKey
      && replacement === this.#state.replacement
      && acceptSubstitution === this.#state.acceptSubstitution
    );
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
      if (!isCurrent()) return;
      this.#setState({
        phase: 'ready',
        preview,
        status: preview.canApply ? 'Replacement is ready to apply' : 'Replacement cannot be applied',
      }, generation);
    } catch (error) {
      if (!isCurrent()) return;
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
    const requestedGeneration = this.#generation;
    while (this.#activeSaveCount > 0) await this.#saveQueue;
    if (requestedGeneration !== this.#generation) return;
    if (this.#originalBytes === null || this.#state.fileName === null) return;
    this.#imageInsertionRequest += 1;
    this.#releaseImages();
    const original = this.#originalBytes.slice();
    const fileName = this.#state.fileName;
    const pageIndex = this.#state.pageIndex;
    const generation = ++this.#generation;
    this.#setState({
      generation,
      phase: 'recovering',
      images: [],
      selectedImageId: null,
      imageError: null,
      isDownloading: false,
      hasEdits: false,
      downloadAvailable: false,
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

  save(): Promise<void> {
    if (this.#state.phase !== 'ready') return Promise.resolve();
    const handle = this.#activeFileHandle;
    if (handle === null) {
      this.#setState({
        status: 'This browser cannot overwrite the opened file. Choose Save as... to save a copy.',
      });
      return Promise.resolve();
    }
    const permission = requestWritePermission(handle);
    return this.#enqueueSave(() => this.#saveTo(handle, false, permission));
  }

  saveAs(handle: WritablePdfHandle): Promise<void> {
    if (this.#state.phase !== 'ready' || this.#state.fileName === null) return Promise.resolve();
    return this.#enqueueSave(() => this.#saveTo(handle, true, Promise.resolve(true)));
  }

  async downloadCurrentDocument(): Promise<DownloadAsset | null> {
    const fileName = this.#state.fileName;
    if (fileName === null || this.#state.isDownloading) return null;
    const generation = this.#generation;
    this.#setState({ isDownloading: true }, generation);
    try {
      const payload = await this.#currentSavePayload();
      if (
        payload === null
        || generation !== this.#generation
        || fileName !== this.#state.fileName
      ) return null;
      return Object.freeze({
        sourceFileName: fileName,
        bytes: payload.checkpoint.persistedBytes.slice(),
      });
    } finally {
      if (generation === this.#generation && this.#state.isDownloading) {
        this.#setState({ isDownloading: false }, generation);
      }
    }
  }

  async downloadCurrent(): Promise<DownloadAsset | null> {
    if (this.#state.isDownloading || !this.#state.downloadAvailable) return null;
    if (this.#imageAssets.size === 0) {
      try {
        return this.download();
      } catch {
        return null;
      }
    }

    const engine = this.#engine;
    const fileName = this.#state.fileName;
    const revision = engine?.revision;
    if (engine === null || fileName === null || revision === null) return null;
    const generation = this.#generation;
    const placementVersion = this.#imagePlacementVersion;
    const images = [...this.#imageAssets.values()].map(({ placement, bytes }) => ({
      pageIndex: placement.pageIndex,
      bounds: Object.freeze({ ...placement.bounds }),
      format: placement.format,
      bytes: bytes.slice(),
    }));
    this.#setState({ isDownloading: true, imageError: null }, generation);
    try {
      const exported = await engine.exportPositionedImages(images);
      if (
        generation !== this.#generation
        || engine !== this.#engine
        || fileName !== this.#state.fileName
        || revision !== engine.revision
        || exported.revision !== revision
        || placementVersion !== this.#imagePlacementVersion
        || exported.bytes.byteLength === 0
      ) return null;
      return Object.freeze({ sourceFileName: fileName, bytes: exported.bytes.slice() });
    } catch (error) {
      if (
        generation === this.#generation
        && engine === this.#engine
        && placementVersion === this.#imagePlacementVersion
      ) {
        const mapped = editorError(error);
        this.#setState({
          imageError: mapped.message === IMAGE_INSERTION_POLICY_MESSAGE
            ? mapped.message
            : 'The image export failed validation. Your edits are unchanged; try again.',
        }, generation);
      }
      return null;
    } finally {
      if (generation === this.#generation && this.#state.isDownloading) {
        this.#setState({ isDownloading: false }, generation);
      }
    }
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
    this.#imageInsertionRequest += 1;
    this.#releaseImages();
    const engine = this.#engine;
    const display = this.#display;
    this.#engine = null;
    this.#display = null;
    this.#originalBytes = null;
    this.#displayBytes = null;
    this.#validatedBytes = null;
    this.#activeFileHandle = null;
    this.#savedCheckpoint = null;
    this.#draftCheckpoint = null;
    this.#imageInsertionAllowed = true;
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
    const unresolved = selection.styleRuns.map((run, sourceRunIndex): EditorRichTextRun => Object.freeze({
      text: run.text,
      style: run.style,
      fontId: '',
      fontIntent: 'preserve-source',
      decorations: run.decorations,
      sourceRunIndex,
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
          sourceRunIndex: run.sourceRunIndex ?? null,
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

  #waitForApplyToFinish(generation: number, pageIndex: number): Promise<void> {
    if (this.#state.phase !== 'applying') return Promise.resolve();
    return new Promise((resolve) => {
      let unsubscribe = (): void => undefined;
      let settled = false;
      const finish = (): void => {
        if (
          settled
          || this.#state.phase === 'applying'
            && generation === this.#generation
            && pageIndex === this.#state.pageIndex
        ) return;
        settled = true;
        unsubscribe();
        resolve();
      };
      unsubscribe = this.subscribe(finish);
      finish();
    });
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
      this.#imageInsertionAllowed = opened.imageInsertionAllowed;
      this.#displayBytes = input.bytes.slice();
      this.#validatedBytes = input.validatedBytes?.slice() ?? null;
      this.#setState({
        phase: 'ready',
        fileName: input.fileName,
        pageIndex,
        pageCount: display.pageCount,
        analysis,
        fonts: opened.fonts,
        hasEdits: input.hasEdits || this.#imageAssets.size > 0,
        downloadAvailable: input.validatedBytes !== null || this.#imageAssets.size > 0,
        displayVersion: this.#state.displayVersion + 1,
        status: input.status,
        error: null,
        imageError: opened.imageInsertionAllowed ? null : IMAGE_INSERTION_POLICY_MESSAGE,
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
    'selection' | 'replacement' | 'acceptSubstitution' | 'preview' | 'richEditor' | 'selectedImageId'
  > {
    return {
      selection: null,
      replacement: '',
      acceptSubstitution: false,
      preview: null,
      richEditor: null,
      selectedImageId: null,
    };
  }

  #setImageBounds(imageId: string, bounds: CanonicalBounds): void {
    const asset = this.#imageAssets.get(imageId);
    if (asset === undefined || !validImageBounds(bounds)) return;
    const placement = Object.freeze({
      ...asset.placement,
      bounds: Object.freeze({ ...bounds }),
    });
    this.#imageAssets.set(imageId, Object.freeze({ ...asset, placement }));
    this.#imagePlacementVersion += 1;
    this.#setState({
      images: Object.freeze(this.#state.images.map((image) =>
        image.id === imageId ? placement : image)),
      hasEdits: true,
      downloadAvailable: true,
    });
  }

  #releaseImages(): void {
    for (const { placement } of this.#imageAssets.values()) {
      URL.revokeObjectURL(placement.previewUrl);
    }
    if (this.#imageAssets.size > 0) this.#imagePlacementVersion += 1;
    this.#imageAssets.clear();
  }

  #enqueueSave(operation: () => Promise<void>): Promise<void> {
    this.#activeSaveCount += 1;
    this.#setState({ isSaving: true });
    const queued = this.#saveQueue.then(operation, operation);
    this.#saveQueue = queued.then(() => undefined, () => undefined);
    return queued.finally(() => {
      this.#activeSaveCount -= 1;
      if (this.#activeSaveCount === 0) this.#setState({ isSaving: false });
    });
  }

  async #saveTo(
    handle: WritablePdfHandle,
    adoptHandle: boolean,
    permission: Promise<boolean>,
  ): Promise<void> {
    const generation = this.#generation;
    if (this.#state.fileName === null) return;
    try {
      if (!await permission) throw new FileAccessError('permission-denied');
      const payload = await this.#currentSavePayload();
      if (payload === null) {
        this.#setState({
          status: 'The PDF could not be prepared for saving. Your changes are unchanged; try again.',
        }, generation);
        return;
      }
      await writePdfFile(handle, payload.checkpoint.persistedBytes, Promise.resolve(true));
      if (generation !== this.#generation) return;
      this.#savedCheckpoint = payload.checkpoint;
      const fileName = adoptHandle ? handle.name : this.#state.fileName;
      if (adoptHandle) this.#activeFileHandle = handle;
      this.#setState({
        fileName,
        status: `Saved ${handle.name}`,
      }, generation);
    } catch (error) {
      if (generation !== this.#generation) return;
      const targetName = adoptHandle ? handle.name : this.#state.fileName ?? handle.name;
      const message = error instanceof FileAccessError && error.code === 'permission-denied'
        ? `Permission to overwrite ${targetName} was denied. Choose Save as... to save a copy.`
        : `Could not save ${targetName}. Your changes are unchanged; try again or choose Save as...`;
      this.#setState({ status: message }, generation);
    }
  }

  async #currentSavePayload(): Promise<SavePayload | null> {
    const generation = this.#generation;
    const baseBytes = this.#validatedBytes ?? this.#originalBytes;
    if (baseBytes === null) return null;
    const images = Object.freeze([...this.#imageAssets.values()].map(({ placement, bytes }) =>
      Object.freeze({
        pageIndex: placement.pageIndex,
        bounds: Object.freeze({ ...placement.bounds }),
        format: placement.format,
        bytes,
      } satisfies SavedImage)));
    const imageVersion = this.#imagePlacementVersion;
    let persistedBytes = baseBytes.slice();
    if (images.length > 0) {
      const engine = this.#engine;
      const revision = engine?.revision;
      if (engine === null || revision === null || revision === undefined) return null;
      try {
        const exported = await engine.exportPositionedImages(images.map((image) => ({
          ...image,
          bytes: image.bytes.slice(),
        })));
        if (
          generation !== this.#generation
          || engine !== this.#engine
          || revision !== engine.revision
          || exported.revision !== revision
          || imageVersion !== this.#imagePlacementVersion
          || exported.bytes.byteLength === 0
        ) return null;
        persistedBytes = exported.bytes.slice();
      } catch {
        return null;
      }
    }
    return Object.freeze({
      generation,
      checkpoint: Object.freeze({
        baseBytes,
        persistedBytes,
        images,
      }),
    });
  }

  #setState(
    patch: Partial<EditorSnapshot>,
    generation = this.#generation,
  ): void {
    if (generation !== this.#generation) return;
    const next = {
      ...this.#state,
      ...patch,
      generation: this.#generation,
    };
    this.#state = Object.freeze({
      ...next,
      hasUnsavedChanges: this.#hasUnsavedChanges(next),
      hasWritableFileHandle: this.#activeFileHandle !== null,
    });
    this.#notify();
  }

  #hasUnsavedChanges(snapshot: EditorSnapshot): boolean {
    if (snapshot.fileName === null || this.#savedCheckpoint === null) return false;
    const baseBytes = this.#validatedBytes ?? this.#originalBytes;
    if (baseBytes === null || !equalBytes(baseBytes, this.#savedCheckpoint.baseBytes)) return true;
    const currentImages = [...this.#imageAssets.values()];
    if (currentImages.length !== this.#savedCheckpoint.images.length) return true;
    if (currentImages.some(({ placement, bytes }, index) => {
      const saved = this.#savedCheckpoint?.images[index];
      return saved === undefined
        || placement.pageIndex !== saved.pageIndex
        || placement.format !== saved.format
        || placement.bounds.x !== saved.bounds.x
        || placement.bounds.y !== saved.bounds.y
        || placement.bounds.width !== saved.bounds.width
        || placement.bounds.height !== saved.bounds.height
        || !equalBytes(bytes, saved.bytes);
    })) return true;
    const currentDraft = draftSignature(snapshot);
    return currentDraft !== null && currentDraft !== this.#draftCheckpoint;
  }

  #rememberDraft(patch: Partial<EditorSnapshot>): void {
    this.#draftCheckpoint = draftSignature({ ...this.#state, ...patch });
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
