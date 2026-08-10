import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
} from 'pdf-lib';
import { describe, expect, test } from 'vitest';

import {
  inspectDocumentFonts,
  ObjectStore,
  PROVISIONAL_LIMITS,
} from '../packages/pdf-engine/src';
import {
  loadCommittedPdfSuite,
  parseCommittedPdfManifest,
  resolveCommittedFontPath,
  selectedCommittedPdfSuites,
  verifyCommittedPdfBytes,
} from './committed-pdf-suites';
import { inspectCommittedPdfSemantics } from './committed-pdf-inspection';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\nsynthetic');
const SHA256 = createHash('sha256').update(PDF_BYTES).digest('hex');
const QA_MARK_TEXT = 'PDF-Scrubber QA';

type UnknownRecord = Record<string, unknown>;

const APPROVED_MPLUS_SHA256 =
  '4e37946cb7290be6ecf0af041b76353d1654a8f98b22ced2d6304b136abc3ec8';

const APPROVED_FONT_RECORDS = {
  'Open Sans': {
    inventoryName: 'Open Sans',
    reason: 'embedded-not-reusable',
    weight: 400,
    italic: false,
    source: {
      kind: 'npm',
      package: '@fontsource/open-sans',
      version: '5.3.0',
      file: 'files/open-sans-latin-400-normal.woff',
      sha256: '8b3c81a3240d7c8cc9877cf5233d97051aa07730947217db840e500470a4d44a',
    },
    licence: 'OFL-1.1',
    fonts2uPage: 'https://fonts2u.com/open-sans.font',
    searchUrl: 'https://fonts2u.com/search.html?q=Open+Sans',
  },
  'Open Sans Bold': {
    inventoryName: 'Open Sans Bold',
    reason: 'embedded-not-reusable',
    weight: 700,
    italic: false,
    source: {
      kind: 'npm',
      package: '@fontsource/open-sans',
      version: '5.3.0',
      file: 'files/open-sans-latin-700-normal.woff',
      sha256: '397ccaf840827f6c84ebadf664b6494338d4ea39440ab22811829868014c43f5',
    },
    licence: 'OFL-1.1',
    fonts2uPage: 'https://fonts2u.com/open-sans-bold.font',
    searchUrl: 'https://fonts2u.com/search.html?q=Open+Sans+Bold',
  },
  'Open Sans Italic': {
    inventoryName: 'Open Sans Italic',
    reason: 'embedded-not-reusable',
    weight: 400,
    italic: true,
    source: {
      kind: 'npm',
      package: '@fontsource/open-sans',
      version: '5.3.0',
      file: 'files/open-sans-latin-400-italic.woff',
      sha256: 'fa8383f26e60a89f4eb956d2997b416d22023427100151438b42372718ca8231',
    },
    licence: 'OFL-1.1',
    fonts2uPage: 'https://fonts2u.com/open-sans-italic.font',
    searchUrl: 'https://fonts2u.com/search.html?q=Open+Sans+Italic',
  },
  'M+ 1c regular': {
    inventoryName: 'M+ 1c regular',
    reason: 'embedded-not-reusable',
    weight: 400,
    italic: false,
    source: {
      kind: 'committed',
      path: 'tests/fonts/mplus-1c-regular.ttf',
      version: '1.047',
      sha256: APPROVED_MPLUS_SHA256,
    },
    licence: 'M+ permissive font licence',
    fonts2uPage: 'https://fonts2u.com/m-1c-regular.font',
    searchUrl: 'https://fonts2u.com/search.html?q=M%2B+1c+regular',
  },
  Merriweather: {
    inventoryName: 'Merriweather',
    reason: 'embedded-not-reusable',
    weight: 400,
    italic: false,
    source: {
      kind: 'npm',
      package: '@fontsource/merriweather',
      version: '5.3.0',
      file: 'files/merriweather-latin-400-normal.woff',
      sha256: '68f5bdf7a1f608fbcbdef6d9d9311491e79b3e39f94fc16b5798b805db67d89b',
    },
    licence: 'OFL-1.1',
    fonts2uPage: 'https://fonts2u.com/merriweather.font',
    searchUrl: 'https://fonts2u.com/search.html?q=Merriweather',
  },
  'Source Code Pro': {
    inventoryName: 'Source Code Pro',
    reason: 'embedded-not-reusable',
    weight: 400,
    italic: false,
    source: {
      kind: 'npm',
      package: '@fontsource/source-code-pro',
      version: '5.3.0',
      file: 'files/source-code-pro-latin-400-normal.woff',
      sha256: 'dec1d76f7d39a16026ab85376c3712c4a8182b4d9bca7a8ee1229ce8e43cf49a',
    },
    licence: 'OFL-1.1',
    fonts2uPage: 'https://fonts2u.com/source-code-pro.font',
    searchUrl: 'https://fonts2u.com/search.html?q=Source+Code+Pro',
  },
} as const;

const APPROVED_CONTENT_ASSERTIONS = {
  1: ['English operations review', 'Approval status: Pending', 'Operational checklist'],
  2: ['文件：等待中', '保存成功。', '操作成功。'],
  3: [
    QA_MARK_TEXT,
    'Release status: Draft',
    '版本：已取消',
    'Release evidence',
    'const verdict = "pending";',
  ],
} as const;

const semanticInspections = new Map<1 | 2 | 3, ReturnType<typeof inspectCommittedPdfSemantics>>();

function inspectSuite(suite: 1 | 2 | 3): ReturnType<typeof inspectCommittedPdfSemantics> {
  const existing = semanticInspections.get(suite);
  if (existing !== undefined) return existing;
  const inspection = inspectCommittedPdfSemantics(loadCommittedPdfSuite(suite).pdfBytes);
  semanticInspections.set(suite, inspection);
  return inspection;
}

async function fileAttachmentDocument(fileSpecification: PDFString | 'dictionary'): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([100, 100]);
  const resolvedFileSpecification = fileSpecification === 'dictionary'
    ? document.context.obj({
        Type: 'Filespec',
        F: PDFString.of('ordinary.txt'),
      })
    : fileSpecification;
  const annotation = document.context.register(document.context.obj({
    Type: 'Annot',
    Subtype: 'FileAttachment',
    Rect: [0, 0, 10, 10],
    FS: resolvedFileSpecification,
  }));
  const annotations = document.context.obj([annotation]);
  if (!(annotations instanceof PDFArray)) throw new Error('Synthetic annotations must be an array');
  page.node.set(PDFName.of('Annots'), annotations);
  return document.save({ useObjectStreams: false });
}

