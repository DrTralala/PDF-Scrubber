import { analysePage } from './analysis/analyse-page';
import {
  inspectDocumentFonts,
  type DocumentEditingFont,
} from './analysis/document-font-inventory';
import { classifyReplacement } from './classification/classify';
import type { EngineErrorCode, EngineErrorDescriptor } from './errors';
import { fingerprint } from './fingerprint';
import type {
  ResolvedFontAsset,
  SubstituteFontAsset,
} from './fonts/font-embedding';
import {
  FontRegistry,
  type FontDescriptor,
  type FontMatchKind,
  type FontRegistration,
  type FontRequirement,
} from './fonts/font-registry';
import { resolveFontRequirement } from './fonts/font-matching';
import { shapeText } from './fonts/harfbuzz-shaper';
import { groupPageText } from './layout/group-lines';
import { buildTextSelection } from './layout/selection';
import type { EngineLimits } from './limits';
import {
  spanAddressKey,
  type AnalysedPage,
  type AnalysedSpan,
  type AnalysedTextLayout,
  type AnalysedTextLine,
  type CanonicalBounds,
  type Capability,
  type EffectiveTextStyle,
  type TextDecorations,
} from './model';
import {
  applyRichReplacement as applyRichSelectionReplacement,
  previewRichReplacement as previewRichSelectionReplacement,
  type RichMutationResult,
  type RichReplacementMutationInput,
} from './mutation/replace-selection';
import {
  applyReplacement,
  previewReplacement,
} from './mutation/replace-span';
import {
  buildMutationPreconditions,
  buildSelectionMutationPreconditions,
  type MutationPreconditions,
  type SelectionMutationPreconditions,
} from './mutation/excise';
import type { ResolvedRichTextRun } from './mutation/redraw';
import {
  sourceRunAdvanceProfile,
  shapedRunAdvance,
  sourceRunExtent,
  sourceSpacingScale,
} from './mutation/source-spacing';
import { ObjectStore } from './pdf/object-store';
import {
  validateCandidateAgainstSource,
  type MutationExpectation,
  type RuntimeValidationEvidence,
} from './validation/pdfjs-validator';

export type CandidateValidator = (
  sourceBytes: Uint8Array,
  bytes: Uint8Array,
  expectation: MutationExpectation,
) => Promise<RuntimeValidationEvidence>;

export type PdfEngineSessionOptions = Readonly<{
  limits: EngineLimits;
  substituteFont: SubstituteFontAsset | (() => Promise<SubstituteFontAsset>);
  additionalBundledFonts?: () => Promise<readonly Readonly<{
    fileName: string;
    bytes: Uint8Array;
  }>[] >;
  validator?: CandidateValidator;
}>;

export type OpenedDocument = Readonly<{
  documentId: string;
  fingerprint: string;
  revision: 0;
  fonts: readonly FontDescriptor[];
}>;

export type SessionAnalysedPage = AnalysedPage & Readonly<{
  textLayout: AnalysedTextLayout;
}>;

export type RichFontIntent = 'preserve-source' | 'explicit-choice';

export type SessionRichTextRunInput = Readonly<{
  text: string;
  style: EffectiveTextStyle;
  fontId: string;
  fontIntent: RichFontIntent;
  decorations: TextDecorations;
  sourceRunIndex?: number | null;
}>;

export type SessionRichReplacementPayload = Readonly<{
  selection: Readonly<{
    lineKey: string;
    anchorGlyphIndex: number;
    focusGlyphIndex: number;
  }>;
  runs: readonly SessionRichTextRunInput[];
  allowedRegion: CanonicalBounds;
  substitutionConsents: readonly string[];
}>;

export type SessionRichReplacementPreconditions = SelectionMutationPreconditions & Readonly<{
  selectionKey: string;
  expectedCommandHash: string;
}>;

