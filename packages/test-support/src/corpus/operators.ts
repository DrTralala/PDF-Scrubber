import { readFile } from 'node:fs/promises';

import fontkit from '@pdf-lib/fontkit';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFFont,
  StandardFonts,
  degrees,
  type PDFPage,
} from 'pdf-lib';
import { PNG } from 'pngjs';

import type { CorpusCase } from './types';

const FIXED_DATE = new Date('2000-01-01T00:00:00.000Z');
const NOTO_LATIN_URL = new URL(
  '../../../../node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff',
  import.meta.url,
);
const NOTO_ARABIC_URL = new URL(
  '../../../../node_modules/@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff',
  import.meta.url,
);
const NOTO_LATIN_BOLD_URL = new URL(
  '../../../../node_modules/@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff',
  import.meta.url,
);

export async function createFixtureDocument(
  fixtureId: string,
): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  document.setTitle(`M0 fixture ${fixtureId}`);
  document.setAuthor('PDF Editor M0');
  document.setSubject('Deterministic synthetic feasibility fixture');
  document.setKeywords(['pdf-editor', 'm0', 'synthetic']);
  document.setCreator('pdf-editor-m0-generator/1');
  document.setProducer('pdf-editor-m0-generator/1');
  document.setCreationDate(FIXED_DATE);
  document.setModificationDate(FIXED_DATE);
  return document;
}

export async function saveFixtureDocument(
  document: PDFDocument,
): Promise<Uint8Array> {
  return document.save({
    addDefaultPage: false,
    useObjectStreams: false,
    updateFieldAppearances: false,
  });
}

export async function addRawTextPage(
  document: PDFDocument,
  content: string,
): Promise<PDFPage> {
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontName = page.node.newFontDictionary('M0Font', font.ref).toString();
  await font.embed();
  const bytes = new TextEncoder().encode(
    content.replaceAll('{FONT}', fontName),
  );
  const streamReference = document.context.register(document.context.stream(bytes));
  page.node.set(PDFName.of('Contents'), streamReference);
  return page;
}

function rawOperatorContent(item: CorpusCase): string {
  switch (item.id) {
    case '01-simple-tj':
      return 'BT\n{FONT} 24 Tf\n72 700 Td\n(Target 01) Tj\nET\n';
    case '02-kerned-tj-array':
      return 'BT\n{FONT} 24 Tf\n72 700 Td\n[(Tar) 40 (get 02)] TJ\nET\n';
    case '03-single-quote':
      return "BT\n{FONT} 24 Tf\n72 700 Td\n24 TL\n(Target 03) '\nET\n";
    case '04-double-quote':
      return 'BT\n{FONT} 24 Tf\n72 700 Td\n24 TL\n0 0 (Target 04) "\nET\n';
    case '05-spacing-rise-scale':
      return 'BT\n{FONT} 24 Tf\n2 Tc\n4 Tw\n6 Ts\n90 Tz\n72 700 Td\n(Target 05) Tj\nET\n';
    default:
      return `BT\n{FONT} 24 Tf\n72 700 Td\n(${item.targetUnicode}) Tj\nET\n`;
  }
}

function toUnicodeCMap(text: string, incorrect: boolean): string {
  const sourceCodes = [...new Set(new TextEncoder().encode(text))].sort((left, right) => left - right);
  const mappings = sourceCodes.map((code) => {
    const source = code.toString(16).padStart(2, '0').toUpperCase();
    const destination = (incorrect ? 0x58 : code).toString(16).padStart(4, '0').toUpperCase();
    return `<${source}> <${destination}>`;
  });
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    `${mappings.length} beginbfchar`,
    ...mappings,
    'endbfchar',
    'endcmap',
    'end',
    'end',
  ].join('\n');
}

function utf16Hex(text: string): string {
  const units: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    units.push(text.charCodeAt(index).toString(16).padStart(4, '0').toUpperCase());
  }
  return units.join('');
}

function arrayRangeToUnicodeCMap(mappings: ReadonlyMap<string, string>): string {
  const entries = [...mappings.entries()].sort(([left], [right]) =>
    left.localeCompare(right));
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    `${entries.length} beginbfrange`,
    ...entries.map(([source, unicode]) =>
      `<${source}> <${source}> [<${utf16Hex(unicode)}>]`),
    'endbfrange',
    'endcmap',
    'end',
    'end',
  ].join('\n');
}

