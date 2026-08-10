import {
  PDFDocument,
  PDFArray,
  PDFHexString,
  PDFName,
  type PDFDict,
  type PDFRef,
} from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import {
  inspectDocumentFonts,
  inspectDocumentFontsForTesting,
  type DocumentEditingFont,
  type DocumentFontInventoryVisit,
} from '../../src/analysis/document-font-inventory';
import { PROVISIONAL_LIMITS, type EngineLimits } from '../../src/limits';
import { ObjectStore } from '../../src/pdf/object-store';

type FontOptions = Readonly<{
  baseFont?: string;
  family?: string;
  descriptorName?: string | null;
  descriptor?: boolean;
  embedded?: boolean;
}>;

function fontResource(document: PDFDocument, options: FontOptions): PDFRef {
  const dictionary = document.context.obj({
    Type: 'Font',
    Subtype: 'Type1',
    FirstChar: 65,
    LastChar: 65,
    Widths: [500],
  });
  if (options.baseFont !== undefined) {
    dictionary.set(PDFName.of('BaseFont'), PDFName.of(options.baseFont));
  }
  if (options.descriptor !== false) {
    const descriptor = document.context.obj({
      Type: 'FontDescriptor',
      Ascent: 800,
      Descent: -200,
      MissingWidth: 500,
    });
    const descriptorName = options.descriptorName === undefined
      ? options.baseFont
      : options.descriptorName;
    if (descriptorName !== null && descriptorName !== undefined) {
      descriptor.set(PDFName.of('FontName'), PDFHexString.fromText(descriptorName));
    }
    if (options.family !== undefined) {
      descriptor.set(PDFName.of('FontFamily'), PDFHexString.fromText(options.family));
    }
    if (options.embedded === true) {
      descriptor.set(
        PDFName.of('FontFile2'),
        document.context.register(document.context.stream(Uint8Array.of(0, 1, 2))),
      );
    }
    dictionary.set(PDFName.of('FontDescriptor'), document.context.register(descriptor));
  }
  return document.context.register(dictionary);
}

function type0FontResource(document: PDFDocument, embedded: boolean): PDFRef {
  const descriptor = document.context.obj({
    Type: 'FontDescriptor',
    FontName: PDFHexString.fromText('CompositeHelveticaDescriptor'),
    FontFamily: PDFHexString.fromText('Composite Helvetica Family'),
    Ascent: 800,
    Descent: -200,
    MissingWidth: 500,
  });
  if (embedded) {
    descriptor.set(
      PDFName.of('FontFile2'),
      document.context.register(document.context.stream(Uint8Array.of(0, 1, 2))),
    );
  }
  const descendant = document.context.register(document.context.obj({
    Type: 'Font',
    Subtype: 'CIDFontType2',
    BaseFont: 'Helvetica',
    CIDSystemInfo: {
      Registry: 'Adobe',
      Ordering: 'Identity',
      Supplement: 0,
    },
    FontDescriptor: document.context.register(descriptor),
    DW: 1000,
  }));
  return document.context.register(document.context.obj({
    Type: 'Font',
    Subtype: 'Type0',
    BaseFont: 'Helvetica',
    Encoding: 'Identity-H',
    DescendantFonts: [descendant],
  }));
}

function form(
  document: PDFDocument,
  content: string,
  resources: PDFDict,
): PDFRef {
  return document.context.register(document.context.stream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, 100, 100],
    Resources: resources,
  }));
}

async function inventoryFixture(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const family = fontResource(document, {
    family: 'DejaVu Sans',
    descriptorName: null,
  });
  const descriptorName = fontResource(document, {
    baseFont: 'WrongBaseTwo',
    descriptorName: 'ABCDEF+FontNamePreferred',
  });
  const baseFallback = fontResource(document, {
    baseFont: 'ABCDEF+BaseFallback',
    descriptor: false,
  });
  const embedded = fontResource(document, {
    baseFont: 'EmbeddedPrivate',
    embedded: true,
  });
  const standard = fontResource(document, { baseFont: 'Helvetica-Bold' });

  const inner = form(
    document,
    'BT /FNested 12 Tf (A) Tj ET',
    document.context.obj({ Font: { FNested: baseFallback } }),
  );
  const outer = form(
    document,
    '/Inner Do',
    document.context.obj({ XObject: { Inner: inner } }),
  );
  const first = document.addPage([200, 200]);
  first.node.set(PDFName.of('Resources'), document.context.obj({
    Font: { FFamily: family, FName: descriptorName, FEmbedded: embedded, FStandard: standard },
    XObject: { Outer: outer },
  }));
  first.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.stream('BT /FFamily 12 Tf (A) Tj ET /Outer Do')),
  );

  const second = document.addPage([200, 200]);
  const duplicate = fontResource(document, {
    family: 'dejavu sans',
    descriptorName: null,
  });
  second.node.set(
    PDFName.of('Resources'),
    document.context.obj({ Font: { FDuplicate: duplicate } }),
  );
  second.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.stream('BT /FDuplicate 12 Tf (A) Tj ET')),
  );
  return document.save({ useObjectStreams: false });
}