export type SessionRichReplacementPreview = Readonly<{
  commandHash: string;
  nextRevision: number;
  selectionKey: string;
  replacement: string;
  replacementBounds: CanonicalBounds;
  allowedRegion: CanonicalBounds;
  fits: boolean;
  requiredSubstitutionConsents: readonly string[];
  fontMatches: readonly Readonly<{
    fontId: string;
    matchKind: FontMatchKind;
  }>[];
  preconditions: SessionRichReplacementPreconditions;
}>;

export type SessionReplacementPreconditions = Readonly<
  MutationPreconditions & {
    spanKey: string;
    expectedNormalisedReplacement: string;
    expectedSubstitutionAccepted: boolean;
  }
>;

export type SessionReplacementPreview = Readonly<{
  capability: Capability;
  normalisedReplacement: string;
  canApply: boolean;
  substitutionAccepted: boolean;
  preconditions: SessionReplacementPreconditions;
}>;

export type SessionValidationEvidence = Readonly<{
  candidateId: string;
  candidateHash: string;
  valid: boolean;
  checks: readonly string[];
  revision: number;
}>;

export type SessionApplyResult = Readonly<{
  candidateId: string;
  revision: number;
  commandHash: string;
  candidateHash: string;
  fontResourceName: string;
}>;

export type SessionRichApplyResult = Readonly<{
  candidateId: string;
  revision: number;
  commandHash: string;
  candidateHash: string;
  fontResourceNames: readonly string[];
  replacementBounds: CanonicalBounds;
}>;

type SessionCandidate = {
  readonly id: string;
  readonly store: ObjectStore;
  readonly bytes: Uint8Array;
  readonly revision: number;
  readonly commandHash: string;
  readonly candidateHash: string;
  readonly expectation: MutationExpectation;
  readonly fontResourceNames: readonly string[];
  readonly replacementBounds: CanonicalBounds | null;
};

type Session = {
  store: ObjectStore;
  bytes: Uint8Array;
  readonly fingerprint: string;
  revision: number;
  readonly spans: Map<string, AnalysedSpan>;
  readonly spanPages: Map<string, number>;
  readonly lines: Map<string, AnalysedTextLine>;
  expectation: MutationExpectation | null;
  candidateHash: string;
  pendingCandidate: SessionCandidate | null;
  readonly validations: Map<string, SessionValidationEvidence>;
  readonly exported: Set<string>;
};

export class SessionError extends Error implements EngineErrorDescriptor {
  readonly code: EngineErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: EngineErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function intersects(left: AnalysedSpan['bounds'], right: AnalysedSpan['bounds']): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

type AnalysedLineGlyph = AnalysedTextLine['glyphs'][number];

function sameObjectReference(
  left: Readonly<{ objectNumber: number; generationNumber: number }>,
  right: Readonly<{ objectNumber: number; generationNumber: number }>,
): boolean {
  return left.objectNumber === right.objectNumber &&
    left.generationNumber === right.generationNumber;
}

function sameStreamPath(
  left: AnalysedSpan['address']['streamPath'],
  right: AnalysedSpan['address']['streamPath'],
): boolean {
  return left.length === right.length && left.every((segment, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      segment.kind === candidate.kind &&
      segment.resourceName === candidate.resourceName &&
      sameObjectReference(segment.ref, candidate.ref);
  });
}

function sourceSpanForGlyph(
  session: Session,
  glyph: AnalysedLineGlyph,
): AnalysedSpan | null {
  for (const span of session.spans.values()) {
    if (
      sameObjectReference(span.address.pageRef, glyph.source.pageRef) &&
      sameStreamPath(span.address.streamPath, glyph.source.streamPath) &&
      glyph.source.operatorIndex >= span.address.operatorRange.start &&
      glyph.source.operatorIndex < span.address.operatorRange.end
    ) return span;
  }
  return null;
}

function copyAsset(asset: SubstituteFontAsset): SubstituteFontAsset {
  return Object.freeze({ ...asset, bytes: asset.bytes.slice() });
}

function codePoints(text: string): readonly number[] {
  return Object.freeze([...new Set([...text].map((character) => character.codePointAt(0)!))]);
}

function fontRequirement(run: SessionRichTextRunInput): FontRequirement {
  return Object.freeze({
    postscriptName: run.style.fontBaseName,
    familyName: run.style.fontBaseName,
    subfamilyName: null,
    weight: run.style.fontWeight ?? 400,
    italic: (run.style.italicAngle ?? 0) !== 0,
    requiredCodePoints: codePoints(run.text),
    exactByteHash: null,
    metricsFingerprint: null,
  });
}

export class PdfEngineSessions {
  readonly #sessions = new Map<string, Session>();
  readonly #limits: EngineLimits;
  readonly #fontSource: PdfEngineSessionOptions['substituteFont'];
  readonly #additionalBundledFonts: PdfEngineSessionOptions['additionalBundledFonts'];
  readonly #validator: CandidateValidator;
  readonly #fonts = new FontRegistry();
  #font: SubstituteFontAsset | null = null;
  #bundledFontsPromise: Promise<void> | null = null;
  #nextDocument = 1;

