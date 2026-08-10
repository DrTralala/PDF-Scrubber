import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from 'pdf-lib';

import type { EngineLimits, EngineResourceUsage } from '../limits';
import type { PdfObjectRef, StreamPathSegment } from '../model';
import { PdfEngineError, decodeStreamBytes } from './stream-codecs';

export const OBJECT_STORE_ANALYSIS_ACCESS = Symbol('ObjectStoreAnalysisAccess');

export type ObjectStoreAnalysisAccess = Readonly<{
  document: PDFDocument;
  limits: EngineLimits;
}>;

export interface ContentStreamRecord {
  readonly path: readonly StreamPathSegment[];
  readonly encodedBytes: Uint8Array;
  readonly decodedBytes: Uint8Array;
  readonly referenceCount: number;
}

export type PageContentWrapper = Readonly<{
  prefixRef: PdfObjectRef;
  suffixRef: PdfObjectRef;
}>;

type InternalStreamRecord = Readonly<{
  pageIndex: number;
  path: readonly StreamPathSegment[];
  streamRef: PDFRef;
  encodedBytes: Uint8Array;
  decodedBytes: Uint8Array;
}>;

function objectReference(reference: PDFRef): PdfObjectRef {
  return Object.freeze({
    objectNumber: reference.objectNumber,
    generationNumber: reference.generationNumber,
  });
}

function referenceTag(reference: PDFRef): string {
  return `${reference.objectNumber}:${reference.generationNumber}`;
}

function pathKey(pageIndex: number, path: readonly StreamPathSegment[]): string {
  return `${pageIndex}|${path
    .map(
      ({ kind, ref, resourceName }) =>
        `${kind}:${ref.objectNumber}:${ref.generationNumber}:${resourceName ?? '-'}`,
    )
    .join('/')}`;
}

function copyRecord(
  record: InternalStreamRecord,
  referenceCount: number,
): ContentStreamRecord {
  return Object.freeze({
    path: record.path,
    encodedBytes: new Uint8Array(record.encodedBytes),
    decodedBytes: new Uint8Array(record.decodedBytes),
    referenceCount,
  });
}

function asRawStream(
  document: PDFDocument,
  reference: PDFRef,
): PDFRawStream {
  const object = document.context.lookup(reference);
  if (!(object instanceof PDFRawStream)) {
    throw new PdfEngineError(
      'MALFORMED_INPUT',
      'Content stream reference does not resolve to a raw stream',
      { objectNumber: reference.objectNumber },
    );
  }
  return object;
}

function requireIndirectStreamReference(value: unknown): PDFRef {
  if (!(value instanceof PDFRef)) {
    throw new PdfEngineError(
      'MALFORMED_INPUT',
      'Content and Form streams must be indirect objects',
    );
  }
  return value;
}

function pageContentReferences(document: PDFDocument, pageIndex: number): PDFRef[] {
  const contents = document.getPage(pageIndex).node.get(PDFName.of('Contents'));
  if (contents === undefined) return [];
  if (contents instanceof PDFArray) {
    return contents.asArray().map(requireIndirectStreamReference);
  }
  return [requireIndirectStreamReference(contents)];
}

function formEntries(resources: PDFDict | undefined): readonly [string, unknown][] {
  if (resources === undefined) return [];
  const xObjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (xObjects === undefined) return [];
  return xObjects.entries().map(([name, value]) => [name.decodeText(), value]);
}

function isFormStream(stream: PDFRawStream): boolean {
  return stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() === '/Form';
}

export class ObjectStore {
  readonly #document: PDFDocument;
  readonly #limits: EngineLimits;
  readonly #originalBytes: Uint8Array;
  readonly #referenceCounts: Map<string, number>;
  readonly #resourceUsage: EngineResourceUsage;
  #recordsByPage: readonly (readonly InternalStreamRecord[])[];
  #recordsByPath: Map<string, InternalStreamRecord>;

  private constructor(
    document: PDFDocument,
    limits: EngineLimits,
    originalBytes: Uint8Array,
    referenceCounts: Map<string, number>,
    recordsByPage: readonly (readonly InternalStreamRecord[])[],
    resourceUsage: EngineResourceUsage,
  ) {
    this.#document = document;
    this.#limits = limits;
    this.#originalBytes = originalBytes;
    this.#referenceCounts = referenceCounts;
    this.#resourceUsage = resourceUsage;
    this.#recordsByPage = recordsByPage;
    this.#recordsByPath = this.#indexRecords(recordsByPage);
  }