async function inventoryFor(
  options: readonly FontOptions[],
): Promise<readonly DocumentEditingFont[]> {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 200]);
  page.node.set(PDFName.of('Resources'), document.context.obj({
    Font: Object.fromEntries(options.map((font, index) => [
      `F${index}`,
      fontResource(document, font),
    ])),
  }));
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.stream('q Q')),
  );
  const store = await ObjectStore.open(
    await document.save({ useObjectStreams: false }),
    PROVISIONAL_LIMITS,
  );
  return inspectDocumentFonts(store);
}

async function type0Inventory(embedded: boolean): Promise<readonly DocumentEditingFont[]> {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 200]);
  page.node.set(PDFName.of('Resources'), document.context.obj({
    Font: { FType0: type0FontResource(document, embedded) },
  }));
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.stream('BT /FType0 12 Tf <0041> Tj ET')),
  );
  const store = await ObjectStore.open(
    await document.save({ useObjectStreams: false }),
    PROVISIONAL_LIMITS,
  );
  return inspectDocumentFonts(store);
}

async function sharedFormInventoryStore(
  contentStreamCount: number,
  limits: EngineLimits = PROVISIONAL_LIMITS,
): Promise<ObjectStore> {
  const document = await PDFDocument.create();
  const sharedFont = fontResource(document, {
    baseFont: 'ABCDEF+SharedPrivate',
    descriptor: false,
  });
  const sharedForm = form(
    document,
    'BT /FShared 12 Tf (A) Tj ET',
    document.context.obj({ Font: { FShared: sharedFont } }),
  );
  const page = document.addPage([200, 200]);
  page.node.set(PDFName.of('Resources'), document.context.obj({
    Font: { FShared: sharedFont },
    XObject: { Shared: sharedForm },
  }));
  const contents = PDFArray.withContext(document.context);
  for (let index = 0; index < contentStreamCount; index += 1) {
    contents.push(document.context.register(document.context.stream('/Shared Do')));
  }
  page.node.set(PDFName.of('Contents'), contents);
  return ObjectStore.open(
    await document.save({ useObjectStreams: false }),
    limits,
  );
}

