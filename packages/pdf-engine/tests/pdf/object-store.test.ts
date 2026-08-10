import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  PDFArray,
  PDFDocument,
  PDFName,
  type PDFRef,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { PROVISIONAL_LIMITS } from '../../src/limits';
import { ObjectStore } from '../../src/pdf/object-store';

async function fixture(id: string): Promise<Uint8Array> {
  return readFile(resolve('fixtures/generated', `${id}.pdf`));
}

async function documentWithOrderedStreams(): Promise<{
  bytes: Uint8Array;
  references: readonly PDFRef[];
}> {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 300]);
  const first = document.context.register(
    document.context.stream('BT (first) Tj ET'),
  );
  const second = document.context.register(
    document.context.stream('BT (second) Tj ET'),
  );
  const contents = PDFArray.withContext(document.context);
  contents.push(first);
  contents.push(second);
  page.node.set(PDFName.of('Contents'), contents);
  return {
    bytes: await document.save({ useObjectStreams: false }),
    references: [first, second],
  };
}

function paddedPdf(bytes: Uint8Array, byteLength: number): Uint8Array {
  if (bytes.byteLength > byteLength) {
    throw new RangeError('PDF is already larger than the requested test size');
  }
  const padded = new Uint8Array(byteLength);
  padded.set(bytes);
  return padded;
}

describe('ObjectStore', () => {
  it('accepts a PDF at the exact 15 MiB product boundary', async () => {
    const { bytes } = await documentWithOrderedStreams();

    const store = await ObjectStore.open(
      paddedPdf(bytes, 15_728_640),
      { ...PROVISIONAL_LIMITS, maxFileBytes: 15_728_640 },
    );

    expect(store.resourceUsage().fileBytes).toBe(15_728_640);
  });

  it('rejects a PDF one byte over 15 MiB with file-byte details', async () => {
    const { bytes } = await documentWithOrderedStreams();

    await expect(
      ObjectStore.open(
        paddedPdf(bytes, 15_728_641),
        { ...PROVISIONAL_LIMITS, maxFileBytes: 15_728_640 },
      ),
    ).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
      details: {
        resource: 'fileBytes',
        limit: 15_728_640,
        observedBytes: 15_728_641,
      },
    });
  });

  it('preserves page content stream order and indirect identities', async () => {
    const { bytes, references } = await documentWithOrderedStreams();
    const store = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);

    const streams = store.listPageStreams(0);

    expect(streams).toHaveLength(2);
    expect(streams.map(({ path }) => path[0]?.ref.objectNumber)).toEqual(
      references.map(({ objectNumber }) => objectNumber),
    );
    expect(streams.map(({ decodedBytes }) => new TextDecoder().decode(decodedBytes)))
      .toEqual(['BT (first) Tj ET', 'BT (second) Tj ET']);
    expect(streams.every(({ path }) => path[0]?.kind === 'pageContents'))
      .toBe(true);
  });

  it('rejects an inline page stream instead of inventing an object identity', async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([300, 300]);
    page.node.set(
      PDFName.of('Contents'),
      document.context.stream('BT (inline) Tj ET'),
    );
    const bytes = await document.save({ useObjectStreams: false });

    await expect(ObjectStore.open(bytes, PROVISIONAL_LIMITS)).rejects.toMatchObject({
      code: 'MALFORMED_INPUT',
    });
  });

  it('traverses nested Form XObjects by resource path', async () => {
    const store = await ObjectStore.open(
      await fixture('17-nested-form-xobject'),
      PROVISIONAL_LIMITS,
    );

    const streams = store.listPageStreams(0);
    const nested = streams.find(({ path }) => path.length === 3);

    expect(nested?.path.map(({ kind }) => kind)).toEqual([
      'pageContents',
      'formXObject',
      'formXObject',
    ]);
    expect(nested?.path[1]?.resourceName).toMatch(/^M0Form-/);
    expect(nested?.path[2]?.resourceName).toBe('Inner');
    expect(new TextDecoder().decode(nested?.decodedBytes)).toContain('Target 17');
  });

  it('counts a Form XObject referenced by two pages', async () => {
    const store = await ObjectStore.open(
      await fixture('18-shared-form-xobject'),
      PROVISIONAL_LIMITS,
    );

    const firstPageForm = store
      .listPageStreams(0)
      .find(({ path }) => path.at(-1)?.kind === 'formXObject');
    const secondPageForm = store
      .listPageStreams(1)
      .find(({ path }) => path.at(-1)?.kind === 'formXObject');

    expect(firstPageForm?.path.at(-1)?.ref).toEqual(
      secondPageForm?.path.at(-1)?.ref,
    );
    expect(firstPageForm?.referenceCount).toBe(2);
    expect(secondPageForm?.referenceCount).toBe(2);
  });

  it('reports bounded resource usage measured while opening the object graph', async () => {
    const bytes = await fixture('17-nested-form-xobject');
    const store = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
    const streams = store.listPageStreams(0);

    expect(store.resourceUsage()).toEqual({
      fileBytes: bytes.byteLength,
      objectCount: expect.any(Number),
      maximumNestingDepth: 2,
      peakDecodedStreamBytes: Math.max(...streams.map(({ decodedBytes }) => decodedBytes.byteLength)),
      totalDecodedStreamBytes: streams.reduce(
        (total, { decodedBytes }) => total + decodedBytes.byteLength,
        0,
      ),
    });
  });

  it('names indirect-object and Form-nesting resource failures', async () => {
    const { bytes } = await documentWithOrderedStreams();
    await expect(ObjectStore.open(bytes, {
      ...PROVISIONAL_LIMITS,
      maxObjects: 1,
    })).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
      details: {
        resource: 'indirectObjects',
        limit: 1,
        observedObjects: expect.any(Number),
      },
    });

    await expect(ObjectStore.open(
      await fixture('17-nested-form-xobject'),
      { ...PROVISIONAL_LIMITS, maxNestingDepth: 0 },
    )).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
      details: {
        resource: 'nestingDepth',
        limit: 0,
        observedDepth: 1,
      },
    });
  });

  it('resolves, replaces, and serialises a stream without changing its path', async () => {
    const store = await ObjectStore.open(
      await fixture('01-simple-tj'),
      PROVISIONAL_LIMITS,
    );
    const original = store.listPageStreams(0)[0];
    expect(original).toBeDefined();

    const replacement = new TextEncoder().encode('BT (Edited 01) Tj ET');
    store.replaceStreamBytes(0, original!.path, replacement);

    expect(store.resolveStreamPath(0, original!.path).decodedBytes).toEqual(
      replacement,
    );
    const reopened = await ObjectStore.open(
      await store.serialiseCandidate(),
      PROVISIONAL_LIMITS,
    );
    expect(reopened.resolveStreamPath(0, original!.path).decodedBytes).toEqual(
      replacement,
    );
  });

  it('rejects encryption evidence before loading the object graph', async () => {
    await expect(
      ObjectStore.open(
        await fixture('25-encryption-marker'),
        PROVISIONAL_LIMITS,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_DOCUMENT' });
  });

  it('stops before decoding a stream whose trusted test marker exceeds the cap', async () => {
    await expect(
      ObjectStore.open(
        await fixture('27-decompression-abuse'),
        PROVISIONAL_LIMITS,
      ),
    ).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
      details: expect.objectContaining({ resource: 'decodedStreamBytes' }),
    });
  });
});
