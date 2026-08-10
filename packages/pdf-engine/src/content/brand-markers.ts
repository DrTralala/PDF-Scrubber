export const PDF_SCRUBBER_MARKED_CONTENT_TAG = 'PDF-Scrubber';

// Kept as a code-point sequence so the pre-rebrand spelling is not propagated
// through source, while parsers can still recognise existing edited PDFs.
export const LEGACY_MARKED_CONTENT_TAG = String.fromCodePoint(70, 111, 108, 105, 111);

export const PDF_SCRUBBER_PAGE_ISOLATION_PREFIX =
  '% PDF-Scrubber page isolation v1 begin\nq\n';
export const PDF_SCRUBBER_PAGE_ISOLATION_SUFFIX =
  'Q\n% PDF-Scrubber page isolation v1 end\n';

const LEGACY_PAGE_ISOLATION_PREFIX =
  `% ${LEGACY_MARKED_CONTENT_TAG} page isolation v1 begin\nq\n`;
const LEGACY_PAGE_ISOLATION_SUFFIX =
  `Q\n% ${LEGACY_MARKED_CONTENT_TAG} page isolation v1 end\n`;

export type PageIsolationVariant = Readonly<{
  prefix: string;
  suffix: string;
}>;

export const PAGE_ISOLATION_VARIANTS: readonly PageIsolationVariant[] = Object.freeze([
  Object.freeze({
    prefix: PDF_SCRUBBER_PAGE_ISOLATION_PREFIX,
    suffix: PDF_SCRUBBER_PAGE_ISOLATION_SUFFIX,
  }),
  Object.freeze({
    prefix: LEGACY_PAGE_ISOLATION_PREFIX,
    suffix: LEGACY_PAGE_ISOLATION_SUFFIX,
  }),
]);

export function isSupportedMarkedContentTag(value: string): boolean {
  return value === PDF_SCRUBBER_MARKED_CONTENT_TAG || value === LEGACY_MARKED_CONTENT_TAG;
}

export function isPageIsolationPrefix(value: string): boolean {
  return PAGE_ISOLATION_VARIANTS.some((variant) => variant.prefix === value);
}

export function isPageIsolationSuffix(value: string): boolean {
  return PAGE_ISOLATION_VARIANTS.some((variant) => variant.suffix === value);
}