async function ordinaryFileSpecificationDocument(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  const fileSpecification = document.context.register(document.context.obj({
    Type: 'Filespec',
    F: PDFString.of('ordinary.txt'),
  }));
  document.catalog.set(PDFName.of('ReviewFile'), fileSpecification);
  return document.save({ useObjectStreams: false });
}

async function stringFileSpecificationEntryDocument(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([100, 100]);
  const annotation = document.context.register(document.context.obj({
    Type: 'Annot',
    Rect: [0, 0, 10, 10],
    FS: PDFString.of('external.txt'),
  }));
  const annotations = document.context.obj([annotation]);
  if (!(annotations instanceof PDFArray)) throw new Error('Synthetic annotations must be an array');
  page.node.set(PDFName.of('Annots'), annotations);
  return document.save({ useObjectStreams: false });
}

type SyntheticImageOptions = Readonly<{
  width: number;
  height: number;
  colourSpace: 'DeviceGray' | 'DeviceRGB';
  primaryBytes: Uint8Array;
  decode?: readonly number[];
  softMask?: Readonly<{ width: number; height: number; bytes: Uint8Array }>;
  cyclicMask?: boolean;
}>;

async function syntheticImageDocument(options: SyntheticImageOptions): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([100, 100]);
  const primary = document.context.flateStream(options.primaryBytes, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: options.width,
    Height: options.height,
    ColorSpace: options.colourSpace,
    BitsPerComponent: 8,
  });
  const primaryReference = document.context.register(primary);
  if (options.decode !== undefined) {
    const decode = document.context.obj([...options.decode]);
    if (!(decode instanceof PDFArray)) throw new Error('Synthetic Decode must be an array');
    primary.dict.set(PDFName.of('Decode'), decode);
  }
  if (options.softMask !== undefined) {
    const softMask = document.context.flateStream(options.softMask.bytes, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: options.softMask.width,
      Height: options.softMask.height,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    });
    const softMaskReference = document.context.register(softMask);
    primary.dict.set(PDFName.of('SMask'), softMaskReference);
    if (options.cyclicMask === true) softMask.dict.set(PDFName.of('Mask'), primaryReference);
  }
  const imageName = page.node.newXObject('Panel', primaryReference).toString();
  const contents = document.context.register(document.context.stream(
    `q 80 0 0 80 10 10 cm ${imageName} Do Q`,
  ));
  page.node.set(PDFName.of('Contents'), contents);
  return document.save({ useObjectStreams: false });
}

type SyntheticMarkOptions = Readonly<{
  renderingMode?: 0 | 3 | 7;
  x?: number;
  y?: number;
  opacity?: number;
  clipping?: 'active' | 'restored';
}>;

async function syntheticPdfScrubberMarkDocument(options: SyntheticMarkOptions = {}): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 200]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontName = page.node.newFontDictionary('PDFScrubberMark', font.ref).toString();
  const operations: string[] = ['q'];
  if (options.opacity !== undefined) {
    const graphicsState = document.context.register(document.context.obj({
      Type: 'ExtGState',
      ca: options.opacity,
      CA: options.opacity,
    }));
    operations.push(`${page.node.newExtGState('MarkOpacity', graphicsState).toString()} gs`);
  }
  if (options.clipping === 'active') operations.push('0 0 1 1 re W n');
  if (options.clipping === 'restored') operations.push('q', '0 0 1 1 re W n', 'Q');
  operations.push(
    'BT',
    `${fontName} 24 Tf`,
    `${options.renderingMode ?? 0} Tr`,
    `1 0 0 1 ${options.x ?? 20} ${options.y ?? 100} Tm`,
    `(${QA_MARK_TEXT}) Tj`,
    'ET',
    'Q',
  );
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.stream(operations.join('\n'))),
  );
  return document.save({ useObjectStreams: false });
}

async function syntheticUnterminatedPdfScrubberMarkDocument(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 200]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontName = page.node.newFontDictionary('PDFScrubberMark', font.ref).toString();
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.stream([
      'BT',
      `${fontName} 24 Tf`,
      '0 Tr',
      '1 0 0 1 20 100 Tm',
      `(${QA_MARK_TEXT}) Tj`,
    ].join('\n'))),
  );
  return document.save({ useObjectStreams: false });
}

async function syntheticPdfScrubberMarkWithPageSuffix(
  suffix: readonly string[],
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 200]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontName = page.node.newFontDictionary('PDFScrubberMark', font.ref).toString();
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.stream([
      'BT',
      `${fontName} 24 Tf`,
      '0 Tr',
      '1 0 0 1 20 100 Tm',
      `(${QA_MARK_TEXT}) Tj`,
      'ET',
      ...suffix,
    ].join('\n'))),
  );
  return document.save({ useObjectStreams: false });
}

async function syntheticFormPdfScrubberMarkDocument(options: Readonly<{
  unterminatedText?: boolean;
  pageSuffix?: readonly string[];
}> = {}): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 200]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontName = page.node.newFontDictionary('PDFScrubberMark', font.ref).toString();
  const fontResources = page.node.Resources()?.get(PDFName.of('Font'));
  if (fontResources === undefined) throw new Error('Synthetic Form font resources are missing');
  const formResources = document.context.obj({ Font: fontResources });
  const formOperations = [
    'BT',
    `${fontName} 24 Tf`,
    '0 Tr',
    '1 0 0 1 20 100 Tm',
    `(${QA_MARK_TEXT}) Tj`,
    ...(options.unterminatedText === true ? [] : ['ET']),
  ];
  const form = document.context.stream(formOperations.join('\n'), {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, 200, 200],
    Resources: formResources,
  });
  const formName = page.node.newXObject(
    'PDFScrubberMarkForm',
    document.context.register(form),
  ).toString();
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.stream([
      `${formName} Do`,
      ...(options.pageSuffix ?? []),
    ].join('\n'))),
  );
  return document.save({ useObjectStreams: false });
}

type SyntheticTextClipOptions = Readonly<{
  renderingMode: 4 | 5 | 6 | 7;
  showingOperator: 'Tj' | 'TJ' | "'" | '"';
  restoreWithGraphicsState?: boolean;
  splitAcrossPageStreams?: boolean;
}>;

function syntheticTextShowingOperation(operator: SyntheticTextClipOptions['showingOperator']): string {
  switch (operator) {
    case 'Tj':
      return '(X) Tj';
    case 'TJ':
      return '[(X)] TJ';
    case "'":
      return "(X) '";
    case '"':
      return '0 0 (X) "';
  }
}