  static async open(bytes: Uint8Array, limits: EngineLimits): Promise<ObjectStore> {
    if (bytes.byteLength > limits.maxFileBytes) {
      throw new PdfEngineError('RESOURCE_LIMIT', 'PDF exceeds file byte limit', {
        resource: 'fileBytes',
        limit: limits.maxFileBytes,
        observedBytes: bytes.byteLength,
      });
    }
    const originalBytes = new Uint8Array(bytes);
    const source = new TextDecoder('latin1').decode(originalBytes);
    if (/\/Encrypt\s+\d+\s+\d+\s+R\b/.test(source)) {
      throw new PdfEngineError(
        'UNSUPPORTED_DOCUMENT',
        'Encrypted PDFs are not supported in M0',
      );
    }

    let document: PDFDocument;
    try {
      document = await PDFDocument.load(originalBytes, {
        updateMetadata: false,
        throwOnInvalidObject: true,
      });
    } catch {
      throw new PdfEngineError('MALFORMED_INPUT', 'PDF object graph cannot be parsed');
    }

    const objectCount = document.context.enumerateIndirectObjects().length;
    if (objectCount > limits.maxObjects) {
      throw new PdfEngineError('RESOURCE_LIMIT', 'PDF exceeds indirect object limit', {
        resource: 'indirectObjects',
        limit: limits.maxObjects,
        observedObjects: objectCount,
      });
    }

    const referenceCounts = ObjectStore.#countReferences(document, limits);
    const recordsByPage = await ObjectStore.#collectRecords(document, limits);
    const records = recordsByPage.flat();
    const resourceUsage = Object.freeze({
      fileBytes: originalBytes.byteLength,
      objectCount,
      maximumNestingDepth: records.reduce(
        (maximum, record) => Math.max(maximum, record.path.length - 1),
        0,
      ),
      peakDecodedStreamBytes: records.reduce(
        (maximum, record) => Math.max(maximum, record.decodedBytes.byteLength),
        0,
      ),
      totalDecodedStreamBytes: records.reduce(
        (total, record) => total + record.decodedBytes.byteLength,
        0,
      ),
    });
    return new ObjectStore(
      document,
      limits,
      originalBytes,
      referenceCounts,
      recordsByPage,
      resourceUsage,
    );
  }

  resourceUsage(): EngineResourceUsage {
    return this.#resourceUsage;
  }

  pageCount(): number {
    return this.#recordsByPage.length;
  }