describe('inspectDocumentFonts', () => {
  it('includes every editing font reason and preserves style-specific identity', async () => {
    await expect(inventoryFor([
      {
        baseFont: 'ABCDEF+DejaVuSans',
        family: 'DejaVu Sans',
        descriptorName: 'ABCDEF+DejaVuSans',
      },
      {
        baseFont: 'ABCDEF+DejaVuSans-Bold',
        family: 'DejaVu Sans',
        descriptorName: 'ABCDEF+DejaVuSans-Bold',
        embedded: true,
      },
      { baseFont: 'Helvetica', descriptor: false },
    ])).resolves.toEqual([
      { name: 'DejaVuSans', reason: 'not-embedded' },
      { name: 'DejaVuSans-Bold', reason: 'embedded-not-reusable' },
      { name: 'Helvetica', reason: 'standard-font' },
    ]);
  });

  it('reports safe deduplicated names across pages and nested Forms', async () => {
    const store = await ObjectStore.open(await inventoryFixture(), PROVISIONAL_LIMITS);
    await expect(inspectDocumentFonts(store)).resolves.toEqual([
      { name: 'BaseFallback', reason: 'not-embedded' },
      { name: 'DejaVu Sans', reason: 'not-embedded' },
      { name: 'EmbeddedPrivate', reason: 'embedded-not-reusable' },
      { name: 'FontNamePreferred', reason: 'not-embedded' },
      { name: 'Helvetica-Bold', reason: 'standard-font' },
    ]);
  });

  it('reports every genuine Standard 14 variant as requiring an editing file', async () => {
    const names = [
      'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
      'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
      'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
      'Symbol', 'ZapfDingbats',
    ];
    const results = await Promise.all(names.map((name, index) => inventoryFor([{
      baseFont: `${index === 0 ? 'ABCDEF+' : ''}${name}`,
    }])));
    expect(results).toEqual(names.map((name) => [{ name, reason: 'standard-font' }]));
  });

  it('classifies an unembedded Type0 font with a Standard-14-looking BaseFont normally', async () => {
    await expect(type0Inventory(false)).resolves.toEqual([
      { name: 'CompositeHelveticaDescriptor', reason: 'not-embedded' },
    ]);
  });

  it('includes an embedded Type0 font with a Standard-14-looking BaseFont', async () => {
    await expect(type0Inventory(true)).resolves.toEqual([
      { name: 'CompositeHelveticaDescriptor', reason: 'embedded-not-reusable' },
    ]);
  });

  it('uses the most actionable reason when equivalent display names disagree', async () => {
    await expect(inventoryFor([
      {
        baseFont: 'Helvetica',
        descriptorName: 'SharedFace',
      },
      {
        baseFont: 'PrivateEmbedded',
        descriptorName: 'sharedface',
        embedded: true,
      },
    ])).resolves.toEqual([
      { name: 'SharedFace', reason: 'embedded-not-reusable' },
    ]);

    await expect(inventoryFor([
      {
        baseFont: 'Helvetica',
        descriptorName: 'SharedFace',
      },
      {
        baseFont: 'PrivateEmbedded',
        descriptorName: 'sharedface',
        embedded: true,
      },
      {
        baseFont: 'PrivateMissing',
        descriptorName: 'SHAREDFACE',
      },
    ])).resolves.toEqual([
      { name: 'SharedFace', reason: 'not-embedded' },
    ]);
  });

  it('uses BaseFont when descriptor metadata is entirely absent', async () => {
    await expect(inventoryFor([{
      baseFont: 'ABCDEF+BaseFallback',
      descriptor: false,
    }])).resolves.toEqual([{ name: 'BaseFallback', reason: 'not-embedded' }]);
  });

  it('falls through an unusable family to the descriptor font name', async () => {
    await expect(inventoryFor([{
      baseFont: 'WrongBase',
      family: '\u0000\u0085\u202E',
      descriptorName: 'ABCDEF+DescriptorFallback',
    }])).resolves.toEqual([{ name: 'DescriptorFallback', reason: 'not-embedded' }]);
  });

  it('falls through unusable descriptor names to BaseFont', async () => {
    await expect(inventoryFor([{
      baseFont: 'ABCDEF+BaseFallback',
      family: '\u0000\u0085',
      descriptorName: '\u202E\u2066\u2069',
    }])).resolves.toEqual([{ name: 'BaseFallback', reason: 'not-embedded' }]);
  });

  it('removes C0, C1, bidi, and Unicode format controls from presentation names', async () => {
    await expect(inventoryFor([{
      family: 'Safe\u0000\u0085\u202E\u2066\u200F\uFEFFName',
      descriptorName: null,
    }])).resolves.toEqual([{ name: 'SafeName', reason: 'not-embedded' }]);
  });

  it('bounds presentation names to 96 Unicode code points without splitting a surrogate', async () => {
    const bounded = `${'A'.repeat(95)}😀`;
    await expect(inventoryFor([{
      family: `${bounded}${'B'.repeat(100)}`,
      descriptorName: null,
    }])).resolves.toEqual([{ name: bounded, reason: 'not-embedded' }]);
  });

  it('deduplicates equivalent names after presentation sanitisation', async () => {
    await expect(inventoryFor([{
      family: 'Shared\u202E Face',
      descriptorName: null,
    }, {
      family: 'Shared Face',
      descriptorName: null,
    }])).resolves.toEqual([{ name: 'Shared Face', reason: 'not-embedded' }]);
  });

  it('uses distinct bounded safe fallbacks for unnamed indirect font resources', async () => {
    const first = await inventoryFor([
      { descriptor: false },
      { descriptor: false },
    ]);
    const second = await inventoryFor([
      { descriptor: false },
      { descriptor: false },
    ]);

    expect(first).toHaveLength(2);
    expect(new Set(first.map(({ name }) => name)).size).toBe(2);
    expect(first.every(({ name }) => /^Unnamed font \d+ 0 R$/.test(name))).toBe(true);
    expect(first.every(({ reason }) => reason === 'not-embedded')).toBe(true);
    expect(first.every(({ name }) => [...name].length <= 96)).toBe(true);
    expect(second).toEqual(first);
  });

  it('avoids content-stream copies and inspects shared resource/font objects near once', async () => {
    const store = await sharedFormInventoryStore(64);
    const listPageStreams = vi.spyOn(store, 'listPageStreams');
    const visits = new Map<DocumentFontInventoryVisit, number>();

    await expect(inspectDocumentFontsForTesting(store, {
      onVisit(visit) {
        visits.set(visit, (visits.get(visit) ?? 0) + 1);
      },
    })).resolves.toEqual([{ name: 'SharedPrivate', reason: 'not-embedded' }]);

    expect(listPageStreams).not.toHaveBeenCalled();
    expect(visits).toEqual(new Map<DocumentFontInventoryVisit, number>([
      ['page', 1],
      ['resourceDictionary', 2],
      ['fontObject', 1],
      ['formObject', 1],
    ]));
  });

  it('fails with controlled RESOURCE_LIMIT instead of truncating at the aggregate work budget', async () => {
    const store = await sharedFormInventoryStore(2, {
      ...PROVISIONAL_LIMITS,
      maxOperationsPerStream: 2,
    });

    await expect(inspectDocumentFonts(store)).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
      details: {
        resource: 'operations',
        limit: 2,
        observedOperations: 3,
      },
    });
  });

  it('fails deterministically with controlled RESOURCE_LIMIT at the processing deadline', async () => {
    const store = await sharedFormInventoryStore(2, {
      ...PROVISIONAL_LIMITS,
      maxProcessingMs: 10,
    });
    let now = 0;

    await expect(inspectDocumentFontsForTesting(store, {
      now: () => {
        now += 6;
        return now;
      },
    })).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
      details: {
        resource: 'processingTime',
        limit: 10,
      },
    });
  });
});
