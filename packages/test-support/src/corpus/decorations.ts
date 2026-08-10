import { PDFDict, PDFName, type PDFDocument, type PDFPage, type PDFRef } from 'pdf-lib';

import {
  addRawTextPage,
  createFixtureDocument,
  saveFixtureDocument,
} from './operators';

export const DECORATION_FIXTURE_KINDS = [
  'stroked-underline',
  'filled-strikethrough',
  'combined',
  'rotated',
  'sheared',
  'table',
  'separator',
  'double-custom',
  'ambiguous-owner',
  'shared-stream',
] as const;

export type DecorationFixtureKind = (typeof DECORATION_FIXTURE_KINDS)[number];

function firstFontName(page: PDFPage): string {
  const resources = page.node.Resources();
  const fonts = resources?.lookup(PDFName.of('Font'), PDFDict);
  const name = fonts?.keys()[0];
  if (name === undefined) throw new Error('Decoration fixture font resource is missing');
  return name.toString();
}

function text(fontName: string, value = 'Decorated text'): string {
  return [
    'BT',
    `${fontName} 24 Tf`,
    '1 0 0 1 72 700 Tm',
    `(${value}) Tj`,
    'ET',
  ].join('\n');
}

function graphics(kind: Exclude<DecorationFixtureKind, 'shared-stream'>): string {
  switch (kind) {
    case 'stroked-underline':
      return 'q\n0 G\n1 w\n72 696 m\n230 696 l\nS\nQ';
    case 'filled-strikethrough':
      return 'q\n0 g\n72 708 158 1.2 re\nf\nQ';
    case 'combined':
      return [
        'q', '0 G', '1 w', '72 696 m', '230 696 l', 'S', 'Q',
        'q', '0 g', '72 708 158 1.2 re', 'f', 'Q',
      ].join('\n');
    case 'rotated':
      return '';
    case 'sheared':
      return '';
    case 'table':
      return 'q\n0 G\n1 w\n60 680 190 45 re\nS\n155 680 m\n155 725 l\nS\nQ';
    case 'separator':
      return 'q\n0 G\n1 w\n40 650 m\n560 650 l\nS\nQ';
    case 'double-custom':
      return 'q\n0 G\n1 w\n[3 2] 0 d\n72 696 m\n230 696 l\nS\n72 692 m\n230 692 l\nS\nQ';
    case 'ambiguous-owner':
      return 'q\n0 G\n1 w\n72 696 m\n230 696 l\nS\nQ';
  }
}

async function setPageContent(
  document: PDFDocument,
  page: PDFPage,
  content: string,
): Promise<void> {
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.stream(`${content}\n`)),
  );
}

function formResources(document: PDFDocument, page: PDFPage): PDFDict {
  const resources = page.node.Resources();
  if (resources === undefined) throw new Error('Decoration fixture resources are missing');
  const snapshot = resources.clone(document.context);
  snapshot.set(PDFName.of('XObject'), document.context.obj({}));
  return snapshot;
}

function createSharedForm(
  document: PDFDocument,
  resources: PDFDict,
  fontName: string,
): PDFRef {
  const content = [
    'q', '0 G', '1 w', '0 -4 m', '158 -4 l', 'S', 'Q',
    'BT', `${fontName} 24 Tf`, '1 0 0 1 0 0 Tm', '(Decorated text) Tj', 'ET',
  ].join('\n');
  return document.context.register(document.context.stream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, -20, 240, 40],
    Resources: resources,
  }));
}

async function useForm(
  document: PDFDocument,
  page: PDFPage,
  form: PDFRef,
  y: number,
): Promise<void> {
  const name = page.node.newXObject('DecorationForm', form).toString();
  await setPageContent(document, page, `q\n1 0 0 1 72 ${y} cm\n${name} Do\nQ`);
}

export async function buildDecorationFixture(
  kind: DecorationFixtureKind,
): Promise<Uint8Array> {
  const document = await createFixtureDocument(`decoration-${kind}`);
  const page = await addRawTextPage(
    document,
    'BT\n{FONT} 24 Tf\n72 700 Td\n(placeholder) Tj\nET\n',
  );
  const fontName = firstFontName(page);

  if (kind === 'shared-stream') {
    const form = createSharedForm(document, formResources(document, page), fontName);
    await useForm(document, page, form, 700);
    const second = await addRawTextPage(
      document,
      'BT\n{FONT} 24 Tf\n72 700 Td\n(placeholder) Tj\nET\n',
    );
    await useForm(document, second, form, 600);
    return saveFixtureDocument(document);
  }

  const shownText = kind === 'ambiguous-owner'
    ? [
        'BT', `${fontName} 24 Tf`, '1 0 0 1 72 700 Tm', '(Left) Tj', 'ET',
        'BT', `${fontName} 24 Tf`, '1 0 0 1 180 700 Tm', '(Right) Tj', 'ET',
      ].join('\n')
    : text(fontName);
  const content = [graphics(kind), shownText].filter(Boolean).join('\n');
  const transformed = kind === 'rotated'
    ? `q\n0 1 -1 0 750 100 cm\n${graphics('stroked-underline')}\n${shownText}\nQ`
    : kind === 'sheared'
      ? `q\n1 0.2 0 1 0 0 cm\n${graphics('filled-strikethrough')}\n${shownText}\nQ`
      : content;
  await setPageContent(document, page, transformed);
  return saveFixtureDocument(document);
}
