import { PDFBool, PDFName, PDFString } from 'pdf-lib';

import {
  addRawTextPage,
  createFixtureDocument,
  saveFixtureDocument,
} from './operators';
import type { CorpusCase } from './types';

export async function buildPolicyFixture(
  item: CorpusCase,
): Promise<Uint8Array> {
  const document = await createFixtureDocument(item.id);
  await addRawTextPage(
    document,
    `BT\n{FONT} 24 Tf\n72 700 Td\n(${item.targetUnicode}) Tj\nET\n`,
  );

  if (item.id === '22-tagged-pdfua-marker') {
    document.catalog.set(
      PDFName.of('MarkInfo'),
      document.context.obj({ Marked: PDFBool.True }),
    );
    document.catalog.set(PDFName.of('Lang'), PDFString.of('en-GB'));
    document.catalog.set(
      PDFName.of('StructTreeRoot'),
      document.context.obj({ Type: 'StructTreeRoot', K: [] }),
    );
  }

  if (item.id === '23-pdfa-marker') {
    const metadata = document.context.stream(
      '<?xpacket begin="﻿"?>\n' +
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
        '<rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2" pdfaid:conformance="B"/>' +
        '</rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>',
      { Type: 'Metadata', Subtype: 'XML' },
    );
    document.catalog.set(
      PDFName.of('Metadata'),
      document.context.register(metadata),
    );
  }

  if (item.id === '24-signature-marker') {
    const signatureField = document.context.obj({
      FT: 'Sig',
      T: PDFString.of('M0SignatureMarker'),
      Ff: 0,
    });
    document.catalog.set(
      PDFName.of('AcroForm'),
      document.context.obj({ SigFlags: 3, Fields: [signatureField] }),
    );
  }

  return saveFixtureDocument(document);
}