function encodedCode(font: PDFFont, character: string): string {
  return font.encodeText(character).toString().slice(1, -1).toUpperCase();
}

type RichFixtureFont = Readonly<{
  font: PDFFont;
  resourceName: string;
  mappings: Map<string, string>;
}>;

function appendGlyphLine(
  operations: string[],
  runs: readonly Readonly<{ text: string; font: RichFixtureFont }>[],
  x: number,
  y: number,
  size: number,
): void {
  operations.push('BT');
  operations.push(`1 0 0 -1 ${x} ${y} Tm`);
  let activeFont = '';
  for (const run of runs) {
    if (activeFont !== run.font.resourceName) {
      activeFont = run.font.resourceName;
      operations.push(`${activeFont} ${size} Tf`);
    }
    for (const character of run.text) {
      const code = encodedCode(run.font.font, character);
      run.font.mappings.set(code, character);
      operations.push(`<${code}> Tj`);
      operations.push(
        `${run.font.font.widthOfTextAtSize(character, size).toFixed(6)} 0 Td`,
      );
    }
  }
  operations.push('ET');
}

async function installArrayToUnicode(
  document: PDFDocument,
  fixtureFont: RichFixtureFont,
): Promise<void> {
  await fixtureFont.font.embed();
  const dictionary = document.context.lookup(fixtureFont.font.ref, PDFDict);
  dictionary.set(
    PDFName.of('ToUnicode'),
    document.context.register(
      document.context.stream(arrayRangeToUnicodeCMap(fixtureFont.mappings)),
    ),
  );
}

export async function buildWkhtmltopdfRichLineFixture(
  item: CorpusCase,
): Promise<Uint8Array> {
  const document = await createFixtureDocument(item.id);
  document.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([
    readFile(NOTO_LATIN_URL),
    readFile(NOTO_LATIN_BOLD_URL),
  ]);
  const display: RichFixtureFont = {
    font: await document.embedFont(regularBytes, { subset: false }),
    resourceName: '',
    mappings: new Map(),
  };
  const regular: RichFixtureFont = {
    font: await document.embedFont(regularBytes, { subset: false }),
    resourceName: '',
    mappings: new Map(),
  };
  const bold: RichFixtureFont = {
    font: await document.embedFont(boldBytes, { subset: false }),
    resourceName: '',
    mappings: new Map(),
  };
  const page = document.addPage([612, 792]);
  const fonts = [display, regular, bold].map((entry, index) => ({
    ...entry,
    resourceName: page.node
      .newFontDictionary(`WK${index}`, entry.font.ref)
      .toString(),
  }));
  const [displayFont, regularFont, boldFont] = fonts;
  if (displayFont === undefined || regularFont === undefined || boldFont === undefined) {
    throw new Error('The rich-line fixture requires three fonts');
  }

  const operations = [
    '0.750000000 0 0 -0.750000000 28.5000000 656.750000 cm',
    'q',
    '0.95 0.25 0.08 rg',
    '0 0 18 18 re',
    'f',
    'Q',
  ];
  appendGlyphLine(operations, [{ text: 'Shopee', font: displayFont }], 28, 30, 20);
  appendGlyphLine(
    operations,
    [{ text: 'Customer Name:', font: boldFont }],
    28,
    72,
    14,
  );
  appendGlyphLine(
    operations,
    [{ text: 'Alex Morgan', font: regularFont }],
    180,
    72,
    14,
  );
  appendGlyphLine(
    operations,
    [
      { text: 'this is a ', font: regularFont },
      { text: 'bold', font: boldFont },
      { text: ' text', font: regularFont },
    ],
    28,
    110,
    14,
  );

  const stream = document.context.register(
    document.context.stream(new TextEncoder().encode(`${operations.join('\n')}\n`)),
  );
  page.node.set(PDFName.of('Contents'), stream);
  await Promise.all(fonts.map((entry) => installArrayToUnicode(document, entry)));
  return saveFixtureDocument(document);
}

