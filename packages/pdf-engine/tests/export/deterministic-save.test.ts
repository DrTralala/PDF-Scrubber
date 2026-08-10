import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { analysePage } from '../../src/analysis/analyse-page';
import { classifyReplacement } from '../../src/classification/classify';
import { fingerprint } from '../../src/fingerprint';
import type { SubstituteFontAsset } from '../../src/fonts/font-embedding';
import { shapeText } from '../../src/fonts/harfbuzz-shaper';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import { buildMutationPreconditions } from '../../src/mutation/excise';
import { applyReplacement } from '../../src/mutation/replace-span';
import { ObjectStore } from '../../src/pdf/object-store';

const FONT_PATH = resolve(
  'node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff',
);

async function run(): Promise<Readonly<{ bytes: Uint8Array; hash: string }>> {
  const store = await ObjectStore.open(
    await readFile('fixtures/generated/01-simple-tj.pdf'),
    PROVISIONAL_LIMITS,
  );
  const span = (await analysePage(store, 0)).spans.find(({ unicode }) => unicode === 'Target 01')!;
  const fontBytes = new Uint8Array(await readFile(FONT_PATH));
  const fontAsset: SubstituteFontAsset = {
    bytes: fontBytes,
    family: 'Noto Sans',
    version: '5.3.0',
    licence: 'OFL-1.1',
    source: '@fontsource/noto-sans',
  };
  const result = await applyReplacement(store, {
    pageIndex: 0,
    span,
    replacement: 'Goodbye',
    classification: classifyReplacement(span, 'Goodbye', {
      existingFontCanEncode: false,
      substituteFontAvailable: true,
      substituteFontEmbeddable: true,
      replacementBounds: span.bounds,
      acceptSubstitution: true,
    }),
    shapedRun: await shapeText({ fontBytes, text: 'Goodbye' }),
    fontAsset,
    currentRevision: 0,
    expectedRevision: 0,
    preconditions: await buildMutationPreconditions(store, 0, span),
  });
  return { bytes: result.candidateBytes, hash: await fingerprint(result.candidateBytes) };
}

describe('deterministic replacement export', () => {
  test('produces byte-identical bytes and SHA-256 hashes from two clean runs', async () => {
    const first = await run();
    const second = await run();

    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.hash).toBe(first.hash);
    expect(second.bytes).toEqual(first.bytes);
  });
});