  constructor(options: PdfEngineSessionOptions) {
    this.#limits = options.limits;
    this.#fontSource = options.substituteFont;
    this.#additionalBundledFonts = options.additionalBundledFonts;
    this.#validator = options.validator ?? validateCandidateAgainstSource;
  }

  async openDocument(bytes: Uint8Array): Promise<OpenedDocument> {
    await this.#ensureBundledFonts();
    const owned = bytes.slice();
    const documentFingerprint = await fingerprint(owned);
    const store = await ObjectStore.open(owned, this.#limits);
    const documentId = `document-${this.#nextDocument}-${documentFingerprint.slice(0, 16)}`;
    this.#nextDocument += 1;
    this.#sessions.set(documentId, {
      store,
      bytes: owned,
      fingerprint: documentFingerprint,
      revision: 0,
      spans: new Map(),
      spanPages: new Map(),
      lines: new Map(),
      expectation: null,
      candidateHash: documentFingerprint,
      pendingCandidate: null,
      validations: new Map(),
      exported: new Set(),
    });
    return Object.freeze({
      documentId,
      fingerprint: documentFingerprint,
      revision: 0,
      fonts: this.#fonts.list(),
    });
  }

  registerFont(input: FontRegistration): Promise<FontDescriptor> {
    return this.#fonts.register(input);
  }

  async analysePage(
    documentId: string,
    revision: number,
    pageIndex: number,
  ): Promise<SessionAnalysedPage> {
    const session = this.#session(documentId, revision);
    const page = await analysePage(session.store, pageIndex);
    for (const span of page.spans) {
      const key = spanAddressKey(span.address);
      session.spans.set(key, span);
      session.spanPages.set(key, pageIndex);
    }
    const textLayout = groupPageText(page);
    for (const line of textLayout.lines) session.lines.set(line.key, line);
    return Object.freeze({ ...page, textLayout });
  }

  async inspectDocumentFonts(
    documentId: string,
    revision: number,
  ): Promise<readonly DocumentEditingFont[]> {
    const session = this.#session(documentId, revision);
    return inspectDocumentFonts(session.store);
  }

