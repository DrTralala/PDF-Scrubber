import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  analysePage,
  applyReplacement,
  buildMutationPreconditions,
  classifyReplacement,
  ObjectStore,
  PROVISIONAL_LIMITS,
  shapeText,
  type CanonicalBounds,
  type SubstituteFontAsset,
} from '@pdf-editor/pdf-engine';

const LATIN_FONT_PATH = resolve(
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff',
);
const ARABIC_FONT_PATH = resolve(
  'node_modules/@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff',
);

export type ReplacementFixture = Readonly<{
  originalBytes: Uint8Array;
  candidateBytes: Uint8Array;
  targetBounds: CanonicalBounds;
  oldText: 'Target 01';
  newText: string;
}>;

export async function createReplacementFixture(newText: string): Promise<ReplacementFixture> {
  const originalBytes = new Uint8Array(await readFile('fixtures/generated/01-simple-tj.pdf'));
  const store = await ObjectStore.open(originalBytes, PROVISIONAL_LIMITS);
  const span = (await analysePage(store, 0)).spans.find(({ unicode }) => unicode === 'Target 01');
  if (span === undefined) throw new Error('Fixture 01 does not contain its authoritative target');
  const arabic = /\p{Script=Arabic}/u.test(newText);
  const fontPath = arabic ? ARABIC_FONT_PATH : LATIN_FONT_PATH;
  const fontBytes = new Uint8Array(await readFile(fontPath));
  const fontAsset: SubstituteFontAsset = Object.freeze({
    bytes: fontBytes,
    family: arabic ? 'Noto Sans Arabic' : 'Noto Sans',
    version: '5.3.0',
    licence: 'OFL-1.1',
    source: arabic ? '@fontsource/noto-sans-arabic' : '@fontsource/noto-sans',
  });
  const classification = classifyReplacement(span, newText, {
    existingFontCanEncode: false,
    substituteFontAvailable: true,
    substituteFontEmbeddable: true,
    replacementBounds: span.bounds,
    acceptSubstitution: true,
  });
  const result = await applyReplacement(store, {
    pageIndex: 0,
    span,
    replacement: newText,
    classification,
    shapedRun: await shapeText({
      fontBytes,
      text: classification.normalisedReplacement,
      ...(arabic ? { script: 'Arab', language: 'ar' } : {}),
    }),
    fontAsset,
    currentRevision: 0,
    expectedRevision: 0,
    preconditions: await buildMutationPreconditions(store, 0, span),
  });
  return Object.freeze({
    originalBytes,
    candidateBytes: result.candidateBytes,
    targetBounds: span.bounds,
    oldText: 'Target 01',
    newText,
  });
}