  listPageStreams(pageIndex: number): readonly ContentStreamRecord[] {
    const records = this.#recordsByPage[pageIndex];
    if (records === undefined) {
      throw new RangeError(`Page index ${pageIndex} is out of range`);
    }
    return records.map((record) =>
      copyRecord(record, this.#referenceCounts.get(referenceTag(record.streamRef)) ?? 0),
    );
  }

  resolveStreamPath(
    pageIndex: number,
    path: readonly StreamPathSegment[],
  ): ContentStreamRecord {
    const record = this.#recordsByPath.get(pathKey(pageIndex, path));
    if (record === undefined) {
      throw new PdfEngineError('MALFORMED_INPUT', 'Content stream path does not resolve');
    }
    return copyRecord(
      record,
      this.#referenceCounts.get(referenceTag(record.streamRef)) ?? 0,
    );
  }

  replaceStreamBytes(
    pageIndex: number,
    path: readonly StreamPathSegment[],
    decodedBytes: Uint8Array,
  ): void {
    if (decodedBytes.byteLength > this.#limits.maxDecodedStreamBytes) {
      throw new PdfEngineError('RESOURCE_LIMIT', 'Replacement stream exceeds byte limit', {
        resource: 'decodedStreamBytes',
        limit: this.#limits.maxDecodedStreamBytes,
        observedBytes: decodedBytes.byteLength,
      });
    }
    const target = this.#recordsByPath.get(pathKey(pageIndex, path));
    if (target === undefined) {
      throw new PdfEngineError('MALFORMED_INPUT', 'Content stream path does not resolve');
    }

    const previous = asRawStream(this.#document, target.streamRef);
    const dictionary = previous.dict.clone(this.#document.context);
    dictionary.delete(PDFName.of('Length'));
    dictionary.delete(PDFName.of('Filter'));
    dictionary.delete(PDFName.of('DecodeParms'));
    const ownedBytes = new Uint8Array(decodedBytes);
    this.#document.context.assign(
      target.streamRef,
      PDFRawStream.of(dictionary, ownedBytes),
    );

    this.#recordsByPage = this.#recordsByPage.map((records) =>
      records.map((record) =>
        referenceTag(record.streamRef) === referenceTag(target.streamRef)
          ? Object.freeze({
              ...record,
              encodedBytes: ownedBytes,
              decodedBytes: ownedBytes,
            })
          : record,
      ),
    );
    this.#recordsByPath = this.#indexRecords(this.#recordsByPage);
  }

  async wrapPageContentStreams(
    pageIndex: number,
    prefixBytes: Uint8Array,
    suffixBytes: Uint8Array,
  ): Promise<PageContentWrapper> {
    this.#assertPageIndex(pageIndex);
    this.#assertGeneratedStreamBytes(prefixBytes);
    this.#assertGeneratedStreamBytes(suffixBytes);
    this.#assertCanAddObjects(2);

    const context = this.#document.context;
    const prefix = context.register(context.stream(new Uint8Array(prefixBytes)));
    const suffix = context.register(context.stream(new Uint8Array(suffixBytes)));
    const contents = PDFArray.withContext(context);
    contents.push(prefix);
    for (const reference of pageContentReferences(this.#document, pageIndex)) {
      contents.push(reference);
    }
    contents.push(suffix);
    this.#document.getPage(pageIndex).node.set(PDFName.of('Contents'), contents);
    await this.#refreshRecords();
    return Object.freeze({
      prefixRef: objectReference(prefix),
      suffixRef: objectReference(suffix),
    });
  }

  async appendPageContentStream(
    pageIndex: number,
    decodedBytes: Uint8Array,
  ): Promise<PdfObjectRef> {
    this.#assertPageIndex(pageIndex);
    this.#assertGeneratedStreamBytes(decodedBytes);
    this.#assertCanAddObjects(1);

    const context = this.#document.context;
    const reference = context.register(context.stream(new Uint8Array(decodedBytes)));
    const contents = PDFArray.withContext(context);
    for (const existing of pageContentReferences(this.#document, pageIndex)) {
      contents.push(existing);
    }
    contents.push(reference);
    this.#document.getPage(pageIndex).node.set(PDFName.of('Contents'), contents);
    await this.#refreshRecords();
    return objectReference(reference);
  }

  async serialiseCandidate(): Promise<Uint8Array> {
    void this.#originalBytes;
    return this.#document.save({
      useObjectStreams: false,
      addDefaultPage: false,
      updateFieldAppearances: false,
    });
  }

  [OBJECT_STORE_ANALYSIS_ACCESS](): ObjectStoreAnalysisAccess {
    return Object.freeze({ document: this.#document, limits: this.#limits });
  }

  #indexRecords(
    recordsByPage: readonly (readonly InternalStreamRecord[])[],
  ): Map<string, InternalStreamRecord> {
    const index = new Map<string, InternalStreamRecord>();
    recordsByPage.forEach((records, pageIndex) => {
      for (const record of records) {
        index.set(pathKey(pageIndex, record.path), record);
      }
    });
    return index;
  }

  #assertPageIndex(pageIndex: number): void {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.#document.getPageCount()) {
      throw new RangeError(`Page index ${pageIndex} is out of range`);
    }
  }