  async previewReplacement(
    documentId: string,
    revision: number,
    spanKey: string,
    replacement: string,
    acceptSubstitution: boolean,
  ): Promise<SessionReplacementPreview> {
    const session = this.#session(documentId, revision);
    const span = this.#span(session, spanKey);
    const preconditions = await buildMutationPreconditions(
      session.store,
      this.#pageIndexFor(session, span),
      span,
    );
    const classification = classifyReplacement(span, replacement, {
      existingFontCanEncode: false,
      substituteFontAvailable: true,
      substituteFontEmbeddable: true,
      replacementBounds: span.bounds,
      acceptSubstitution,
    });
    if (classification.canApply) {
      const font = await this.#substituteFont();
      await previewReplacement(session.store, {
        pageIndex: this.#pageIndexFor(session, span),
        span,
        replacement,
        classification,
        shapedRun: await shapeText({
          fontBytes: font.bytes,
          text: classification.normalisedReplacement,
        }),
        fontAsset: font,
        currentRevision: session.revision,
        expectedRevision: revision,
        preconditions,
      });
    }
    return Object.freeze({
      capability: Object.freeze({
        kind: classification.kind,
        reasons: classification.reasons,
      }),
      normalisedReplacement: classification.normalisedReplacement,
      canApply: classification.canApply,
      substitutionAccepted: classification.substitutionAccepted,
      preconditions: Object.freeze({
        spanKey,
        ...preconditions,
        expectedNormalisedReplacement: classification.normalisedReplacement,
        expectedSubstitutionAccepted: classification.substitutionAccepted,
      }),
    });
  }

  async previewRichReplacement(
    documentId: string,
    revision: number,
    payload: SessionRichReplacementPayload,
  ): Promise<SessionRichReplacementPreview> {
    const session = this.#session(documentId, revision);
    const input = await this.#richMutationInput(session, revision, payload);
    const preview = await previewRichSelectionReplacement(session.store, input);
    return Object.freeze({
      commandHash: preview.commandHash,
      nextRevision: preview.nextRevision,
      selectionKey: preview.selection.key,
      replacement: preview.replacement,
      replacementBounds: preview.replacementBounds,
      allowedRegion: preview.allowedRegion,
      fits: preview.fits,
      requiredSubstitutionConsents: preview.requiredSubstitutionConsents,
      fontMatches: Object.freeze([...new Map(input.runs.map(({ fontAsset }) => [
        fontAsset.descriptor.id,
        Object.freeze({
          fontId: fontAsset.descriptor.id,
          matchKind: fontAsset.matchKind,
        }),
      ])).values()]),
      preconditions: Object.freeze({
        selectionKey: preview.selection.key,
        expectedCommandHash: preview.commandHash,
        slices: input.preconditions.slices,
        decorations: input.preconditions.decorations,
      }),
    });
  }