async function syntheticTextClippedPdfScrubberMarkDocument(
  options: SyntheticTextClipOptions,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 200]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontName = page.node.newFontDictionary('PDFScrubberMark', font.ref).toString();
  const clippingOperations = [
    ...(options.restoreWithGraphicsState === true ? ['q'] : []),
    'BT',
    `${fontName} 1 Tf`,
    `${options.renderingMode} Tr`,
    '1 0 0 1 0 0 Tm',
    syntheticTextShowingOperation(options.showingOperator),
    'ET',
    ...(options.restoreWithGraphicsState === true ? ['Q'] : []),
  ];
  const markOperations = [
    'BT',
    `${fontName} 24 Tf`,
    '0 Tr',
    '1 0 0 1 20 100 Tm',
    `(${QA_MARK_TEXT}) Tj`,
    'ET',
    'Q',
  ];
  const streamOperations = options.splitAcrossPageStreams === true
    ? [['q', ...clippingOperations], markOperations]
    : [['q', ...clippingOperations, ...markOperations]];
  const streamReferences = streamOperations.map((operations) =>
    document.context.register(document.context.stream(operations.join('\n'))));
  const contents = document.context.obj(streamReferences);
  if (!(contents instanceof PDFArray)) throw new Error('Synthetic contents must be an array');
  page.node.set(PDFName.of('Contents'), contents);
  return document.save({ useObjectStreams: false });
}

function validManifest(): unknown {
  return {
    schemaVersion: 1,
    suite: 1,
    pdf: 'document.pdf',
    sha256: SHA256,
    byteLength: PDF_BYTES.byteLength,
    sizePolicy: { minimumBytes: 1, maximumBytes: 5_242_879 },
    languages: ['en'],
    fonts: [{
      inventoryName: 'Open Sans Bold',
      reason: 'embedded-not-reusable',
      weight: 700,
      italic: false,
      source: {
        kind: 'npm',
        package: '@fontsource/open-sans',
        version: '5.3.0',
        file: 'files/open-sans-latin-700-normal.woff',
        sha256: '397ccaf840827f6c84ebadf664b6494338d4ea39440ab22811829868014c43f5',
      },
      licence: 'OFL-1.1',
      fonts2uPage: 'https://fonts2u.com/open-sans-bold.font',
      searchUrl: 'https://fonts2u.com/search.html?q=Open+Sans+Bold',
    }],
    edits: [{
      language: 'en',
      pageIndex: 0,
      sourceText: 'Approval status: Pending',
      replacementText: 'Approval status: Approved',
      fontInventoryName: 'Open Sans Bold',
      verifyAfterReopen: true,
    }],
    contentAssertions: ['English operations review', 'Approval status: Pending'],
    generation: {
      synthetic: true,
      oneTime: true,
      seed: 'pdf-scrubber-committed-pdf-suites-v1',
      runtime: 'Node.js 24.18.0',
      libraries: { 'pdf-lib': '1.17.1', '@pdf-lib/fontkit': '1.1.1', pngjs: '7.0.0' },
      createdOn: '2026-08-03',
    },
  };
}

function validSuite3Manifest(): unknown {
  return {
    ...asRecord(validManifest()),
    suite: 3,
    sha256: 'b'.repeat(64),
    byteLength: 9_961_472,
    sizePolicy: { minimumBytes: 9_961_472, maximumBytes: 11_010_048 },
    languages: ['en', 'zh-Hans'],
    edits: [
      {
        language: 'en',
        pageIndex: 0,
        sourceText: 'Release status: Draft',
        replacementText: 'Release status: Ready',
        fontInventoryName: 'Open Sans Bold',
        verifyAfterReopen: true,
      },
      {
        language: 'zh-Hans',
        pageIndex: 1,
        sourceText: '版本：已取消',
        replacementText: '版本：已完成',
        fontInventoryName: 'Open Sans Bold',
        verifyAfterReopen: true,
      },
    ],
  };
}

function asRecord(value: unknown): UnknownRecord {
  return value as UnknownRecord;
}

function manifestWith(patch: UnknownRecord): unknown {
  return { ...asRecord(validManifest()), ...patch };
}

function suite3With(patch: UnknownRecord): unknown {
  return { ...asRecord(validSuite3Manifest()), ...patch };
}

function firstFont(): UnknownRecord {
  return (asRecord(validManifest()).fonts as UnknownRecord[])[0] as UnknownRecord;
}

function firstEdit(overrides: UnknownRecord = {}): UnknownRecord {
  return {
    language: 'en',
    pageIndex: 0,
    sourceText: 'Approval status: Pending',
    replacementText: 'Approval status: Approved',
    fontInventoryName: 'Open Sans Bold',
    verifyAfterReopen: true,
    ...overrides,
  };
}

