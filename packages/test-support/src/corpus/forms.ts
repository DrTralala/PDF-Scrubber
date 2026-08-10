import { PDFDict, PDFName, type PDFDocument, type PDFRef } from 'pdf-lib';

import {
  addRawTextPage,
  createFixtureDocument,
  saveFixtureDocument,
} from './operators';
import type { CorpusCase } from './types';

async function createForm(
  document: PDFDocument,
  content: string,
  resources: PDFDict,
): Promise<PDFRef> {
  const stream = document.context.stream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, 500, 100],
    Resources: resources,
  });
  return document.context.register(stream);
}

function textFormResources(document: PDFDocument, resources: PDFDict): PDFDict {
  const snapshot = resources.clone(document.context);
  snapshot.set(PDFName.of('XObject'), document.context.obj({}));
  return snapshot;
}

function firstFontName(resources: PDFDict): string {
  const fonts = resources.lookup(PDFName.of('Font'), PDFDict);
  const fontName = fonts?.keys()[0];
  if (!fontName) throw new Error('Fixture page font resource is missing');
  return fontName.toString();
}

async function setPageFormContent(
  document: PDFDocument,
  pageIndex: number,
  formReference: PDFRef,
  prefix = '',
): Promise<void> {
  const page = document.getPage(pageIndex);
  const name = page.node.newXObject('M0Form', formReference).toString();
  const suffix = prefix.trimStart().startsWith('q') ? 'Q\n' : '';
  const stream = document.context.stream(`${prefix}/${name.slice(1)} Do\n${suffix}`);
  page.node.set(PDFName.of('Contents'), document.context.register(stream));
}

export async function buildFormFixture(
  item: CorpusCase,
): Promise<Uint8Array> {
  const document = await createFixtureDocument(item.id);
  const firstPage = await addRawTextPage(
    document,
    'BT\n{FONT} 24 Tf\n72 700 Td\n(placeholder) Tj\nET\n',
  );
  const resources = firstPage.node.Resources();
  if (!resources) throw new Error('Fixture page resources are missing');
  const fontName = firstFontName(resources);

  if (item.id === '16-form-xobject') {
    const form = await createForm(
      document,
      `BT ${fontName} 24 Tf 0 0 Td (Target 16) Tj ET`,
      textFormResources(document, resources),
    );
    await setPageFormContent(document, 0, form, 'q 1 0 0 1 72 700 cm\n');
  }

  if (item.id === '17-nested-form-xobject') {
    const inner = await createForm(
      document,
      `BT ${fontName} 24 Tf 0 0 Td (Target 17) Tj ET`,
      textFormResources(document, resources),
    );
    const outerResources = document.context.obj({
      XObject: { Inner: inner },
    });
    const outer = await createForm(document, '/Inner Do', outerResources);
    await setPageFormContent(document, 0, outer, 'q 1 0 0 1 72 700 cm\n');
  }

  if (item.id === '18-shared-form-xobject') {
    const shared = await createForm(
      document,
      `BT ${fontName} 24 Tf 0 0 Td (Target 18) Tj ET`,
      textFormResources(document, resources),
    );
    await setPageFormContent(document, 0, shared, 'q 1 0 0 1 72 700 cm\n');
    await addRawTextPage(
      document,
      'BT\n{FONT} 24 Tf\n72 700 Td\n(placeholder) Tj\nET\n',
    );
    await setPageFormContent(document, 1, shared, 'q 1 0 0 1 72 500 cm\n');
  }

  return saveFixtureDocument(document);
}