  async applyRichReplacement(
    documentId: string,
    revision: number,
    payload: SessionRichReplacementPayload,
    supplied: SessionRichReplacementPreconditions,
  ): Promise<SessionRichApplyResult> {
    const session = this.#session(documentId, revision);
    const input = await this.#richMutationInput(session, revision, payload, supplied);
    if (input.selection.key !== supplied.selectionKey) {
      throw new SessionError('STALE_REVISION', 'Rich replacement selection no longer matches');
    }
    const preview = await previewRichSelectionReplacement(session.store, input);
    if (preview.commandHash !== supplied.expectedCommandHash) {
      throw new SessionError('STALE_REVISION', 'Rich replacement preview no longer matches');
    }
    const result = await applyRichSelectionReplacement(session.store, input);
    const expectation: MutationExpectation = Object.freeze({
      pageIndex: input.pageIndex,
      targetBounds: input.selection.bounds,
      authorisedBounds: input.allowedRegion,
      oldText: input.selection.text,
      newText: input.runs.map(({ text }) => text).join(''),
      expectedOldTextOutsideTarget: 0,
      structure: Object.freeze({
        commandHash: result.commandHash,
        fontResourceNames: Object.freeze([...result.fontResourceNames]),
        mutatedSourceStreams: Object.freeze([
          ...input.selection.sourceSlices.map(({ streamPath }) =>
            Object.freeze({ pageIndex: input.pageIndex, streamPath })),
          ...input.selection.sourceDecorations.map(({ graphic }) =>
            Object.freeze({ pageIndex: input.pageIndex, streamPath: graphic.address.streamPath })),
        ]),
      }),
    });
    const candidate = await this.#stageCandidate(
      session,
      result,
      expectation,
      result.fontResourceNames,
      result.replacementBounds,
    );
    return Object.freeze({
      candidateId: candidate.id,
      revision: candidate.revision,
      commandHash: candidate.commandHash,
      candidateHash: candidate.candidateHash,
      fontResourceNames: candidate.fontResourceNames,
      replacementBounds: candidate.replacementBounds!,
    });
  }

  async applyReplacement(
    documentId: string,
    revision: number,
    spanKey: string,
    replacement: string,
    acceptSubstitution: boolean,
    supplied: SessionReplacementPreconditions,
  ): Promise<SessionApplyResult> {
    const session = this.#session(documentId, revision);
    if (supplied.spanKey !== spanKey) {
      throw new SessionError('STALE_REVISION', 'Replacement span precondition does not match');
    }
    const span = this.#span(session, spanKey);
    const pageIndex = this.#pageIndexFor(session, span);
    const current = await buildMutationPreconditions(session.store, pageIndex, span);
    if (
      supplied.expectedOperatorDigest !== current.expectedOperatorDigest ||
      supplied.expectedGlyphText !== current.expectedGlyphText
    ) {
      throw new SessionError('STALE_REVISION', 'Replacement preconditions no longer match');
    }
    const classification = classifyReplacement(span, replacement, {
      existingFontCanEncode: false,
      substituteFontAvailable: true,
      substituteFontEmbeddable: true,
      replacementBounds: span.bounds,
      acceptSubstitution,
    });
    if (
      supplied.expectedNormalisedReplacement !== classification.normalisedReplacement ||
      supplied.expectedSubstitutionAccepted !== classification.substitutionAccepted
    ) {
      throw new SessionError('STALE_REVISION', 'Replacement preview no longer matches');
    }
    if (!classification.canApply) {
      const code: EngineErrorCode = classification.reasons.includes('replacementOverflow')
        ? 'REPLACEMENT_OVERFLOW'
        : classification.reasons.includes('fontEmbeddingProhibited')
          ? 'FONT_EMBEDDING_PROHIBITED'
          : 'READ_ONLY_SPAN';
      throw new SessionError(code, 'Replacement classification does not permit mutation');
    }
    const font = await this.#substituteFont();
    const result = await applyReplacement(session.store, {
      pageIndex,
      span,
      replacement,
      classification,
      shapedRun: await shapeText({
        fontBytes: font.bytes,
        text: classification.normalisedReplacement,
      }),
      fontAsset: font,
      currentRevision: session.revision,
      expectedRevision: revision,
      preconditions: current,
    });
    const nextStore = await ObjectStore.open(result.candidateBytes, this.#limits);
    const equalOldTextOutside = span.unicode === null ? 0 : [...session.spans.values()].filter((candidate) =>
      candidate.unicode === span.unicode
      && spanAddressKey(candidate.address) !== spanKey
      && !intersects(candidate.bounds, span.bounds)).length;
    const expectation: MutationExpectation = Object.freeze({
      pageIndex,
      targetBounds: span.bounds,
      authorisedBounds: span.bounds,
      oldText: span.unicode ?? current.expectedGlyphText,
      newText: classification.normalisedReplacement,
      expectedOldTextOutsideTarget: equalOldTextOutside,
      structure: Object.freeze({
        commandHash: result.commandHash,
        fontResourceNames: Object.freeze([result.fontResourceName]),
        mutatedSourceStreams: Object.freeze([Object.freeze({
          pageIndex,
          streamPath: span.address.streamPath,
        })]),
      }),
    });

    const candidate = this.#replacePendingCandidate(session, {
      id: this.#candidateId(result.revision, result.candidateHash),
      store: nextStore,
      bytes: result.candidateBytes.slice(),
      revision: result.revision,
      commandHash: result.commandHash,
      candidateHash: result.candidateHash,
      expectation,
      fontResourceNames: Object.freeze([result.fontResourceName]),
      replacementBounds: null,
    });
    return Object.freeze({
      candidateId: candidate.id,
      revision: candidate.revision,
      commandHash: candidate.commandHash,
      candidateHash: candidate.candidateHash,
      fontResourceName: result.fontResourceName,
    });
  }

  async validateCandidate(
    documentId: string,
    revision: number,
    candidateId: string,
  ): Promise<SessionValidationEvidence> {
    const session = this.#session(documentId, revision);
    const candidate = session.pendingCandidate;
    if (candidate === null || candidate.id !== candidateId) {
      throw new SessionError('STALE_REVISION', 'Candidate no longer matches the active revision');
    }
    const runtime = await this.#validator(
      session.bytes.slice(),
      candidate.bytes.slice(),
      candidate.expectation,
    );
    const cause = runtime.error?.details?.cause;
    const checks = Object.freeze([
      ...runtime.checks,
      ...(typeof cause === 'string' ? [`failure:${cause}`] : []),
    ]);
    if (!runtime.valid) {
      candidate.bytes.fill(0);
      session.pendingCandidate = null;
      return Object.freeze({
        candidateId,
        candidateHash: candidate.candidateHash,
        valid: false,
        checks,
        revision: session.revision,
      });
    }

    session.bytes.fill(0);
    session.store = candidate.store;
    session.bytes = candidate.bytes;
    session.revision = candidate.revision;
    session.candidateHash = candidate.candidateHash;
    session.expectation = candidate.expectation;
    session.pendingCandidate = null;
    session.spans.clear();
    session.spanPages.clear();
    session.lines.clear();
    session.validations.clear();
    session.exported.clear();
    const evidence = Object.freeze({
      candidateId,
      candidateHash: candidate.candidateHash,
      valid: true,
      checks,
      revision: session.revision,
    });
    session.validations.set(this.#validationKey(session), evidence);
    return evidence;
  }

  async validateExport(
    documentId: string,
    revision: number,
  ): Promise<SessionValidationEvidence> {
    const session = this.#sessionByDocument(documentId);
    const cached = session.revision === revision
      ? session.validations.get(this.#validationKey(session))
      : undefined;
    if (cached !== undefined) return cached;
    if (session.pendingCandidate?.revision !== revision) {
      throw new SessionError('VALIDATION_FAILURE', 'No candidate mutation is available to validate');
    }
    return this.validateCandidate(documentId, session.revision, session.pendingCandidate.id);
  }

  exportDocument(
    documentId: string,
    revision: number,
    validatedCandidateHash: string,
  ): ArrayBuffer {
    const session = this.#session(documentId, revision);
    const key = this.#validationKey(session);
    const evidence = session.validations.get(key);
    if (
      validatedCandidateHash !== session.candidateHash ||
      evidence === undefined ||
      !evidence.valid ||
      session.exported.has(key)
    ) {
      throw new SessionError(
        'VALIDATION_FAILURE',
        'A matching successful unconsumed validation is required before export',
      );
    }
    session.exported.add(key);
    const output = session.bytes.slice();
    return output.buffer;
  }

  closeDocument(documentId: string, revision: number): void {
    const session = this.#session(documentId, revision);
    session.bytes.fill(0);
    session.pendingCandidate?.bytes.fill(0);
    session.pendingCandidate = null;
    session.spans.clear();
    session.spanPages.clear();
    session.lines.clear();
    session.validations.clear();
    session.exported.clear();
    this.#sessions.delete(documentId);
  }

  #session(documentId: string, revision: number): Session {
    const session = this.#sessionByDocument(documentId);
    if (session.revision !== revision) {
      throw new SessionError('STALE_REVISION', 'Document revision does not match', {
        expectedRevision: session.revision,
        receivedRevision: revision,
      });
    }
    return session;
  }

  #sessionByDocument(documentId: string): Session {
    const session = this.#sessions.get(documentId);
    if (session === undefined) {
      throw new SessionError('STALE_REVISION', 'Document session does not exist');
    }
    return session;
  }

  #span(session: Session, key: string): AnalysedSpan {
    const span = session.spans.get(key);
    if (span === undefined) {
      throw new SessionError('STALE_REVISION', 'Span was not analysed at this revision');
    }
    return span;
  }

  #pageIndexFor(session: Session, target: AnalysedSpan): number {
    const pageIndex = session.spanPages.get(spanAddressKey(target.address));
    if (pageIndex !== undefined) return pageIndex;
    throw new SessionError('STALE_REVISION', 'Span page no longer resolves');
  }

  async #substituteFont(): Promise<SubstituteFontAsset> {
    if (this.#font !== null) return this.#font;
    const source = typeof this.#fontSource === 'function'
      ? await this.#fontSource()
      : this.#fontSource;
    this.#font = copyAsset(source);
    return this.#font;
  }

  async #ensureBundledFont(): Promise<FontDescriptor> {
    const font = await this.#substituteFont();
    return this.#fonts.register({
      source: 'bundled',
      fileName: `${font.family}.woff`,
      bytes: font.bytes,
    });
  }

  async #ensureBundledFonts(): Promise<void> {
    this.#bundledFontsPromise ??= (async () => {
      await this.#ensureBundledFont();
      const additional = await this.#additionalBundledFonts?.() ?? [];
      for (const font of additional) {
        await this.#fonts.register({
          source: 'bundled',
          fileName: font.fileName,
          bytes: font.bytes,
        });
      }
    })();
    await this.#bundledFontsPromise;
  }

  #line(session: Session, key: string): AnalysedTextLine {
    const line = session.lines.get(key);
    if (line === undefined) {
      throw new SessionError('STALE_REVISION', 'Text line was not analysed at this revision');
    }
    return line;
  }

  async #richMutationInput(
    session: Session,
    revision: number,
    payload: SessionRichReplacementPayload,
    supplied?: SessionRichReplacementPreconditions,
  ): Promise<RichReplacementMutationInput> {
    const line = this.#line(session, payload.selection.lineKey);
    const selection = buildTextSelection(
      line,
      payload.selection.anchorGlyphIndex,
      payload.selection.focusGlyphIndex,
    );
    const preconditions = supplied === undefined
      ? await buildSelectionMutationPreconditions(session.store, selection)
      : Object.freeze({
          slices: supplied.slices,
          decorations: supplied.decorations,
    });
    const runs: ResolvedRichTextRun[] = [];
    for (const run of payload.runs) {
      const sourceRunIndex = run.sourceRunIndex ?? null;
      let sourceRun: (typeof selection.styleRuns)[number] | null = null;
      if (sourceRunIndex !== null) {
        const resolvedSourceRun = selection.styleRuns[sourceRunIndex];
        if (resolvedSourceRun === undefined) {
          throw new SessionError(
            'STALE_REVISION',
            'Rich replacement source run no longer resolves',
          );
        }
        sourceRun = resolvedSourceRun;
      }
      const descriptor = this.#fonts.list().find(({ id }) => id === run.fontId);
      if (descriptor === undefined) {
        throw new SessionError('FONT_UNAVAILABLE', `Font ${run.fontId} is not registered`);
      }
      if (
        run.fontIntent === 'preserve-source' &&
        (
          descriptor.inspection.weight !== (run.style.fontWeight ?? 400) ||
          descriptor.inspection.italic !== ((run.style.italicAngle ?? 0) !== 0)
        )
      ) {
        throw new SessionError(
          'FONT_UNAVAILABLE',
          'Selected font does not preserve the source weight and italic style',
        );
      }
      let matchKind: FontMatchKind;
      if (run.fontIntent === 'explicit-choice') {
        const available = new Set(descriptor.inspection.codePoints);
        if (codePoints(run.text).some((codePoint) => !available.has(codePoint))) {
          throw new SessionError('FONT_UNAVAILABLE', 'Explicitly selected font lacks glyph coverage');
        }
        matchKind = 'exact';
      } else {
        const resolution = resolveFontRequirement(fontRequirement(run), [descriptor]);
        if (resolution.kind === 'unavailable') {
          throw new SessionError('FONT_UNAVAILABLE', 'Selected font lacks glyph coverage');
        }
        matchKind = resolution.kind;
      }
      const bytes = this.#fonts.getBytes(descriptor.id);
      const shapedRun = await shapeText({ fontBytes: bytes, text: run.text });
      let spacingScale = 1;
      let advanceProfile: readonly number[] | null = null;
      if (sourceRun !== null) {
        const sourceGlyph = line.glyphs[sourceRun.glyphRange.start];
        const sourceSpan = sourceGlyph === undefined
          ? null
          : sourceSpanForGlyph(session, sourceGlyph);
        if (sourceGlyph !== undefined && sourceSpan !== null) {
          try {
            const shapedSourceRun = await shapeText({
              fontBytes: bytes,
              text: sourceRun.text,
            });
            spacingScale = sourceSpacingScale({
              sourceExtent: sourceRunExtent(line, sourceRun),
              baselineScale: Math.hypot(
                sourceSpan.renderMatrix[0],
                sourceSpan.renderMatrix[1],
              ),
              shapedAdvance: shapedRunAdvance(
                sourceRun.text,
                shapedSourceRun,
                sourceRun.style,
              ),
            });
            const profile = sourceRunAdvanceProfile(
              line,
              sourceRun,
              Math.hypot(sourceSpan.renderMatrix[0], sourceSpan.renderMatrix[1]),
              shapedSourceRun.glyphs.length,
            );
            advanceProfile = run.text === sourceRun.text || run.text.startsWith(sourceRun.text)
              ? profile
              : null;
          } catch {
            spacingScale = 1;
            advanceProfile = null;
          }
        }
      }
      const fontAsset: ResolvedFontAsset = Object.freeze({ descriptor, bytes, matchKind });
      runs.push(Object.freeze({
        text: run.text,
        style: Object.freeze({ ...run.style }),
        shapedRun,
        fontAsset,
        decorations: Object.freeze({ ...run.decorations }),
        sourceRunIndex,
        sourceSpacingScale: spacingScale,
        ...(advanceProfile === null ? {} : { sourceAdvanceProfile: advanceProfile }),
      }));
    }
    return Object.freeze({
      pageIndex: line.pageIndex,
      selection,
      runs: Object.freeze(runs),
      allowedRegion: Object.freeze({ ...payload.allowedRegion }),
      substitutionConsents: Object.freeze([...payload.substitutionConsents]),
      currentRevision: session.revision,
      expectedRevision: revision,
      preconditions,
    });
  }

  async #stageCandidate(
    session: Session,
    result: RichMutationResult,
    expectation: MutationExpectation,
    fontResourceNames: readonly string[],
    replacementBounds: CanonicalBounds,
  ): Promise<SessionCandidate> {
    const store = await ObjectStore.open(result.candidateBytes, this.#limits);
    return this.#replacePendingCandidate(session, {
      id: this.#candidateId(result.revision, result.candidateHash),
      store,
      bytes: result.candidateBytes.slice(),
      revision: result.revision,
      commandHash: result.commandHash,
      candidateHash: result.candidateHash,
      expectation,
      fontResourceNames: Object.freeze([...fontResourceNames]),
      replacementBounds,
    });
  }

  #replacePendingCandidate(session: Session, candidate: SessionCandidate): SessionCandidate {
    session.pendingCandidate?.bytes.fill(0);
    session.pendingCandidate = candidate;
    return candidate;
  }

  #candidateId(revision: number, candidateHash: string): string {
    return `candidate:${revision}:${candidateHash}`;
  }

  #validationKey(session: Session): string {
    return `${session.revision}:${session.candidateHash}`;
  }
}
