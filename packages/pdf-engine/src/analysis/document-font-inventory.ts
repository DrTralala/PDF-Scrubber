import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  type PDFDocument,
} from 'pdf-lib';

import { OBJECT_STORE_ANALYSIS_ACCESS, type ObjectStore } from '../pdf/object-store';
import { PdfEngineError } from '../pdf/stream-codecs';
import { isStandard14Font } from './resources';

export type DocumentEditingFontReason =
  | 'not-embedded'
  | 'embedded-not-reusable'
  | 'standard-font';

export type DocumentEditingFont = Readonly<{
  name: string;
  reason: DocumentEditingFontReason;
}>;

const REASON_PRIORITY: Readonly<Record<DocumentEditingFontReason, number>> = Object.freeze({
  'not-embedded': 0,
  'embedded-not-reusable': 1,
  'standard-font': 2,
});

const MAX_FONT_PRESENTATION_CODE_POINTS = 96;

export type DocumentFontInventoryVisit =
  | 'page'
  | 'resourceDictionary'
  | 'fontObject'
  | 'formObject';

type InventoryOptions = Readonly<{
  now(): number;
  onVisit?(visit: DocumentFontInventoryVisit): void;
}>;

type FontEvidence = Readonly<{
  subtype: string;
  embedded: boolean;
  standard14: boolean;
  candidates: readonly (string | null)[];
  fallback: string;
}>;

function defaultNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function sanitiseCandidate(value: string | null): string | null {
  if (value === null) return null;
  const sanitised = value
    .normalize('NFKC')
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/[\u0000-\u001F\u007F-\u009F\p{Cf}]/gu, '')
    .trim();
  if (sanitised.length === 0) return null;
  return [...sanitised].slice(0, MAX_FONT_PRESENTATION_CODE_POINTS).join('');
}

function equivalentName(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase('en-US');
}

function textValue(dictionary: PDFDict, key: string): string | null {
  const value = dictionary.lookup(PDFName.of(key));
  if (!(value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString)) {
    return null;
  }
  try {
    return value.decodeText();
  } catch {
    return null;
  }
}

function dictionaryValue(document: PDFDocument, value: unknown, kind: string): PDFDict {
  const resolved = value instanceof PDFRef ? document.context.lookup(value) : value;
  if (resolved instanceof PDFRawStream) return resolved.dict;
  if (resolved instanceof PDFDict) return resolved;
  throw new PdfEngineError('MALFORMED_INPUT', `${kind} is not a dictionary`);
}

function descriptorForFont(dictionary: PDFDict, subtype: string): PDFDict | undefined {
  if (subtype !== 'Type0') {
    return dictionary.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  }
  const descendants = dictionary.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
  const descendant = descendants?.lookupMaybe(0, PDFDict);
  if (descendant === undefined) {
    throw new PdfEngineError('MALFORMED_INPUT', 'Type0 font lacks a descendant font');
  }
  return descendant.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
}

function embeddedFont(descriptor: PDFDict | undefined): boolean {
  return descriptor !== undefined && ['FontFile', 'FontFile2', 'FontFile3'].some(
    (key) => descriptor.get(PDFName.of(key)) !== undefined,
  );
}

class InventoryBudget {
  readonly #startedAt: number;
  #operations = 0;

  constructor(
    readonly maxOperations: number,
    readonly maxProcessingMs: number,
    readonly options: InventoryOptions,
  ) {
    this.#startedAt = options.now();
  }

  step(visit?: DocumentFontInventoryVisit): void {
    this.#operations += 1;
    if (this.#operations > this.maxOperations) {
      throw new PdfEngineError('RESOURCE_LIMIT', 'Font inventory exceeds operation limit', {
        resource: 'operations',
        limit: this.maxOperations,
        observedOperations: this.#operations,
      });
    }
    const elapsedMs = this.options.now() - this.#startedAt;
    if (elapsedMs > this.maxProcessingMs) {
      throw new PdfEngineError('RESOURCE_LIMIT', 'Font inventory exceeds processing deadline', {
        resource: 'processingTime',
        limit: this.maxProcessingMs,
        observedMs: elapsedMs,
      });
    }
    if (visit !== undefined) this.options.onVisit?.(visit);
  }
}

class FontInventoryTraversal {
  readonly #visitedResources = new WeakSet<PDFDict>();
  readonly #visitedFormReferences = new Set<string>();
  readonly #visitedDirectForms = new WeakSet<PDFDict>();
  readonly #fontsByReference = new Map<string, FontEvidence>();
  readonly #fontsByDictionary = new WeakMap<PDFDict, FontEvidence>();
  readonly #directFontIdentifiers = new WeakMap<PDFDict, number>();
  readonly #names = new Map<string, DocumentEditingFont>();
  #nextDirectFontIdentifier = 1;

  constructor(
    readonly document: PDFDocument,
    readonly budget: InventoryBudget,
  ) {}

