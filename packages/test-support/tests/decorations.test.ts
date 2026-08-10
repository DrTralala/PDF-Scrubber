import {
  analysePage,
  groupPageText,
  ObjectStore,
  PROVISIONAL_LIMITS,
} from '@pdf-editor/pdf-engine';
import { describe, expect, test } from 'vitest';

import {
  CORPUS,
  DECORATION_FIXTURE_KINDS,
  buildDecorationFixture,
} from '../src/index';

describe('decoration fixture corpus', () => {
  test.each(DECORATION_FIXTURE_KINDS)('builds deterministic %s bytes with editable text', async (kind) => {
    const first = await buildDecorationFixture(kind);
    const second = await buildDecorationFixture(kind);
    const store = await ObjectStore.open(first, PROVISIONAL_LIMITS);
    const page = await analysePage(store, 0);
    const text = groupPageText(page).groups.map((group) => group.text).join(' ');

    expect(first).toEqual(second);
    expect(new TextDecoder('latin1').decode(first.subarray(0, 8))).toMatch(/^%PDF-/);
    expect(text).toContain(kind === 'ambiguous-owner' ? 'Left Right' : 'Decorated text');
  });

  test('emits the intended simple and rejected graphic forms without changing M0', async () => {
    const decoded = async (kind: Parameters<typeof buildDecorationFixture>[0]) => {
      const store = await ObjectStore.open(
        await buildDecorationFixture(kind),
        PROVISIONAL_LIMITS,
      );
      return store.listPageStreams(0)
        .map(({ decodedBytes }) => new TextDecoder('latin1').decode(decodedBytes))
        .join('\n');
    };

    await expect(decoded('stroked-underline')).resolves.toMatch(/\d+\s+\d+\s+m\s+\d+\s+\d+\s+l\s+S/);
    await expect(decoded('filled-strikethrough')).resolves.toMatch(/re\s+f/);
    await expect(decoded('combined')).resolves.toMatch(/S[\s\S]*re\s+f/);
    await expect(decoded('double-custom')).resolves.toMatch(/\[3 2\]\s+0\s+d/);
    await expect(decoded('table')).resolves.toMatch(/re\s+S/);
    expect(CORPUS).toHaveLength(30);
  });

  test('reuses one decorated Form XObject on two pages for shared-content safety tests', async () => {
    const bytes = await buildDecorationFixture('shared-stream');
    const store = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);

    expect(groupPageText(await analysePage(store, 0)).groups.map(({ text }) => text)).toContain(
      'Decorated text',
    );
    expect(groupPageText(await analysePage(store, 1)).groups.map(({ text }) => text)).toContain(
      'Decorated text',
    );
  });
});
