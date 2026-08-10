import { PDFArray, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { describe, expect, test } from 'vitest';

import { analysePage } from '../../src/analysis/analyse-page';
import {
  buildMutationPreconditions,
  exciseSpan,
  type ExcisionInput,
} from '../../src/mutation/excise';
import { PROVISIONAL_LIMITS } from '../../src/limits';
import type { AnalysedSpan } from '../../src/model';
import { ObjectStore } from '../../src/pdf/object-store';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function documentWithStreams(streams: readonly string[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 300]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontName = page.node.newFontDictionary('Test', font.ref).toString();
  const references = streams.map((stream) => document.context.register(
    document.context.stream(stream.replaceAll('{FONT}', fontName)),
  ));
  const contents = PDFArray.withContext(document.context);
  references.forEach((reference) => contents.push(reference));
  page.node.set(PDFName.of('Contents'), contents);
  return document.save({ useObjectStreams: false });
}

async function inputFor(
  store: ObjectStore,
  span: AnalysedSpan,
  overrides: Partial<ExcisionInput> = {},
): Promise<ExcisionInput> {
  return {
    pageIndex: 0,
    span,
    currentRevision: 0,
    expectedRevision: 0,
    preconditions: await buildMutationPreconditions(store, 0, span),
    ...overrides,
  };
}

function select(span: AnalysedSpan, start: number, end: number): AnalysedSpan {
  return Object.freeze({
    ...span,
    address: Object.freeze({
      ...span.address,
      glyphRange: Object.freeze({ start, end }),
    }),
  });
}

describe('exciseSpan', () => {
  test('removes a complete Tj operation while preserving every unrelated byte', async () => {
    const source = 'q\nBT\n{FONT} 12 Tf\n20 40 Td\n(Hello) Tj\nET\nQ\n% untouched\n';
    const store = await ObjectStore.open(
      await documentWithStreams([source]),
      PROVISIONAL_LIMITS,
    );
    const span = (await analysePage(store, 0)).spans[0]!;
    const before = store.listPageStreams(0)[0]!.decodedBytes;
    const target = encoder.encode('(Hello) Tj');
    const targetOffset = decoder.decode(before).indexOf('(Hello) Tj');

    const result = await exciseSpan(store, await inputFor(store, span));

    const after = store.listPageStreams(0)[0]!.decodedBytes;
    expect(after.slice(0, targetOffset)).toEqual(before.slice(0, targetOffset));
    expect(after.slice(after.length - (before.length - targetOffset - target.length))).toEqual(
      before.slice(targetOffset + target.length),
    );
    expect(decoder.decode(after)).not.toContain('(Hello) Tj');
    expect(decoder.decode(after)).toMatch(/\[-?[0-9.]+\] TJ/);
    expect(result.removedSourceBytes).toEqual(encoder.encode('Hello'));
  });

  test('preserves exact literal prefix and suffix codes for a partial selection', async () => {
    const store = await ObjectStore.open(
      await documentWithStreams(['BT {FONT} 12 Tf 20 40 Td (H\\145llo) Tj ET']),
      PROVISIONAL_LIMITS,
    );
    const whole = (await analysePage(store, 0)).spans[0]!;
    const selected = select(whole, 1, 4);

    await exciseSpan(store, await inputFor(store, selected));

    const output = decoder.decode(store.listPageStreams(0)[0]!.decodedBytes);
    expect(output).toMatch(/\[\(H\) -?[0-9.]+ \(o\)\] TJ/);
    expect(output).not.toContain('\\145');
  });

  test('preserves TJ adjustments outside the selected source-code interval', async () => {
    const store = await ObjectStore.open(
      await documentWithStreams([
        'BT {FONT} 12 Tf 20 40 Td [(A) -40 (BC) 20 (D)] TJ ET',
      ]),
      PROVISIONAL_LIMITS,
    );
    const whole = (await analysePage(store, 0)).spans[0]!;
    const selected = select(whole, 1, 3);

    await exciseSpan(store, await inputFor(store, selected));

    const output = decoder.decode(store.listPageStreams(0)[0]!.decodedBytes);
    expect(output).toContain('(A)');
    expect(output).toContain('-40');
    expect(output).toContain('20');
    expect(output).toContain('(D)');
    expect(output).not.toContain('(BC)');
  });

  test.each([
    [0, 5],
    [1, 4],
  ])('preserves later text geometry after excising glyph range %i..%i', async (start, end) => {
    const store = await ObjectStore.open(
      await documentWithStreams([
        'BT {FONT} 12 Tf 20 40 Td (Hello) Tj (Later) Tj ET',
      ]),
      PROVISIONAL_LIMITS,
    );
    const before = await analysePage(store, 0);
    const hello = select(before.spans.find(({ unicode }) => unicode === 'Hello')!, start, end);
    const laterBefore = before.spans.find(({ unicode }) => unicode === 'Later')!.baseline;

    await exciseSpan(store, await inputFor(store, hello));

    const laterAfter = (await analysePage(store, 0)).spans.find(
      ({ unicode }) => unicode === 'Later',
    )!.baseline;
    expect(laterAfter[0]).toBeCloseTo(laterBefore[0], 7);
    expect(laterAfter[1]).toBeCloseTo(laterBefore[1], 7);
  });

  test.each([
    ["(Hello) '", 'T*'],
    ['2 3 (Hello) "', '2 Tw\n3 Tc\nT*'],
  ])('expands quote operator %s to preserve its state changes', async (operator, expected) => {
    const store = await ObjectStore.open(
      await documentWithStreams([
        `BT {FONT} 12 Tf 14 TL 20 60 Td ${operator} ET`,
      ]),
      PROVISIONAL_LIMITS,
    );
    const span = (await analysePage(store, 0)).spans[0]!;

    await exciseSpan(store, await inputFor(store, span));

    const output = decoder.decode(store.listPageStreams(0)[0]!.decodedBytes);
    expect(output).toContain(expected);
    expect(output).not.toContain('Hello');
  });

  test('rejects stale revisions and changed operator bytes', async () => {
    const store = await ObjectStore.open(
      await documentWithStreams(['BT {FONT} 12 Tf (Hello) Tj ET']),
      PROVISIONAL_LIMITS,
    );
    const span = (await analysePage(store, 0)).spans[0]!;
    const input = await inputFor(store, span);

    await expect(exciseSpan(store, { ...input, currentRevision: 1 })).rejects.toMatchObject({
      code: 'STALE_REVISION',
    });
    await expect(exciseSpan(store, {
      ...input,
      preconditions: { ...input.preconditions, expectedOperatorDigest: '0'.repeat(64) },
    })).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });

  test('compares glyph preconditions against a fresh authoritative decode', async () => {
    const store = await ObjectStore.open(
      await documentWithStreams(['BT {FONT} 12 Tf (Hello) Tj ET']),
      PROVISIONAL_LIMITS,
    );
    const staleSpan = (await analysePage(store, 0)).spans[0]!;
    const staleInput = await inputFor(store, staleSpan);
    store.replaceStreamBytes(
      0,
      staleSpan.address.streamPath,
      encoder.encode(
        decoder.decode(store.listPageStreams(0)[0]!.decodedBytes).replace('(Hello)', '(World)'),
      ),
    );
    const currentSpan = (await analysePage(store, 0)).spans[0]!;
    const current = await buildMutationPreconditions(store, 0, currentSpan);

    await expect(exciseSpan(store, {
      ...staleInput,
      preconditions: {
        expectedOperatorDigest: current.expectedOperatorDigest,
        expectedGlyphText: staleInput.preconditions.expectedGlyphText,
      },
    })).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });

  test('refuses a shared target before changing either page', async () => {
    const bytes = await import('node:fs/promises').then(({ readFile }) =>
      readFile('fixtures/generated/18-shared-form-xobject.pdf'));
    const store = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
    const span = (await analysePage(store, 0)).spans.find(
      ({ unicode }) => unicode === 'Target 18',
    )!;
    const original = store.resolveStreamPath(0, span.address.streamPath).decodedBytes;

    await expect(exciseSpan(store, await inputFor(store, span))).rejects.toMatchObject({
      code: 'READ_ONLY_SPAN',
    });
    expect(store.resolveStreamPath(0, span.address.streamPath).decodedBytes).toEqual(original);
  });
});