describe('committed PDF suite manifests', () => {
  test('parses the strict immutable contract and verifies matching bytes', () => {
    const manifest = parseCommittedPdfManifest(validManifest(), 1);
    const font = manifest.fonts[0];
    if (!font) throw new Error('valid test manifest has no font');

    verifyCommittedPdfBytes(PDF_BYTES, manifest);

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.sizePolicy)).toBe(true);
    expect(Object.isFrozen(manifest.languages)).toBe(true);
    expect(Object.isFrozen(manifest.fonts)).toBe(true);
    expect(Object.isFrozen(font)).toBe(true);
    expect(Object.isFrozen(font.source)).toBe(true);
    expect(Object.isFrozen(manifest.edits)).toBe(true);
    expect(Object.isFrozen(manifest.edits[0])).toBe(true);
    expect(Object.isFrozen(manifest.contentAssertions)).toBe(true);
    expect(Object.isFrozen(manifest.generation)).toBe(true);
    expect(Object.isFrozen(manifest.generation.libraries)).toBe(true);
  });

  test('does not retain caller-owned nested arrays or records', () => {
    const input = asRecord(validManifest());
    const manifest = parseCommittedPdfManifest(input, 1);
    const inputLanguages = input.languages as string[];
    const inputFonts = input.fonts as UnknownRecord[];
    const inputFont = inputFonts[0];
    const manifestFont = manifest.fonts[0];
    if (!inputFont || !manifestFont) throw new Error('valid test manifest has no font');

    inputLanguages.push('zh-Hans');
    inputFont.inventoryName = 'mutated';

    expect(manifest.languages).toEqual(['en']);
    expect(manifestFont.inventoryName).toBe('Open Sans Bold');
  });

  test.each([
    ['wrong schema', { schemaVersion: 2 }],
    ['wrong suite', { suite: 2 }],
    ['absolute PDF path', { pdf: '/tmp/document.pdf' }],
    ['small lower bound', { sizePolicy: { minimumBytes: 0, maximumBytes: 5_242_879 } }],
    ['large lower bound', { sizePolicy: { minimumBytes: 2, maximumBytes: 5_242_879 } }],
    ['duplicate font', { fonts: [firstFont(), firstFont()] }],
  ])('rejects %s', (_name, patch) => {
    expect(() => parseCommittedPdfManifest(manifestWith(patch), 1)).toThrow(/Suite 1/);
  });

  test('accepts the inclusive small-suite size boundaries', () => {
    expect(parseCommittedPdfManifest(manifestWith({ byteLength: 1 }), 1).sizePolicy)
      .toEqual({ minimumBytes: 1, maximumBytes: 5_242_879 });
    expect(parseCommittedPdfManifest(manifestWith({ suite: 2, byteLength: 5_242_879 }), 2).suite)
      .toBe(2);
  });

  test('accepts the inclusive large-suite size boundaries', () => {
    expect(parseCommittedPdfManifest(suite3With({ byteLength: 9_961_472 }), 3).byteLength)
      .toBe(9_961_472);
    expect(parseCommittedPdfManifest(suite3With({ byteLength: 11_010_048 }), 3).byteLength)
      .toBe(11_010_048);
  });

  test.each([
    ['large suite with small bounds', suite3With({
      sizePolicy: { minimumBytes: 1, maximumBytes: 5_242_879 },
    }), 3],
    ['small suite with large bounds', manifestWith({
      sizePolicy: { minimumBytes: 9_961_472, maximumBytes: 11_010_048 },
    }), 1],
    ['large suite below minimum', suite3With({ byteLength: 9_961_471 }), 3],
    ['large suite above maximum', suite3With({ byteLength: 11_010_049 }), 3],
  ] as const)('rejects %s', (_name, value, suite) => {
    expect(() => parseCommittedPdfManifest(value, suite)).toThrow(/sizePolicy|byteLength/);
  });

  test.each([
    ['unsupported language', ['fr']],
    ['mixed unsupported language', ['en', 'fr']],
    ['duplicate language', ['en', 'en']],
  ])('rejects %s', (_name, languages) => {
    expect(() => parseCommittedPdfManifest(manifestWith({ languages }), 1)).toThrow(/language/);
  });

  test.each([
    ['unsupported reason', { reason: 'reusable' }],
    ['uppercase font hash', { source: {
      kind: 'npm',
      package: '@fontsource/open-sans',
      version: '5.3.0',
      file: 'files/open-sans-latin-700-normal.woff',
      sha256: 'A'.repeat(64),
    } }],
    ['unsupported npm package', { source: {
      kind: 'npm',
      package: '@fontsource/unknown',
      version: '5.3.0',
      file: 'files/unknown.woff',
      sha256: 'a'.repeat(64),
    } }],
    ['absolute npm path', { source: {
      kind: 'npm',
      package: '@fontsource/open-sans',
      version: '5.3.0',
      file: '/tmp/font.woff',
      sha256: 'a'.repeat(64),
    } }],
    ['traversal npm path', { source: {
      kind: 'npm',
      package: '@fontsource/open-sans',
      version: '5.3.0',
      file: 'files/../font.woff',
      sha256: 'a'.repeat(64),
    } }],
    ['backslash npm path', { source: {
      kind: 'npm',
      package: '@fontsource/open-sans',
      version: '5.3.0',
      file: 'files\\open-sans-latin-700-normal.woff',
      sha256: 'a'.repeat(64),
    } }],
    ['wrong committed path', { source: {
      kind: 'committed',
      path: 'tests/fonts/other.ttf',
      version: '1.047',
      sha256: 'a'.repeat(64),
    } }],
    ['wrong committed version', { source: {
      kind: 'committed',
      path: 'tests/fonts/mplus-1c-regular.ttf',
      version: '1.048',
      sha256: 'a'.repeat(64),
    } }],
    ['wrong committed hash', { source: {
      kind: 'committed',
      path: 'tests/fonts/mplus-1c-regular.ttf',
      version: '1.047',
      sha256: 'a'.repeat(64),
    } }],
  ])('rejects %s', (_name, patch) => {
    expect(() => parseCommittedPdfManifest(manifestWith({ fonts: [{
      ...firstFont(),
      ...patch,
    }] }), 1)).toThrow(/font|source|hash/i);
  });

  test('accepts the approved committed M+ source discriminator', () => {
    const manifest = parseCommittedPdfManifest(manifestWith({
      fonts: [{
        ...firstFont(),
        inventoryName: 'M+ 1c regular',
        weight: 400,
        italic: false,
        source: {
          kind: 'committed',
          path: 'tests/fonts/mplus-1c-regular.ttf',
          version: '1.047',
          sha256: APPROVED_MPLUS_SHA256,
        },
        licence: 'M+ permissive font licence',
        fonts2uPage: 'https://fonts2u.com/m-1c-regular.font',
        searchUrl: 'https://fonts2u.com/search.html?q=M%2B+1c+regular',
      }],
      edits: [firstEdit({ fontInventoryName: 'M+ 1c regular' })],
    }), 1);

    expect(manifest.fonts[0]?.source).toEqual({
      kind: 'committed',
      path: 'tests/fonts/mplus-1c-regular.ttf',
      version: '1.047',
      sha256: APPROVED_MPLUS_SHA256,
    });
  });

  test('rejects an unsupported font source discriminator', () => {
    expect(() => parseCommittedPdfManifest(manifestWith({ fonts: [{
      ...firstFont(),
      source: {
        kind: 'system',
        path: '/usr/share/fonts/font.ttf',
        version: 'unknown',
        sha256: 'a'.repeat(64),
      },
    }] }), 1)).toThrow(/kind/);
  });

  test.each([
    ['uppercase top-level hash', 'A'.repeat(64)],
    ['malformed top-level hash', 'not-a-sha256'],
  ])('rejects %s', (_name, sha256) => {
    expect(() => parseCommittedPdfManifest(manifestWith({ sha256 }), 1))
      .toThrow(/sha256/i);
  });

  test('accepts real ISO calendar dates including a leap day', () => {
    const generation = {
      ...asRecord(asRecord(validManifest()).generation),
      createdOn: '2024-02-29',
    };

    expect(parseCommittedPdfManifest(manifestWith({ generation }), 1).generation.createdOn)
      .toBe('2024-02-29');
  });

  test.each(['2026-02-29', '2026-04-31', '2026-00-10', '2026-13-01'])(
    'rejects impossible ISO calendar date %s',
    (createdOn) => {
      const generation = {
        ...asRecord(asRecord(validManifest()).generation),
        createdOn,
      };

      expect(() => parseCommittedPdfManifest(manifestWith({ generation }), 1))
        .toThrow(/generation\.createdOn.*ISO calendar date/);
    },
  );

  test.each([
    ['HTTP face page', { fonts2uPage: 'http://fonts2u.com/open-sans-bold.font' }],
    ['wrong face host', { fonts2uPage: 'https://example.com/open-sans-bold.font' }],
    ['search URL used as face page', {
      fonts2uPage: 'https://fonts2u.com/search.html?q=Open+Sans+Bold',
    }],
    ['HTTP search URL', { searchUrl: 'http://fonts2u.com/search.html?q=Open+Sans+Bold' }],
    ['wrong search path', { searchUrl: 'https://fonts2u.com/open-sans-bold.font' }],
  ])('rejects %s', (_name, patch) => {
    expect(() => parseCommittedPdfManifest(manifestWith({ fonts: [{
      ...firstFont(),
      ...patch,
    }] }), 1)).toThrow(/URL|fonts2u/i);
  });

  test.each([
    ['another approved source', {
      source: {
        kind: 'npm',
        package: '@fontsource/open-sans',
        version: '5.3.0',
        file: 'files/open-sans-latin-400-normal.woff',
        sha256: '8b3c81a3240d7c8cc9877cf5233d97051aa07730947217db840e500470a4d44a',
      },
    }],
    ['wrong weight', { weight: 400 }],
    ['wrong italic flag', { italic: true }],
    ['arbitrary licence', { licence: 'Another non-empty licence' }],
    ['another valid face page', { fonts2uPage: 'https://fonts2u.com/open-sans.font' }],
    ['another valid search query', {
      searchUrl: 'https://fonts2u.com/search.html?q=Open+Sans',
    }],
  ])('rejects Open Sans Bold with %s', (_name, patch) => {
    expect(() => parseCommittedPdfManifest(manifestWith({ fonts: [{
      ...firstFont(),
      ...patch,
    }] }), 1)).toThrow(/Open Sans Bold|approved tuple/);
  });

  test('rejects an approved tuple assigned to another inventory name', () => {
    expect(() => parseCommittedPdfManifest(manifestWith({
      fonts: [{
        ...firstFont(),
        inventoryName: 'Merriweather',
      }],
      edits: [firstEdit({ fontInventoryName: 'Merriweather' })],
    }), 1)).toThrow(/Merriweather|approved tuple/);
  });

  test('rejects duplicate edit sources and undeclared edit fonts', () => {
    expect(() => parseCommittedPdfManifest(manifestWith({ edits: [
      firstEdit({ sourceText: 'same source' }),
      firstEdit({ sourceText: 'same source', replacementText: 'different replacement' }),
    ] }), 1)).toThrow(/edit|source/i);

    expect(() => parseCommittedPdfManifest(manifestWith({ edits: [
      firstEdit({ fontInventoryName: 'Missing face' }),
    ] }), 1)).toThrow(/font/i);
  });

  test.each([
    ['missing English edit', suite3With({ edits: [
      {
        language: 'zh-Hans',
        pageIndex: 1,
        sourceText: '版本：已取消',
        replacementText: '版本：已完成',
        fontInventoryName: 'Open Sans Bold',
        verifyAfterReopen: true,
      },
    ] })],
    ['missing Simplified Chinese edit', suite3With({ edits: [
      {
        language: 'en',
        pageIndex: 0,
        sourceText: 'Release status: Draft',
        replacementText: 'Release status: Ready',
        fontInventoryName: 'Open Sans Bold',
        verifyAfterReopen: true,
      },
    ] })],
  ] as const)('rejects Suite 3 with %s', (_name, value) => {
    expect(() => parseCommittedPdfManifest(value, 3)).toThrow(/Suite 3|language|edit/);
  });

  test('rejects unknown fields in the exact manifest contract', () => {
    expect(() => parseCommittedPdfManifest(manifestWith({ unexpected: true }), 1))
      .toThrow(/unknown|unexpected|field/i);
    expect(() => parseCommittedPdfManifest(manifestWith({ fonts: [{
      ...firstFont(),
      unexpected: true,
    }] }), 1)).toThrow(/unknown|unexpected|field/i);
  });

  test('rejects signature, byte-length, size, and hash mismatches with named errors', () => {
    const manifest = parseCommittedPdfManifest(validManifest(), 1);

    expect(() => verifyCommittedPdfBytes(new TextEncoder().encode('not a PDF document'), manifest))
      .toThrow(/Suite 1.*%PDF-/);
    expect(() => verifyCommittedPdfBytes(PDF_BYTES.subarray(0, PDF_BYTES.length - 1), manifest))
      .toThrow(/Suite 1.*byte length/);
    expect(() => verifyCommittedPdfBytes(new TextEncoder().encode('%PDF-1.7\nchanged!!'), {
      ...manifest,
      byteLength: PDF_BYTES.byteLength,
      sizePolicy: { minimumBytes: 1, maximumBytes: PDF_BYTES.byteLength - 1 },
    })).toThrow(/Suite 1.*size/);
    expect(() => verifyCommittedPdfBytes(new TextEncoder().encode('%PDF-1.7\nchanged!!'), manifest))
      .toThrow(/Suite 1.*SHA-256/);
  });

  test('selects only Suite 1 routinely and all suites only in full mode', () => {
    expect(selectedCommittedPdfSuites(undefined)).toEqual([1]);
    expect(selectedCommittedPdfSuites('routine')).toEqual([1]);
    expect(selectedCommittedPdfSuites('FULL')).toEqual([1]);
    expect(selectedCommittedPdfSuites('full')).toEqual([1, 2, 3]);
  });
});

