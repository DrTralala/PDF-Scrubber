import type { HalfOpenRange } from '@pdf-editor/pdf-engine';

import type { EditorRichTextRun } from '../editing/rich-text-buffer';
import type { BrowserLocalFont } from './local-font-provider';

export type LocalFontStyle = Readonly<{
  weight: number;
  italic: boolean;
}>;

export type LocalFontRequirement = Readonly<{
  postscriptName: string;
  family: string;
  weight: number;
  italic: boolean;
}>;

export type LocalFontRequirementResult =
  | Readonly<{ kind: 'ready'; requirement: LocalFontRequirement }>
  | Readonly<{ kind: 'mixed'; reason: 'mixed-font-requirement' }>
  | Readonly<{ kind: 'empty'; reason: 'empty-selection' }>;

export type LocalFontMatch =
  | Readonly<{
      kind: 'match';
      basis: 'postscript-name' | 'family-style';
      font: BrowserLocalFont;
    }>
  | Readonly<{
      kind: 'none';
      reason: 'mixed-font-requirement' | 'empty-selection' | 'no-exact-match';
    }>;

const STYLE_SUFFIXES = Object.freeze([
  'extrabolditalic',
  'extraboldoblique',
  'ultrabolditalic',
  'ultraboldoblique',
  'semibolditalic',
  'semiboldoblique',
  'demibolditalic',
  'demiboldoblique',
  'extralightitalic',
  'extralightoblique',
  'ultralightitalic',
  'ultralightoblique',
  'bolditalic',
  'boldoblique',
  'blackitalic',
  'blackoblique',
  'heavyitalic',
  'heavyoblique',
  'mediumitalic',
  'mediumoblique',
  'regularitalic',
  'regularoblique',
  'normalitalic',
  'normaloblique',
  'lightitalic',
  'lightoblique',
  'bookitalic',
  'bookoblique',
  'thinitalic',
  'thinoblique',
  'extrabold',
  'ultrabold',
  'semibold',
  'demibold',
  'extralight',
  'ultralight',
  'regular',
  'normal',
  'medium',
  'italic',
  'oblique',
  'black',
  'heavy',
  'light',
  'bold',
  'book',
  'thin',
]);

function withoutSubsetPrefix(value: string): string {
  return value.replace(/^[A-Z]{6}\+/i, '');
}

export function normaliseLocalPostscriptName(value: string): string {
  return withoutSubsetPrefix(value)
    .replace(/[\s_-]+/g, '')
    .toLocaleLowerCase('en-US');
}

export function normaliseLocalFontFamily(value: string): string {
  const compact = normaliseLocalPostscriptName(value);
  const suffix = STYLE_SUFFIXES.find((candidate) =>
    compact.length > candidate.length && compact.endsWith(candidate));
  return suffix === undefined ? compact : compact.slice(0, -suffix.length);
}

export function parseLocalFontStyle(style: string): LocalFontStyle {
  const compact = style.replace(/[\s_-]+/g, '').toLocaleLowerCase('en-US');
  const weight = /black|heavy/.test(compact)
    ? 900
    : /extrabold|ultrabold/.test(compact)
      ? 800
      : /semibold|demibold/.test(compact)
        ? 600
        : /bold/.test(compact)
          ? 700
          : /medium/.test(compact)
            ? 500
            : /extralight|ultralight/.test(compact)
              ? 200
              : /light/.test(compact)
                ? 300
                : /thin/.test(compact)
                  ? 100
                  : 400;
  return Object.freeze({
    weight,
    italic: /italic|oblique/.test(compact),
  });
}

function effectiveRange(
  runs: readonly EditorRichTextRun[],
  selection: HalfOpenRange,
): HalfOpenRange {
  const length = runs.reduce((total, run) => total + run.text.length, 0);
  if (selection.start === selection.end) return Object.freeze({ start: 0, end: length });
  const start = Math.max(0, Math.min(length, Math.trunc(selection.start)));
  const end = Math.max(start, Math.min(length, Math.trunc(selection.end)));
  return Object.freeze({ start, end });
}

export function deriveLocalFontRequirement(
  runs: readonly EditorRichTextRun[],
  selection: HalfOpenRange,
): LocalFontRequirementResult {
  const range = effectiveRange(runs, selection);
  const requirements: LocalFontRequirement[] = [];
  let offset = 0;
  for (const run of runs) {
    const runStart = offset;
    const runEnd = runStart + run.text.length;
    offset = runEnd;
    if (runStart >= range.end || runEnd <= range.start) continue;
    requirements.push(Object.freeze({
      postscriptName: run.style.fontBaseName,
      family: normaliseLocalFontFamily(run.style.fontBaseName),
      weight: run.style.fontWeight ?? 400,
      italic: (run.style.italicAngle ?? 0) !== 0,
    }));
  }
  const first = requirements[0];
  if (first === undefined) {
    return Object.freeze({ kind: 'empty', reason: 'empty-selection' });
  }
  const firstPostscriptName = normaliseLocalPostscriptName(first.postscriptName);
  if (requirements.some((requirement) =>
    normaliseLocalPostscriptName(requirement.postscriptName) !== firstPostscriptName
    || requirement.family !== first.family
    || requirement.weight !== first.weight
    || requirement.italic !== first.italic)) {
    return Object.freeze({ kind: 'mixed', reason: 'mixed-font-requirement' });
  }
  return Object.freeze({ kind: 'ready', requirement: first });
}

export function matchLocalFont(
  result: LocalFontRequirementResult,
  fonts: readonly BrowserLocalFont[],
): LocalFontMatch {
  if (result.kind !== 'ready') {
    return Object.freeze({ kind: 'none', reason: result.reason });
  }
  const requirement = result.requirement;
  const postscriptName = normaliseLocalPostscriptName(requirement.postscriptName);
  const postscriptMatch = fonts.find((font) =>
    normaliseLocalPostscriptName(font.postscriptName) === postscriptName);
  if (postscriptMatch !== undefined) {
    return Object.freeze({
      kind: 'match',
      basis: 'postscript-name',
      font: postscriptMatch,
    });
  }
  const familyMatch = fonts.find((font) => {
    const style = parseLocalFontStyle(font.style);
    return normaliseLocalFontFamily(font.family) === requirement.family
      && style.weight === requirement.weight
      && style.italic === requirement.italic;
  });
  return familyMatch === undefined
    ? Object.freeze({ kind: 'none', reason: 'no-exact-match' })
    : Object.freeze({ kind: 'match', basis: 'family-style', font: familyMatch });
}