function configureEncodingFixture(
  document: PDFDocument,
  page: PDFPage,
  item: CorpusCase,
): void {
  const resources = page.node.Resources();
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const fontValue = fonts?.entries()[0]?.[1];
  const resolvedFont = fontValue === undefined ? undefined : document.context.lookup(fontValue);
  if (!(resolvedFont instanceof PDFDict)) {
    throw new Error(`${item.id} lacks its generated font dictionary`);
  }

  resolvedFont.set(PDFName.of('BaseFont'), PDFName.of(`M0PrivateFont${item.id.slice(0, 2)}`));
  resolvedFont.set(PDFName.of('FirstChar'), PDFNumber.of(0));
  resolvedFont.set(PDFName.of('LastChar'), PDFNumber.of(255));
  resolvedFont.set(
    PDFName.of('Widths'),
    document.context.obj(Array.from({ length: 256 }, () => 600)),
  );
  resolvedFont.set(
    PDFName.of('Encoding'),
    document.context.obj({
      Type: 'Encoding',
      BaseEncoding: 'WinAnsiEncoding',
      Differences: [65, 'A'],
    }),
  );

  if (item.id !== '20-missing-tounicode') {
    const map = document.context.stream(
      toUnicodeCMap(item.targetUnicode, item.id === '21-incorrect-tounicode'),
    );
    resolvedFont.set(PDFName.of('ToUnicode'), document.context.register(map));
  }
}

export async function buildOperatorFixture(
  item: CorpusCase,
): Promise<Uint8Array> {
  const document = await createFixtureDocument(item.id);
  const page = await addRawTextPage(document, rawOperatorContent(item));

  if (item.id === '11-rotate-90') page.setRotation(degrees(90));
  if (item.id === '12-rotate-180') page.setRotation(degrees(180));
  if (item.id === '13-rotate-270') page.setRotation(degrees(270));
  if (item.id === '14-crop-nonzero-origin') {
    page.setMediaBox(20, 30, 612, 792);
    page.setCropBox(40, 50, 532, 692);
  }
  if (item.id === '15-user-unit') {
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  }
  if (
    item.id === '19-custom-encoding' ||
    item.id === '20-missing-tounicode' ||
    item.id === '21-incorrect-tounicode'
  ) {
    configureEncodingFixture(document, page, item);
  }

  return saveFixtureDocument(document);
}

export async function buildNotoTextFixture(
  item: CorpusCase,
): Promise<Uint8Array> {
  const document = await createFixtureDocument(item.id);
  document.registerFontkit(fontkit);
  const fontBytes = await readFile(
    item.id === '09-bidirectional' ? NOTO_ARABIC_URL : NOTO_LATIN_URL,
  );
  const font = await document.embedFont(fontBytes, {
    subset: item.id === '06-subset-font',
  });
  const page = document.addPage([612, 792]);
  page.drawText(item.targetUnicode, {
    x: 72,
    y: 700,
    size: 24,
    font,
  });
  if (item.id === '10-vertical-writing') {
    await font.embed();
    const fonts = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    const fontReference = fonts?.entries()[0]?.[1];
    const fontDictionary = fontReference === undefined
      ? undefined
      : document.context.lookup(fontReference);
    if (!(fontDictionary instanceof PDFDict)) {
      throw new Error('Vertical fixture lacks its Type0 font dictionary');
    }
    fontDictionary.set(PDFName.of('Encoding'), PDFName.of('Identity-V'));
  }
  return saveFixtureDocument(document);
}

export async function buildAddedImageFixture(
  item: CorpusCase,
): Promise<Uint8Array> {
  const document = await createFixtureDocument(item.id);
  const image = new PNG({ width: 16, height: 16 });
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const offset = (y * 16 + x) * 4;
      image.data[offset] = x * 16;
      image.data[offset + 1] = y * 16;
      image.data[offset + 2] = 128;
      image.data[offset + 3] = 255;
    }
  }
  const embedded = await document.embedPng(PNG.sync.write(image));
  const page = document.addPage([612, 792]);
  page.drawImage(embedded, { x: 72, y: 680, width: 64, height: 64 });
  return saveFixtureDocument(document);
}