describe('committed PDF semantic inspection regressions', () => {
  test('rejects the reviewer FileAttachment annotation with a string FS entry', async () => {
    const bytes = await fileAttachmentDocument(PDFString.of('external.txt'));

    await expect(inspectCommittedPdfSemantics(bytes)).resolves.toMatchObject({
      prohibitedFeatures: ['attachments'],
    });
  });

  test('rejects FileAttachment and ordinary file-specification dictionaries', async () => {
    const [annotation, ordinary] = await Promise.all([
      fileAttachmentDocument('dictionary'),
      ordinaryFileSpecificationDocument(),
    ]);

    await expect(inspectCommittedPdfSemantics(annotation)).resolves.toMatchObject({
      prohibitedFeatures: ['attachments'],
    });
    await expect(inspectCommittedPdfSemantics(ordinary)).resolves.toMatchObject({
      prohibitedFeatures: ['attachments'],
    });
  });

  test('rejects a string FS entry without other attachment markers', async () => {
    await expect(inspectCommittedPdfSemantics(
      await stringFileSpecificationEntryDocument(),
    )).resolves.toMatchObject({ prohibitedFeatures: ['attachments'] });
  });

  test('marks a same-sized blank referenced panel as not useful', async () => {
    const bytes = await syntheticImageDocument({
      width: 960,
      height: 960,
      colourSpace: 'DeviceRGB',
      primaryBytes: new Uint8Array(960 * 960 * 3),
    });
    const inspection = await inspectCommittedPdfSemantics(bytes);

    expect(inspection.referencedImages).toHaveLength(1);
    expect(inspection.referencedImages[0]).toMatchObject({
      width: 960,
      height: 960,
      decodedPayloadBytes: 2_764_800,
      uniqueByteCount: 1,
      entropyBitsPerByte: 0,
      isUseful: false,
      auxiliaryImages: [],
    });
  });

  test('rejects an oversized referenced soft-mask payload', async () => {
    const maskWidth = 2_049;
    const maskHeight = 2_048;
    const bytes = await syntheticImageDocument({
      width: 1,
      height: 1,
      colourSpace: 'DeviceRGB',
      primaryBytes: Uint8Array.of(0, 1, 2),
      softMask: {
        width: maskWidth,
        height: maskHeight,
        bytes: new Uint8Array(maskWidth * maskHeight),
      },
    });

    await expect(inspectCommittedPdfSemantics(bytes)).rejects.toThrow(/auxiliary|payload|4 MiB/i);
  });

  test('rejects a cycle through referenced image mask streams', async () => {
    const bytes = await syntheticImageDocument({
      width: 1,
      height: 1,
      colourSpace: 'DeviceRGB',
      primaryBytes: Uint8Array.of(0, 1, 2),
      softMask: {
        width: 1,
        height: 1,
        bytes: Uint8Array.of(255),
      },
      cyclicMask: true,
    });

    await expect(inspectCommittedPdfSemantics(bytes)).rejects.toThrow(/cyclic.*image.*mask/i);
  });

  test('rejects high-entropy RGB samples whose Decode array maps every component to a constant', async () => {
    const highEntropyRgb = Uint8Array.from({ length: 16 * 16 * 3 }, (_value, index) => index % 256);
    const bytes = await syntheticImageDocument({
      width: 16,
      height: 16,
      colourSpace: 'DeviceRGB',
      primaryBytes: highEntropyRgb,
      decode: [0, 0, 0, 0, 0, 0],
    });

    await expect(inspectCommittedPdfSemantics(bytes)).rejects.toThrow(/Decode.*identity/u);
  });

  test.each([
    ['an absent Decode array', undefined],
    ['an explicit identity Decode array', [0, 1, 0, 1, 0, 1] as const],
  ])('accepts useful high-entropy RGB samples with %s', async (_label, decode) => {
    const highEntropyRgb = Uint8Array.from({ length: 16 * 16 * 3 }, (_value, index) => index % 256);
    const bytes = await syntheticImageDocument({
      width: 16,
      height: 16,
      colourSpace: 'DeviceRGB',
      primaryBytes: highEntropyRgb,
      ...(decode === undefined ? {} : { decode }),
    });

    const inspection = await inspectCommittedPdfSemantics(bytes);

    expect(inspection.referencedImages).toHaveLength(1);
    expect(inspection.referencedImages[0]?.isUseful).toBe(true);
  });

  test('reports an exact visible on-page painted PDF-Scrubber QA text mark', async () => {
    const inspection = await inspectCommittedPdfSemantics(await syntheticPdfScrubberMarkDocument());

    expect(inspection.visibleTextMarks).toHaveLength(1);
    expect(inspection.visibleTextMarks[0]).toMatchObject({
      text: QA_MARK_TEXT,
      pageIndex: 0,
      renderingMode: 0,
      fillOpacity: 1,
      strokeOpacity: 1,
    });
    expect(inspection.visibleTextMarks[0]?.bounds.width).toBeGreaterThan(0);
    expect(inspection.visibleTextMarks[0]?.bounds.height).toBeGreaterThan(0);
  });

  test.each([
    ['invisible', 3],
    ['clipping-only', 7],
  ] as const)('does not accept an %s PDF-Scrubber QA text occurrence', async (_name, renderingMode) => {
    const inspection = await inspectCommittedPdfSemantics(
      await syntheticPdfScrubberMarkDocument({ renderingMode }),
    );

    expect(inspection.pageTexts.join('\n')).toContain(QA_MARK_TEXT);
    expect(inspection.visibleTextMarks).toEqual([]);
  });

  test('does not accept an off-page PDF-Scrubber QA text occurrence', async () => {
    const inspection = await inspectCommittedPdfSemantics(
      await syntheticPdfScrubberMarkDocument({ x: 500, y: 500 }),
    );

    expect(inspection.pageTexts.join('\n')).toContain(QA_MARK_TEXT);
    expect(inspection.visibleTextMarks).toEqual([]);
  });

  test('does not accept an opacity-zero PDF-Scrubber QA text occurrence', async () => {
    const inspection = await inspectCommittedPdfSemantics(
      await syntheticPdfScrubberMarkDocument({ opacity: 0 }),
    );

    expect(inspection.pageTexts.join('\n')).toContain(QA_MARK_TEXT);
    expect(inspection.visibleTextMarks).toEqual([]);
  });

  test('does not accept an on-page PDF-Scrubber QA mark inside an active clipping path', async () => {
    const inspection = await inspectCommittedPdfSemantics(
      await syntheticPdfScrubberMarkDocument({ clipping: 'active' }),
    );

    expect(inspection.pageTexts.join('\n')).toContain(QA_MARK_TEXT);
    expect(inspection.visibleTextMarks).toEqual([]);
  });

  test('accepts an on-page PDF-Scrubber QA mark after q/Q restores the default clipping path', async () => {
    const inspection = await inspectCommittedPdfSemantics(
      await syntheticPdfScrubberMarkDocument({ clipping: 'restored' }),
    );

    expect(inspection.visibleTextMarks).toHaveLength(1);
    expect(inspection.visibleTextMarks[0]).toMatchObject({
      renderingMode: 0,
      fillOpacity: 1,
      strokeOpacity: 1,
    });
  });

  test('does not accept the reviewer sequence with an earlier mode-7 text clip', async () => {
    const inspection = await inspectCommittedPdfSemantics(
      await syntheticTextClippedPdfScrubberMarkDocument({
        renderingMode: 7,
        showingOperator: 'Tj',
      }),
    );

    expect(inspection.pageTexts.join('\n')).toContain(`X${QA_MARK_TEXT}`);
    expect(inspection.visibleTextMarks).toEqual([]);
  });

  test('rejects the reviewer candidate inside an unterminated page text object', async () => {
    await expect(inspectCommittedPdfSemantics(
      await syntheticUnterminatedPdfScrubberMarkDocument(),
    )).rejects.toThrow(/page text object.*not terminated/i);
  });

  test.each([
    ['an unbalanced graphics-state stack', ['q'], /page graphics-state stack.*not balanced/i],
    ['a pending clipping path', ['0 0 1 1 re', 'W'], /page clipping path.*not terminated/i],
  ] as const)('rejects a target followed by %s', async (_label, suffix, expectedError) => {
    await expect(inspectCommittedPdfSemantics(
      await syntheticPdfScrubberMarkWithPageSuffix(suffix),
    )).rejects.toThrow(expectedError);
  });

  test('rejects a target inside an unterminated Form text object', async () => {
    await expect(inspectCommittedPdfSemantics(
      await syntheticFormPdfScrubberMarkDocument({ unterminatedText: true }),
    )).rejects.toThrow(/form text object.*not terminated/i);
  });

  test('validates caller operations after capturing a target inside a Form', async () => {
    await expect(inspectCommittedPdfSemantics(
      await syntheticFormPdfScrubberMarkDocument({ pageSuffix: ['0 0 1 1 re', 'W'] }),
    )).rejects.toThrow(/page clipping path.*not terminated/i);
  });

  test.each([
    [4, 'Tj'],
    [5, 'TJ'],
    [6, "'"],
    [7, '"'],
  ] as const)(
    'activates clipping after rendering mode %i text shown with %s',
    async (renderingMode, showingOperator) => {
      const inspection = await inspectCommittedPdfSemantics(
        await syntheticTextClippedPdfScrubberMarkDocument({ renderingMode, showingOperator }),
      );

      expect(inspection.visibleTextMarks).toEqual([]);
    },
  );

  test('accepts the later mode-0 mark when q/Q restores text clipping state', async () => {
    const inspection = await inspectCommittedPdfSemantics(
      await syntheticTextClippedPdfScrubberMarkDocument({
        renderingMode: 7,
        showingOperator: 'Tj',
        restoreWithGraphicsState: true,
      }),
    );

    expect(inspection.visibleTextMarks).toHaveLength(1);
    expect(inspection.visibleTextMarks[0]?.renderingMode).toBe(0);
  });

  test('carries activated text clipping across page content streams', async () => {
    const inspection = await inspectCommittedPdfSemantics(
      await syntheticTextClippedPdfScrubberMarkDocument({
        renderingMode: 4,
        showingOperator: 'TJ',
        splitAcrossPageStreams: true,
      }),
    );

    expect(inspection.pageTexts.join('\n')).toContain(`X${QA_MARK_TEXT}`);
    expect(inspection.visibleTextMarks).toEqual([]);
  });

  test('does not accept raster-only bytes containing the PDF-Scrubber QA literal', async () => {
    const bytes = await syntheticImageDocument({
      width: QA_MARK_TEXT.length,
      height: 1,
      colourSpace: 'DeviceGray',
      primaryBytes: new TextEncoder().encode(QA_MARK_TEXT),
    });
    const inspection = await inspectCommittedPdfSemantics(bytes);

    expect(inspection.visibleTextMarks).toEqual([]);
  });
});

