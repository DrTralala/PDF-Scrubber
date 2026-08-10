import { describe, expect, test } from 'vitest';

import type { EditorRichTextRun } from '../editing/rich-text-buffer';
import { selectionFixture } from '../test/fakes';
import type { BrowserLocalFont } from './local-font-provider';
import {
  deriveLocalFontRequirement,
  matchLocalFont,
  normaliseLocalFontFamily,
  normaliseLocalPostscriptName,
  parseLocalFontStyle,
} from './local-font-matching';

function run(
  text: string,
  fontBaseName: string,
  weight: number,
  italicAngle = 0,
): EditorRichTextRun {
  return Object.freeze({
    text,
    style: Object.freeze({
      ...selectionFixture().style,
      fontBaseName,
      fontWeight: weight,
      italicAngle,
    }),
    fontId: '',
    fontIntent: 'preserve-source',
    decorations: Object.freeze({ underline: false, strikethrough: false }),
  });
}

function localFont(
  postscriptName: string,
  family: string,
  style: string,
): BrowserLocalFont {
  return Object.freeze({
    postscriptName,
    fullName: `${family} ${style}`,
    family,
    style,
  });
}

describe('local font metadata normalisation', () => {
  test.each([
    ['ABCDEF+DejaVuSans-Bold', 'dejavusansbold'],
    ['DejaVu Sans_Bold', 'dejavusansbold'],
    ['Noto-Serif', 'notoserif'],
  ])('normalises PostScript name %s', (input, expected) => {
    expect(normaliseLocalPostscriptName(input)).toBe(expected);
  });

  test.each([
    ['ABCDEF+DejaVuSans-BoldItalic', 'dejavusans'],
    ['DejaVu Sans SemiBold Oblique', 'dejavusans'],
    ['Noto_Serif-Regular', 'notoserif'],
    ['Bookman', 'bookman'],
  ])('normalises family name %s without a style suffix', (input, expected) => {
    expect(normaliseLocalFontFamily(input)).toBe(expected);
  });

  test.each([
    ['Thin', 100, false],
    ['Extra Light', 200, false],
    ['UltraLight Italic', 200, true],
    ['Light Oblique', 300, true],
    ['Regular', 400, false],
    ['Normal Italic', 400, true],
    ['Book', 400, false],
    ['Medium', 500, false],
    ['SemiBold', 600, false],
    ['Demi Bold Oblique', 600, true],
    ['Bold', 700, false],
    ['ExtraBold Italic', 800, true],
    ['Ultra Bold', 800, false],
    ['Black', 900, false],
    ['Heavy Italic', 900, true],
  ])('parses local style %s', (style, weight, italic) => {
    expect(parseLocalFontStyle(style)).toEqual({ weight, italic });
  });
});

describe('deriveLocalFontRequirement', () => {
  test('uses the complete editor selection when the caret range is collapsed', () => {
    const result = deriveLocalFontRequirement([
      run('Deja', 'ABCDEF+DejaVuSans-Bold', 700),
      run('Vu', 'DejaVuSans-Bold', 700),
    ], { start: 2, end: 2 });

    expect(result).toEqual({
      kind: 'ready',
      requirement: {
        postscriptName: 'ABCDEF+DejaVuSans-Bold',
        family: 'dejavusans',
        weight: 700,
        italic: false,
      },
    });
  });

  test('derives a requirement only from runs intersecting an explicit range', () => {
    const result = deriveLocalFontRequirement([
      run('regular', 'Example-Regular', 400),
      run('bold', 'Example-Bold', 700),
    ], { start: 7, end: 11 });

    expect(result).toEqual({
      kind: 'ready',
      requirement: {
        postscriptName: 'Example-Bold',
        family: 'example',
        weight: 700,
        italic: false,
      },
    });
  });

  test('refuses a mixed family, weight, or italic requirement', () => {
    expect(deriveLocalFontRequirement([
      run('regular', 'Example-Regular', 400),
      run('bold', 'Example-Bold', 700),
    ], { start: 0, end: 11 })).toEqual({
      kind: 'mixed',
      reason: 'mixed-font-requirement',
    });
  });
});

describe('matchLocalFont', () => {
  test('gives an exact normalised PostScript match precedence over family fallback', () => {
    const requirement = deriveLocalFontRequirement([
      run('bold', 'ABCDEF+DejaVuSans-Bold', 700),
    ], { start: 0, end: 4 });
    const familyFallback = localFont('Other-Bold', 'DejaVu Sans', 'Bold');
    const postscriptMatch = localFont('DejaVuSans_Bold', 'Other Family', 'Regular');

    expect(matchLocalFont(requirement, [familyFallback, postscriptMatch])).toEqual({
      kind: 'match',
      basis: 'postscript-name',
      font: postscriptMatch,
    });
  });

  test('falls back to exact family, weight, and italic metadata', () => {
    const requirement = deriveLocalFontRequirement([
      run('bold', 'DejaVuSans-BoldItalic', 700, -12),
    ], { start: 0, end: 4 });
    const match = localFont('DifferentPSName', 'DejaVu Sans', 'Bold Oblique');

    expect(matchLocalFont(requirement, [
      localFont('WrongStyle', 'DejaVu Sans', 'Regular'),
      match,
    ])).toEqual({
      kind: 'match',
      basis: 'family-style',
      font: match,
    });
  });

  test('does not suggest loose family or style substitutions', () => {
    const requirement = deriveLocalFontRequirement([
      run('bold', 'DejaVuSans-Bold', 700),
    ], { start: 0, end: 4 });

    expect(matchLocalFont(requirement, [
      localFont('DejaVuSans-Regular', 'DejaVu Sans', 'Regular'),
      localFont('LiberationSans-Bold', 'Liberation Sans', 'Bold'),
    ])).toEqual({ kind: 'none', reason: 'no-exact-match' });
  });

  test('does not suggest a font for a mixed requirement', () => {
    const requirement = deriveLocalFontRequirement([
      run('regular', 'Example-Regular', 400),
      run('bold', 'Example-Bold', 700),
    ], { start: 0, end: 11 });

    expect(matchLocalFont(requirement, [
      localFont('Example-Bold', 'Example', 'Bold'),
    ])).toEqual({ kind: 'none', reason: 'mixed-font-requirement' });
  });
});
