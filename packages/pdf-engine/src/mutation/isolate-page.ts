import { analysePage } from '../analysis/analyse-page';
import {
  PAGE_ISOLATION_VARIANTS,
  PDF_SCRUBBER_PAGE_ISOLATION_PREFIX,
  PDF_SCRUBBER_PAGE_ISOLATION_SUFFIX,
  isPageIsolationPrefix,
  isPageIsolationSuffix,
} from '../content/brand-markers';
import type { PdfObjectRef } from '../model';
import type { ObjectStore } from '../pdf/object-store';
import { MutationError } from './excise';

export {
  PDF_SCRUBBER_PAGE_ISOLATION_PREFIX,
  PDF_SCRUBBER_PAGE_ISOLATION_SUFFIX,
} from '../content/brand-markers';

export type PageIsolationResult = Readonly<{
  changed: boolean;
  prefixRef: PdfObjectRef;
  suffixRef: PdfObjectRef;
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sameBytes(bytes: Uint8Array, expected: string): boolean {
  return decoder.decode(bytes) === expected;
}

export async function isolatePageContents(
  store: ObjectStore,
  pageIndex: number,
): Promise<PageIsolationResult> {
  const roots = store.listPageStreams(pageIndex).filter(({ path }) => path.length === 1);
  const matchingVariant = PAGE_ISOLATION_VARIANTS.find((variant) => {
    const prefixIndexes = roots.flatMap((stream, index) =>
      sameBytes(stream.decodedBytes, variant.prefix) ? [index] : []);
    const suffixIndexes = roots.flatMap((stream, index) =>
      sameBytes(stream.decodedBytes, variant.suffix) ? [index] : []);
    return prefixIndexes.length === 1 && prefixIndexes[0] === 0 &&
      suffixIndexes.length === 1 && suffixIndexes[0]! > 0;
  });

  if (matchingVariant !== undefined) {
    const prefixIndex = roots.findIndex((stream) =>
      sameBytes(stream.decodedBytes, matchingVariant.prefix));
    const suffixIndex = roots.findIndex((stream) =>
      sameBytes(stream.decodedBytes, matchingVariant.suffix));
    return Object.freeze({
      changed: false,
      prefixRef: roots[0]!.path[0]!.ref,
      suffixRef: roots[suffixIndex]!.path[0]!.ref,
    });
  }
  if (roots.some((stream) => {
    const decoded = decoder.decode(stream.decodedBytes);
    return isPageIsolationPrefix(decoded) || isPageIsolationSuffix(decoded);
  })) {
    throw new MutationError(
      'MALFORMED_INPUT',
      'Page contains an incomplete or ambiguous PDF-Scrubber isolation wrapper',
    );
  }

  const analysed = await analysePage(store, pageIndex);
  if (!analysed.graphicsState.balanced) {
    throw new MutationError('READ_ONLY_SPAN', 'Page graphics-state stack is not balanced');
  }
  const wrapper = await store.wrapPageContentStreams(
    pageIndex,
    encoder.encode(PDF_SCRUBBER_PAGE_ISOLATION_PREFIX),
    encoder.encode(PDF_SCRUBBER_PAGE_ISOLATION_SUFFIX),
  );
  return Object.freeze({ changed: true, ...wrapper });
}