describe('committed PDF suite files', () => {
  test.each([
    [1, ['Open Sans', 'Open Sans Bold', 'Open Sans Italic'], ['en']],
    [2, ['M+ 1c regular'], ['zh-Hans']],
    [3, [
      'M+ 1c regular',
      'Merriweather',
      'Open Sans',
      'Open Sans Bold',
      'Open Sans Italic',
      'Source Code Pro',
    ], ['en', 'zh-Hans']],
  ] as const)('loads and verifies committed Suite %i', (suite, names, languages) => {
    const loaded = loadCommittedPdfSuite(suite);
    expect(loaded.manifest.languages).toEqual(languages);
    expect(loaded.manifest.fonts.map(({ inventoryName }) => inventoryName)).toEqual(names);
    expect(loaded.pdfBytes.byteLength).toBe(loaded.manifest.byteLength);
  });

  test('pins every complete approved font record in the committed manifests', () => {
    const observed = new Map<string, unknown>();
    for (const suite of [1, 2, 3] as const) {
      for (const font of loadCommittedPdfSuite(suite).manifest.fonts) {
        const previous = observed.get(font.inventoryName);
        if (previous !== undefined) expect(font).toEqual(previous);
        observed.set(font.inventoryName, font);
      }
    }

    expect(Object.fromEntries(observed)).toEqual(APPROVED_FONT_RECORDS);
  });

  test.each([1, 2, 3] as const)(
    'finds every pinned Suite %i content assertion in production PDF analysis',
    async (suite) => {
      const loaded = loadCommittedPdfSuite(suite);
      expect(loaded.manifest.contentAssertions).toEqual(APPROVED_CONTENT_ASSERTIONS[suite]);
      const inspection = await inspectSuite(suite);
      const analysedText = inspection.pageTexts.join('\n');

      for (const assertion of APPROVED_CONTENT_ASSERTIONS[suite]) {
        expect(analysedText, assertion).toContain(assertion);
      }
    },
  );

  test('proves Suite 3 editable sizes, vector text mark, and useful referenced images', async () => {
    const inspection = await inspectSuite(3);

    expect(inspection.editableTextSizes).toEqual([8, 12, 18, 24, 36, 48]);
    expect(inspection.visibleTextMarks).toHaveLength(1);
    expect(inspection.visibleTextMarks[0]).toMatchObject({
      text: QA_MARK_TEXT,
      pageIndex: 0,
      renderingMode: 0,
      fillOpacity: 1,
      strokeOpacity: 1,
    });
    expect(inspection.visibleTextMarks[0]?.bounds.width).toBeGreaterThan(0);
    expect(inspection.visibleTextMarks[0]?.bounds.height).toBeGreaterThan(0);
    expect(inspection.referencedImages.map((image) => ({
      width: image.width,
      height: image.height,
      decodedPayloadBytes: image.decodedPayloadBytes,
      decodedContentSha256: image.decodedContentSha256,
      referenceCount: image.referenceCount,
      auxiliaryImages: image.auxiliaryImages.map((auxiliary) => ({
        role: auxiliary.role,
        decodedPayloadBytes: auxiliary.decodedPayloadBytes,
        decodedContentSha256: auxiliary.decodedContentSha256,
      })),
    }))).toEqual([
      {
        width: 960,
        height: 960,
        decodedPayloadBytes: 2_764_800,
        decodedContentSha256: 'e01c83bbe9a7f05e9050143332851fa47a05d1a623e73101fb915c55d061264a',
        referenceCount: 1,
        auxiliaryImages: [{
          role: 'SMask',
          decodedPayloadBytes: 921_600,
          decodedContentSha256: '1bab2d294447474f0a5ff070ff77d62804ae371a38ae82ef78e0d2d5f4f993a4',
        }],
      },
      {
        width: 960,
        height: 960,
        decodedPayloadBytes: 2_764_800,
        decodedContentSha256: 'ae8f3f55995cc82fc977ca83427db15a487a22fc5e8ebae3821432d4e3b5260b',
        referenceCount: 1,
        auxiliaryImages: [{
          role: 'SMask',
          decodedPayloadBytes: 921_600,
          decodedContentSha256: '2e9d8e5b7e916a02786d3daf7f2a0d293f66a68dd2be72decec0de03dd2d0885',
        }],
      },
      {
        width: 640,
        height: 640,
        decodedPayloadBytes: 1_228_800,
        decodedContentSha256: 'd1b9daddb138fd28bee7b9a631e5b8bfdb6548cda2108e59a1e862d7cc2e7212',
        referenceCount: 1,
        auxiliaryImages: [{
          role: 'SMask',
          decodedPayloadBytes: 409_600,
          decodedContentSha256: '407eefca873f49f896c1f0401db82fcb0000524fabb1cddf944d5b4e54e9ae1d',
        }],
      },
    ]);
    for (const image of inspection.referencedImages) {
      expect(image.decodedPayloadBytes).toBeLessThan(4 * 1024 * 1024);
      expect(image.decodedStreamBytes).toBeLessThan(4 * 1024 * 1024);
      expect(image.uniqueByteCount).toBeGreaterThanOrEqual(256);
      expect(image.entropyBitsPerByte).toBeGreaterThan(7.5);
      expect(image.isUseful).toBe(true);
      expect(Object.isFrozen(image)).toBe(true);
      expect(Object.isFrozen(image.auxiliaryImages)).toBe(true);
      for (const auxiliary of image.auxiliaryImages) {
        expect(auxiliary.decodedPayloadBytes).toBeLessThan(4 * 1024 * 1024);
        expect(auxiliary.decodedStreamBytes).toBeLessThan(4 * 1024 * 1024);
        expect(auxiliary.uniqueByteCount).toBeGreaterThanOrEqual(64);
        expect(auxiliary.entropyBitsPerByte).toBeGreaterThan(5.5);
        expect(Object.isFrozen(auxiliary)).toBe(true);
      }
    }
    expect(Object.isFrozen(inspection.visibleTextMarks)).toBe(true);
    expect(Object.isFrozen(inspection.visibleTextMarks[0])).toBe(true);
    expect(Object.isFrozen(inspection.visibleTextMarks[0]?.bounds)).toBe(true);
  });

  test.each([1, 2, 3] as const)(
    'finds no prohibited interactive or encrypted features in Suite %i',
    async (suite) => {
      await expect(inspectSuite(suite)).resolves.toMatchObject({ prohibitedFeatures: [] });
    },
  );

  test('declares the four exact committed edits', () => {
    expect([1, 2, 3].flatMap((suite) => loadCommittedPdfSuite(suite as 1 | 2 | 3).manifest.edits))
      .toEqual([
        {
          language: 'en',
          pageIndex: 0,
          sourceText: 'Approval status: Pending',
          replacementText: 'Approval status: Approved',
          fontInventoryName: 'Open Sans Bold',
          verifyAfterReopen: true,
        },
        {
          language: 'zh-Hans',
          pageIndex: 0,
          sourceText: '文件：等待中',
          replacementText: '文件：已完成',
          fontInventoryName: 'M+ 1c regular',
          verifyAfterReopen: true,
        },
        {
          language: 'en',
          pageIndex: 0,
          sourceText: 'Release status: Draft',
          replacementText: 'Release status: Ready',
          fontInventoryName: 'Open Sans Bold',
          verifyAfterReopen: true,
        },
        {
          language: 'zh-Hans',
          pageIndex: 1,
          sourceText: '版本：已取消',
          replacementText: '版本：已完成',
          fontInventoryName: 'M+ 1c regular',
          verifyAfterReopen: true,
        },
      ]);
  });

  test('resolves and verifies every declared source font', () => {
    for (const suite of [1, 2, 3] as const) {
      for (const font of loadCommittedPdfSuite(suite).manifest.fonts) {
        const expectedPath = font.source.kind === 'npm'
          ? resolve('node_modules', font.source.package, font.source.file)
          : resolve(font.source.path);
        expect(resolveCommittedFontPath(font)).toBe(expectedPath);
      }
    }
  });

  test.each([1, 2, 3] as const)(
    'opens committed Suite %i in the production engine with its exact font inventory',
    async (suite) => {
      const loaded = loadCommittedPdfSuite(suite);
      const store = await ObjectStore.open(loaded.pdfBytes, PROVISIONAL_LIMITS);

      await expect(inspectDocumentFonts(store)).resolves.toEqual(
        loaded.manifest.fonts.map(({ inventoryName, reason }) => ({
          name: inventoryName,
          reason,
        })),
      );

      if (suite === 3) {
        const usage = store.resourceUsage();
        expect(usage.fileBytes).toBe(loaded.pdfBytes.byteLength);
        expect(usage.fileBytes).toBeLessThanOrEqual(PROVISIONAL_LIMITS.maxFileBytes);
        expect(usage.objectCount).toBeLessThanOrEqual(PROVISIONAL_LIMITS.maxObjects);
        expect(usage.maximumNestingDepth).toBeLessThanOrEqual(
          PROVISIONAL_LIMITS.maxNestingDepth,
        );
        expect(usage.peakDecodedStreamBytes).toBeLessThanOrEqual(
          PROVISIONAL_LIMITS.maxDecodedStreamBytes,
        );
      }
    },
  );
});
