import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFStream,
  PDFString,
} from 'pdf-lib';
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
const BASE_PDF_PATH = 'fixtures/generated/01-simple-tj.pdf';
const XMP_PACKET = new TextEncoder().encode(
  '<?xpacket begin="\uFEFF"?><x:xmpmeta xmlns:x="adobe:ns:meta/">original packet</x:xmpmeta><?xpacket end="w"?>',
);

type MetadataFixture = Readonly<{
  name: string;
  creator?: string;
  producer?: string;
  customValue?: string;
  creationDate?: string;
  modificationDate?: string;
}>;

const METADATA_FIXTURES: readonly MetadataFixture[] = [
  { name: 'no Info dictionary' },
  { name: 'Creator without Producer', creator: 'Original Creator' },
  {
    name: 'Creator and Producer with custom keys',
    creator: 'Original Creator',
    producer: 'Original Producer',
    customValue: 'Original custom value',
    creationDate: 'D:20200102030405Z',
    modificationDate: 'D:20210102030405Z',
  },
];

async function fixtureWithMetadata(metadata: MetadataFixture): Promise<Uint8Array> {
  const document = await PDFDocument.load(await readFile(BASE_PDF_PATH), {
    updateMetadata: false,
  });
  if (
    metadata.creator !== undefined ||
    metadata.producer !== undefined ||
    metadata.customValue !== undefined ||
    metadata.creationDate !== undefined ||
    metadata.modificationDate !== undefined
  ) {
    const info = PDFDict.withContext(document.context);
    if (metadata.creator !== undefined) {
      info.set(PDFName.of('Creator'), PDFHexString.fromText(metadata.creator));
    }
    if (metadata.producer !== undefined) {
      info.set(PDFName.of('Producer'), PDFHexString.fromText(metadata.producer));
    }
    if (metadata.customValue !== undefined) {
      info.set(PDFName.of('CustomKey'), PDFHexString.fromText(metadata.customValue));
    }
    if (metadata.creationDate !== undefined) {
      info.set(PDFName.of('CreationDate'), PDFString.of(metadata.creationDate));
    }
    if (metadata.modificationDate !== undefined) {
      info.set(PDFName.of('ModDate'), PDFString.of(metadata.modificationDate));
    }
    document.context.trailerInfo.Info = document.context.register(info);
  } else {
    delete document.context.trailerInfo.Info;
  }
  document.catalog.set(
    PDFName.of('Metadata'),
    document.context.register(document.context.stream(XMP_PACKET, {
      Type: 'Metadata',
      Subtype: 'XML',
    })),
  );
  return document.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });
}

async function run(sourceBytes: Uint8Array): Promise<Readonly<{ bytes: Uint8Array; hash: string }>> {
  const store = await ObjectStore.open(
    sourceBytes,
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

function assertInfoDictionary(
  document: PDFDocument,
  metadata: MetadataFixture,
): void {
  const infoObject = document.context.trailerInfo.Info;
  const hasExpectedInfo =
    metadata.creator !== undefined ||
    metadata.producer !== undefined ||
    metadata.customValue !== undefined ||
    metadata.creationDate !== undefined ||
    metadata.modificationDate !== undefined;
  expect(infoObject !== undefined).toBe(hasExpectedInfo);
  if (!hasExpectedInfo) return;

  const info = document.context.lookup(infoObject, PDFDict);
  expect(info.lookupMaybe(PDFName.of('Creator'), PDFString, PDFHexString)?.decodeText())
    .toBe(metadata.creator);
  expect(info.lookupMaybe(PDFName.of('Producer'), PDFString, PDFHexString)?.decodeText())
    .toBe(metadata.producer);
  expect(info.lookupMaybe(PDFName.of('CustomKey'), PDFString, PDFHexString)?.decodeText())
    .toBe(metadata.customValue);
  expect(info.lookupMaybe(PDFName.of('CreationDate'), PDFString)?.decodeText())
    .toBe(metadata.creationDate);
  expect(info.lookupMaybe(PDFName.of('ModDate'), PDFString)?.decodeText())
    .toBe(metadata.modificationDate);
}

function rawXmpBytes(document: PDFDocument): Uint8Array {
  const stream = document.catalog.lookup(PDFName.of('Metadata'), PDFStream);
  if (!(stream instanceof PDFRawStream)) {
    throw new Error('Expected the catalog Metadata entry to be a raw stream');
  }
  return stream.contents;
}

describe('deterministic replacement export', () => {
  test('produces byte-identical bytes and SHA-256 hashes from two clean runs', async () => {
    const sourceBytes = await readFile(BASE_PDF_PATH);
    const first = await run(sourceBytes);
    const second = await run(sourceBytes);

    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.hash).toBe(first.hash);
    expect(second.bytes).toEqual(first.bytes);
  });

  for (const metadata of METADATA_FIXTURES) {
    test(`preserves ${metadata.name} and raw XMP`, async () => {
      const sourceBytes = await fixtureWithMetadata(metadata);
      const source = await PDFDocument.load(sourceBytes, { updateMetadata: false });
      assertInfoDictionary(source, metadata);

      const result = await run(sourceBytes);
      const reopened = await PDFDocument.load(result.bytes, { updateMetadata: false });

      assertInfoDictionary(reopened, metadata);
      expect(rawXmpBytes(reopened)).toEqual(rawXmpBytes(source));
      expect(rawXmpBytes(reopened)).toEqual(XMP_PACKET);
    });
  }
});
