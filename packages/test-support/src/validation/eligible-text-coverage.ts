import {
  glyphSourceAddressKey,
  type AnalysedPage,
  type AnalysedTextLayout,
  type CapabilityKind,
} from '@pdf-editor/pdf-engine';

import type { EligibleTextExpectation } from '../corpus/types';

export type EligibleGroupCoverageEvidence = Readonly<{
  expectedText: string;
  actualText: string | null;
  expectedStyleRunCount: number;
  actualStyleRunCount: number;
  replacementRuns: readonly string[];
  capability: CapabilityKind | null;
  valid: boolean;
}>;

export type EligibleTextCoverageEvidence = Readonly<{
  valid: boolean;
  expectedSourceGlyphCount: number;
  actualSourceGlyphCount: number;
  coveredSourceGlyphCount: number;
  duplicateSourceGlyphKeys: readonly string[];
  missingSourceGlyphKeys: readonly string[];
  unexpectedSourceGlyphKeys: readonly string[];
  groups: readonly EligibleGroupCoverageEvidence[];
}>;

type AnalysedPageWithLayout = AnalysedPage & Readonly<{
  textLayout: AnalysedTextLayout;
}>;

function sorted(values: Iterable<string>): readonly string[] {
  return Object.freeze([...values].sort());
}

export function evaluateEligibleTextCoverage(
  page: AnalysedPageWithLayout,
  expectation: EligibleTextExpectation,
): EligibleTextCoverageEvidence {
  const sourceKeys = page.spans
    .filter(({ style }) => style.renderingMode !== 3 && style.renderingMode !== 7)
    .flatMap(({ glyphs }) => glyphs.map(({ source }) => glyphSourceAddressKey(source)));
  const sourceKeySet = new Set(sourceKeys);
  const coveredKeys: string[] = [];
  for (const line of page.textLayout.lines) {
    for (const group of line.groups) {
      coveredKeys.push(...line.glyphs
        .slice(group.glyphRange.start, group.glyphRange.end)
        .map(({ source }) => glyphSourceAddressKey(source)));
    }
  }
  const coveredKeySet = new Set(coveredKeys);
  const duplicateSourceGlyphKeys = sorted(new Set(coveredKeys.filter(
    (key, index) => coveredKeys.indexOf(key) !== index,
  )));
  const missingSourceGlyphKeys = sorted([...sourceKeySet].filter((key) => !coveredKeySet.has(key)));
  const unexpectedSourceGlyphKeys = sorted(
    [...coveredKeySet].filter((key) => !sourceKeySet.has(key)),
  );
  const groups = Object.freeze(expectation.groups.map((expected, index) => {
    const actual = page.textLayout.groups[index];
    const replacementRuns = Object.freeze([...expected.replacementRuns]);
    const valid = actual !== undefined
      && actual.text === expected.text
      && actual.styleRuns.length === expected.styleRunCount
      && replacementRuns.length === expected.styleRunCount
      && replacementRuns.every((text) => text.length > 0)
      && actual.capability.kind !== 'readOnly';
    return Object.freeze({
      expectedText: expected.text,
      actualText: actual?.text ?? null,
      expectedStyleRunCount: expected.styleRunCount,
      actualStyleRunCount: actual?.styleRuns.length ?? 0,
      replacementRuns,
      capability: actual?.capability.kind ?? null,
      valid,
    });
  }));
  const valid = sourceKeys.length === expectation.sourceGlyphCount
    && page.textLayout.eligibleSourceGlyphCount === expectation.sourceGlyphCount
    && coveredKeySet.size === expectation.sourceGlyphCount
    && duplicateSourceGlyphKeys.length === 0
    && missingSourceGlyphKeys.length === 0
    && unexpectedSourceGlyphKeys.length === 0
    && page.textLayout.groups.length === expectation.groups.length
    && groups.every((group) => group.valid);

  return Object.freeze({
    valid,
    expectedSourceGlyphCount: expectation.sourceGlyphCount,
    actualSourceGlyphCount: sourceKeys.length,
    coveredSourceGlyphCount: coveredKeySet.size,
    duplicateSourceGlyphKeys,
    missingSourceGlyphKeys,
    unexpectedSourceGlyphKeys,
    groups,
  });
}