  collect(): readonly DocumentEditingFont[] {
    for (let pageIndex = 0; pageIndex < this.document.getPageCount(); pageIndex += 1) {
      this.budget.step('page');
      this.#visitResources(this.document.getPage(pageIndex).node.Resources());
    }
    return Object.freeze([...this.#names.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, font]) => font));
  }

  #visitResources(resources: PDFDict | undefined): void {
    if (resources === undefined || this.#visitedResources.has(resources)) return;
    this.#visitedResources.add(resources);
    this.budget.step('resourceDictionary');

    const fonts = resources.lookupMaybe(PDFName.of('Font'), PDFDict);
    if (fonts !== undefined) {
      for (const [, value] of fonts.entries()) {
        this.budget.step();
        this.#recordFont(this.#fontEvidence(value));
      }
    }

    const xObjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (xObjects === undefined) return;
    for (const [, value] of xObjects.entries()) {
      this.budget.step();
      const dictionary = dictionaryValue(this.document, value, 'XObject resource');
      if (textValue(dictionary, 'Subtype') !== 'Form' || !this.#markForm(value, dictionary)) {
        continue;
      }
      this.budget.step('formObject');
      this.#visitResources(dictionary.lookupMaybe(PDFName.of('Resources'), PDFDict));
    }
  }

  #markForm(value: unknown, dictionary: PDFDict): boolean {
    if (value instanceof PDFRef) {
      const key = `${value.objectNumber}:${value.generationNumber}`;
      if (this.#visitedFormReferences.has(key)) return false;
      this.#visitedFormReferences.add(key);
      return true;
    }
    if (this.#visitedDirectForms.has(dictionary)) return false;
    this.#visitedDirectForms.add(dictionary);
    return true;
  }

  #fontEvidence(value: unknown): FontEvidence {
    const referenceKey = value instanceof PDFRef
      ? `${value.objectNumber}:${value.generationNumber}`
      : null;
    if (referenceKey !== null) {
      const cached = this.#fontsByReference.get(referenceKey);
      if (cached !== undefined) return cached;
    }

    const dictionary = dictionaryValue(this.document, value, 'Font resource');
    const directCached = this.#fontsByDictionary.get(dictionary);
    if (directCached !== undefined) {
      if (referenceKey !== null) this.#fontsByReference.set(referenceKey, directCached);
      return directCached;
    }

    this.budget.step('fontObject');
    const subtype = textValue(dictionary, 'Subtype') ?? 'Unknown';
    const descriptor = descriptorForFont(dictionary, subtype);
    const baseFont = textValue(dictionary, 'BaseFont');
    const identifier = value instanceof PDFRef
      ? `${value.objectNumber} ${value.generationNumber} R`
      : String(this.#directFontIdentifier(dictionary));
    const evidence = Object.freeze({
      subtype,
      embedded: embeddedFont(descriptor),
      standard14: subtype !== 'Type0' && baseFont !== null && isStandard14Font(baseFont),
      candidates: Object.freeze([
        descriptor === undefined ? null : textValue(descriptor, 'FontName'),
        baseFont,
        descriptor === undefined ? null : textValue(descriptor, 'FontFamily'),
      ]),
      fallback: `Unnamed font ${identifier}`,
    });
    this.#fontsByDictionary.set(dictionary, evidence);
    if (referenceKey !== null) this.#fontsByReference.set(referenceKey, evidence);
    return evidence;
  }

  #directFontIdentifier(dictionary: PDFDict): number {
    const existing = this.#directFontIdentifiers.get(dictionary);
    if (existing !== undefined) return existing;
    const identifier = this.#nextDirectFontIdentifier;
    this.#nextDirectFontIdentifier += 1;
    this.#directFontIdentifiers.set(dictionary, identifier);
    return identifier;
  }

  #recordFont(font: FontEvidence): void {
    const name = font.candidates
      .map(sanitiseCandidate)
      .find((candidate): candidate is string => candidate !== null)
      ?? sanitiseCandidate(font.fallback)!;
    const key = equivalentName(name);
    const reason: DocumentEditingFontReason = font.standard14
      ? 'standard-font'
      : font.embedded
        ? 'embedded-not-reusable'
        : 'not-embedded';
    const existing = this.#names.get(key);
    if (existing === undefined || REASON_PRIORITY[reason] < REASON_PRIORITY[existing.reason]) {
      this.#names.set(key, Object.freeze({
        name: existing?.name ?? name,
        reason,
      }));
    }
  }
}

async function inspect(
  store: ObjectStore,
  options: InventoryOptions,
): Promise<readonly DocumentEditingFont[]> {
  const { document, limits } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const budget = new InventoryBudget(
    limits.maxOperationsPerStream,
    limits.maxProcessingMs,
    options,
  );
  return new FontInventoryTraversal(document, budget).collect();
}

export function inspectDocumentFonts(
  store: ObjectStore,
): Promise<readonly DocumentEditingFont[]> {
  return inspect(store, { now: defaultNow });
}

export function inspectDocumentFontsForTesting(
  store: ObjectStore,
  options: Readonly<{
    now?: () => number;
    onVisit?(visit: DocumentFontInventoryVisit): void;
  }>,
): Promise<readonly DocumentEditingFont[]> {
  const now = options.now ?? defaultNow;
  return options.onVisit === undefined
    ? inspect(store, { now })
    : inspect(store, { now, onVisit: options.onVisit });
}
