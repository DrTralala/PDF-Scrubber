import type {
  FontDescriptor,
  FontMatchKind,
  FontRequirement,
  FontResolution,
} from './font-registry';

const SOURCE_ORDER: Readonly<Record<FontDescriptor['source'], number>> = Object.freeze({
  embedded: 0,
  local: 1,
  upload: 2,
  bundled: 3,
});

function normalisedName(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/^[A-Z]{6}\+/i, '')
    .replace(/[\s_-]+/g, '')
    .toLocaleLowerCase('en-US');
}

function styleMatches(requirement: FontRequirement, font: FontDescriptor): boolean {
  return requirement.weight === font.inspection.weight
    && requirement.italic === font.inspection.italic
    && (
      requirement.subfamilyName === null
      || normalisedName(requirement.subfamilyName)
        === normalisedName(font.inspection.subfamilyName)
    );
}

function matchKind(requirement: FontRequirement, font: FontDescriptor): FontMatchKind {
  if (requirement.exactByteHash !== null && requirement.exactByteHash === font.hash) {
    return 'exact';
  }
  const postscriptMatches = requirement.postscriptName !== null
    && normalisedName(requirement.postscriptName)
      === normalisedName(font.inspection.postscriptName);
  const familyMatches = requirement.familyName !== null
    && normalisedName(requirement.familyName)
      === normalisedName(font.inspection.familyName);
  const metricsMatch = requirement.metricsFingerprint !== null
    && requirement.metricsFingerprint === font.inspection.metricsFingerprint;
  if (styleMatches(requirement, font) && (postscriptMatches || familyMatches)) {
    return metricsMatch ? 'exact' : 'compatible-version';
  }
  return 'substitute';
}

export function resolveFontRequirement(
  requirement: FontRequirement,
  fonts: readonly FontDescriptor[],
): FontResolution {
  const required = new Set(requirement.requiredCodePoints);
  const candidates = fonts.filter(({ inspection }) => {
    const available = new Set(inspection.codePoints);
    return [...required].every((codePoint) => available.has(codePoint));
  });
  if (candidates.length === 0) {
    return Object.freeze({
      kind: 'unavailable',
      font: null,
      reasons: Object.freeze([
        fonts.length === 0 ? 'no-fonts-registered' : 'missing-glyph-coverage',
      ]),
    });
  }

  const rank: Readonly<Record<FontMatchKind, number>> = Object.freeze({
    exact: 0,
    'compatible-version': 1,
    substitute: 2,
  });
  const matched = candidates
    .map((font) => Object.freeze({ font, kind: matchKind(requirement, font) }))
    .sort((left, right) =>
      rank[left.kind] - rank[right.kind]
      || Number(!styleMatches(requirement, left.font))
        - Number(!styleMatches(requirement, right.font))
      || SOURCE_ORDER[left.font.source] - SOURCE_ORDER[right.font.source]
      || left.font.id.localeCompare(right.font.id))[0]!;

  return Object.freeze({
    kind: matched.kind,
    font: matched.font,
    reasons: Object.freeze([
      matched.kind === 'exact'
        ? 'exact-font-evidence'
        : matched.kind === 'compatible-version'
          ? 'matching-family-and-style'
          : 'font-substitution-required',
    ]),
  });
}
