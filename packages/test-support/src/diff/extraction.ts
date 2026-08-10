import type { CanonicalBounds } from '@pdf-editor/pdf-engine';

export type ExtractedTextItem = Readonly<{
  text: string;
  pageIndex: number;
  bounds: CanonicalBounds;
}>;

export type ExtractionExpectation = Readonly<{
  pageIndex: number;
  targetBounds: CanonicalBounds;
  oldText: string;
  newText: string;
  expectedOldTextOutsideTarget: number;
}>;

export type ExtractionEvidence = Readonly<{
  oldTextAbsentAtTarget: boolean;
  newTextPresentAtTarget: boolean;
  oldTextOutsideTargetCount: number;
  outsideTextPreserved: boolean;
  targetText: string;
  valid: boolean;
}>;

function intersects(left: CanonicalBounds, right: CanonicalBounds): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function searchable(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, '');
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) !== -1) {
    count += 1;
    position += needle.length;
  }
  return count;
}

export function evaluateExtraction(
  items: readonly ExtractedTextItem[],
  expectation: ExtractionExpectation,
): ExtractionEvidence {
  const onPage = items.filter(({ pageIndex }) => pageIndex === expectation.pageIndex);
  const targetText = searchable(onPage
    .filter(({ bounds }) => intersects(bounds, expectation.targetBounds))
    .map(({ text }) => text)
    .join(''));
  const outsideText = searchable(onPage
    .filter(({ bounds }) => !intersects(bounds, expectation.targetBounds))
    .map(({ text }) => text)
    .join(' '));
  const oldText = searchable(expectation.oldText);
  const newText = searchable(expectation.newText);
  const oldTextOutsideTargetCount = occurrences(outsideText, oldText);
  const oldTextAbsentAtTarget = oldText.length === 0 || !targetText.includes(oldText);
  const newTextPresentAtTarget = newText.length === 0 || targetText.includes(newText);
  const outsideTextPreserved = oldTextOutsideTargetCount
    === expectation.expectedOldTextOutsideTarget;

  return Object.freeze({
    oldTextAbsentAtTarget,
    newTextPresentAtTarget,
    oldTextOutsideTargetCount,
    outsideTextPreserved,
    targetText,
    valid: oldTextAbsentAtTarget && newTextPresentAtTarget && outsideTextPreserved,
  });
}
