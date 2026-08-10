import { PDFName, PDFNumber } from 'pdf-lib';

import {
  addRawTextPage,
  createFixtureDocument,
  saveFixtureDocument,
} from './operators';
import type { CorpusCase } from './types';

function addEncryptionTrailerMarker(bytes: Uint8Array): Uint8Array {
  const source = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  const marked = source.replace(
    /trailer\s*<<(.*?)>>\s*startxref/s,
    'trailer\n<<$1/Encrypt 1 0 R\n>>\n\nstartxref',
  );
  return Uint8Array.from(marked, (character) => character.charCodeAt(0));
}

export async function buildHostileFixture(
  item: CorpusCase,
): Promise<Uint8Array> {
  const document = await createFixtureDocument(item.id);
  const page = await addRawTextPage(
    document,
    `BT\n{FONT} 24 Tf\n72 700 Td\n(${item.targetUnicode}) Tj\nET\n`,
  );

  if (item.id === '27-decompression-abuse') {
    const stream = document.context.flateStream(new Uint8Array([65]), {
      M0DecodedLength: 128 * 1024 * 1024 + 1,
    });
    stream.dict.set(
      PDFName.of('M0DecodedLength'),
      PDFNumber.of(128 * 1024 * 1024 + 1),
    );
    page.node.set(
      PDFName.of('Contents'),
      document.context.register(stream),
    );
  }

  const saved = await saveFixtureDocument(document);
  if (item.id === '25-encryption-marker') {
    return addEncryptionTrailerMarker(saved);
  }
  if (item.id === '26-malformed-stream') {
    const source = Array.from(saved, (byte) => String.fromCharCode(byte)).join('');
    return Uint8Array.from(
      source.replace('endstream', 'endstreaX'),
      (character) => character.charCodeAt(0),
    );
  }
  return saved;
}
