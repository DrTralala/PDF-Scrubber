import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import { analysePage } from '../../src/analysis/analyse-page';
import { PAGE_ISOLATION_VARIANTS } from '../../src/content/brand-markers';
import {
  PDF_SCRUBBER_PAGE_ISOLATION_PREFIX,
  PDF_SCRUBBER_PAGE_ISOLATION_SUFFIX,
  isolatePageContents,
} from '../../src/mutation/isolate-page';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import { ObjectStore } from '../../src/pdf/object-store';

const decoder = new TextDecoder();

async function richLineStore(): Promise<ObjectStore> {
  return ObjectStore.open(
    await readFile('fixtures/generated/30-wkhtmltopdf-rich-line.pdf'),
    PROVISIONAL_LIMITS,
  );
}

describe('isolatePageContents', () => {
  test('wraps original root streams and restores the default graphics state', async () => {
    const store = await richLineStore();
    expect((await analysePage(store, 0)).graphicsState.finalCtm).toEqual([
      0.75, 0, 0, -0.75, 28.5, 656.75,
    ]);
    const originalReferences = store.listPageStreams(0)
      .filter(({ path }) => path.length === 1)
      .map(({ path }) => path[0]!.ref);

    const result = await isolatePageContents(store, 0);

    const roots = store.listPageStreams(0).filter(({ path }) => path.length === 1);
    expect(result.changed).toBe(true);
    expect(decoder.decode(roots[0]!.decodedBytes)).toBe(PDF_SCRUBBER_PAGE_ISOLATION_PREFIX);
    expect(roots.slice(1, -1).map(({ path }) => path[0]!.ref)).toEqual(originalReferences);
    expect(decoder.decode(roots.at(-1)!.decodedBytes)).toBe(PDF_SCRUBBER_PAGE_ISOLATION_SUFFIX);
    expect((await analysePage(store, 0)).graphicsState.finalCtm).toEqual([1, 0, 0, 1, 0, 0]);
  });

  test('reuses a legacy wrapper without adding a second wrapper', async () => {
    const store = await richLineStore();
    await isolatePageContents(store, 0);
    const roots = store.listPageStreams(0).filter(({ path }) => path.length === 1);
    const legacy = PAGE_ISOLATION_VARIANTS[1]!;
    store.replaceStreamBytes(0, roots[0]!.path, new TextEncoder().encode(legacy.prefix));
    store.replaceStreamBytes(0, roots.at(-1)!.path, new TextEncoder().encode(legacy.suffix));

    const result = await isolatePageContents(store, 0);

    expect(result.changed).toBe(false);
    expect(store.listPageStreams(0).filter(({ path }) => path.length === 1)).toHaveLength(
      roots.length,
    );
  });

  test('is idempotent before and after serialisation', async () => {
    const store = await richLineStore();
    const first = await isolatePageContents(store, 0);
    const afterFirst = store.listPageStreams(0).filter(({ path }) => path.length === 1);

    const second = await isolatePageContents(store, 0);
    const reopened = await ObjectStore.open(
      await store.serialiseCandidate(),
      PROVISIONAL_LIMITS,
    );
    const third = await isolatePageContents(reopened, 0);

    expect(first.changed).toBe(true);
    expect(second).toMatchObject({
      changed: false,
      prefixRef: first.prefixRef,
      suffixRef: first.suffixRef,
    });
    expect(store.listPageStreams(0).filter(({ path }) => path.length === 1)).toHaveLength(
      afterFirst.length,
    );
    expect(third.changed).toBe(false);
  });
});