  #assertGeneratedStreamBytes(bytes: Uint8Array): void {
    if (bytes.byteLength > this.#limits.maxDecodedStreamBytes) {
      throw new PdfEngineError('RESOURCE_LIMIT', 'Generated content stream exceeds byte limit', {
        resource: 'decodedStreamBytes',
        limit: this.#limits.maxDecodedStreamBytes,
        observedBytes: bytes.byteLength,
      });
    }
  }

  #assertCanAddObjects(count: number): void {
    const objectCount = this.#document.context.enumerateIndirectObjects().length;
    if (objectCount + count > this.#limits.maxObjects) {
      throw new PdfEngineError('RESOURCE_LIMIT', 'Generated content exceeds indirect object limit', {
        resource: 'indirectObjects',
        limit: this.#limits.maxObjects,
        observedObjects: objectCount + count,
      });
    }
  }

  async #refreshRecords(): Promise<void> {
    const referenceCounts = ObjectStore.#countReferences(this.#document, this.#limits);
    this.#referenceCounts.clear();
    for (const [tag, count] of referenceCounts) this.#referenceCounts.set(tag, count);
    this.#recordsByPage = await ObjectStore.#collectRecords(this.#document, this.#limits);
    this.#recordsByPath = this.#indexRecords(this.#recordsByPage);
  }

  static #countReferences(
    document: PDFDocument,
    limits: EngineLimits,
  ): Map<string, number> {
    const counts = new Map<string, number>();
    const visitedOwners = new Set<string>();

    const count = (reference: PDFRef): void => {
      const tag = referenceTag(reference);
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    };
    const scanResources = (
      resources: PDFDict | undefined,
      owner: string,
      depth: number,
    ): void => {
      if (depth > limits.maxNestingDepth) {
        throw new PdfEngineError('RESOURCE_LIMIT', 'Form nesting exceeds depth limit', {
          resource: 'nestingDepth',
          limit: limits.maxNestingDepth,
          observedDepth: depth,
        });
      }
      if (visitedOwners.has(owner)) return;
      visitedOwners.add(owner);
      for (const [, value] of formEntries(resources)) {
        const reference = requireIndirectStreamReference(value);
        count(reference);
        const stream = asRawStream(document, reference);
        if (isFormStream(stream)) {
          scanResources(
            stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict),
            `form:${referenceTag(reference)}`,
            depth + 1,
          );
        }
      }
    };

    for (let pageIndex = 0; pageIndex < document.getPageCount(); pageIndex += 1) {
      for (const reference of pageContentReferences(document, pageIndex)) count(reference);
      const page = document.getPage(pageIndex);
      scanResources(page.node.Resources(), `page:${referenceTag(page.ref)}`, 0);
    }
    return counts;
  }

  static async #collectRecords(
    document: PDFDocument,
    limits: EngineLimits,
  ): Promise<readonly (readonly InternalStreamRecord[])[]> {
    const pages: InternalStreamRecord[][] = [];

    const visit = async (
      pageIndex: number,
      reference: PDFRef,
      path: readonly StreamPathSegment[],
      depth: number,
      ancestors: ReadonlySet<string>,
      output: InternalStreamRecord[],
    ): Promise<void> => {
      if (depth > limits.maxNestingDepth) {
        throw new PdfEngineError('RESOURCE_LIMIT', 'Form nesting exceeds depth limit', {
          resource: 'nestingDepth',
          limit: limits.maxNestingDepth,
          observedDepth: depth,
        });
      }
      const tag = referenceTag(reference);
      if (ancestors.has(tag)) {
        throw new PdfEngineError('MALFORMED_INPUT', 'Cyclic Form XObject graph');
      }
      const stream = asRawStream(document, reference);
      const decodedBytes = await decodeStreamBytes(
        stream,
        limits.maxDecodedStreamBytes,
      );
      output.push(Object.freeze({
        pageIndex,
        path: Object.freeze([...path]),
        streamRef: reference,
        encodedBytes: new Uint8Array(stream.contents),
        decodedBytes,
      }));

      if (!isFormStream(stream)) return;
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(tag);
      const resources = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
      for (const [resourceName, value] of formEntries(resources)) {
        const childReference = requireIndirectStreamReference(value);
        const childStream = asRawStream(document, childReference);
        if (!isFormStream(childStream)) continue;
        await visit(
          pageIndex,
          childReference,
          [
            ...path,
            Object.freeze({
              kind: 'formXObject' as const,
              ref: objectReference(childReference),
              resourceName,
            }),
          ],
          depth + 1,
          nextAncestors,
          output,
        );
      }
    };

    for (let pageIndex = 0; pageIndex < document.getPageCount(); pageIndex += 1) {
      const output: InternalStreamRecord[] = [];
      const resources = document.getPage(pageIndex).node.Resources();
      for (const reference of pageContentReferences(document, pageIndex)) {
        const rootPath = [Object.freeze({
          kind: 'pageContents' as const,
          ref: objectReference(reference),
          resourceName: null,
        })];
        await visit(pageIndex, reference, rootPath, 0, new Set(), output);

        for (const [resourceName, value] of formEntries(resources)) {
          const formReference = requireIndirectStreamReference(value);
          const formStream = asRawStream(document, formReference);
          if (!isFormStream(formStream)) continue;
          await visit(
            pageIndex,
            formReference,
            [
              ...rootPath,
              Object.freeze({
                kind: 'formXObject' as const,
                ref: objectReference(formReference),
                resourceName,
              }),
            ],
            1,
            new Set([referenceTag(reference)]),
            output,
          );
        }
      }
      pages.push(output);
    }
    return pages;
  }
}
