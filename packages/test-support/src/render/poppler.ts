import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { XMLParser } from 'fast-xml-parser';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { PNG } from 'pngjs';

import {
  canonicalPageSize,
  canonicalToPdf,
  multiply,
  pdfToCanonical,
  transformPoint,
  type CanonicalBounds,
  type Matrix,
  type PageSpace,
} from '@pdf-editor/pdf-engine';
import type { ExtractedTextItem } from '../diff/extraction';
import type { RgbaImage } from '../diff/images';

export type PopplerCommandEvidence = Readonly<{
  executable: 'pdftotext' | 'pdftoppm';
  args: readonly string[];
}>;

export type PopplerValidationEvidence = Readonly<{
  consumer: 'poppler';
  extraction: readonly ExtractedTextItem[];
  image: RgbaImage;
  pageWidth: number;
  pageHeight: number;
  commands: readonly PopplerCommandEvidence[];
}>;

function run(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], { maxBuffer: 16 * 1024 * 1024 }, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

function array<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value as readonly T[] : [value as T];
}

type XmlWord = Readonly<{
  '#text'?: string;
  xMin?: number;
  yMin?: number;
  xMax?: number;
  yMax?: number;
}>;

type XmlLine = Readonly<{ word?: XmlWord | readonly XmlWord[] }>;
type XmlBlock = Readonly<{ line?: XmlLine | readonly XmlLine[] }>;
type XmlFlow = Readonly<{ block?: XmlBlock | readonly XmlBlock[] }>;
type XmlPage = Readonly<{
  width?: number;
  height?: number;
  flow?: XmlFlow | readonly XmlFlow[];
}>;

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Poppler bbox XML has invalid ${label}`);
  }
  return value;
}

function transformBounds(
  bounds: CanonicalBounds,
  page: PageSpace,
): CanonicalBounds {
  const mediaOnly: PageSpace = {
    mediaBox: page.mediaBox,
    rotate: page.rotate,
    userUnit: page.userUnit,
  };
  const mediaWidth = page.mediaBox[2] - page.mediaBox[0];
  const mediaHeight = page.mediaBox[3] - page.mediaBox[1];
  const rotation = ((page.rotate % 360) + 360) % 360;
  const rotationShift = rotation === 90 || rotation === 270
    ? Math.abs(mediaHeight - mediaWidth) * page.userUnit
    : 0;
  const popplerToMediaCanonical: Matrix = Object.freeze([
    page.userUnit, 0, 0, page.userUnit, 0, -rotationShift,
  ]);
  const popplerToCanonical = multiply(
    pdfToCanonical(page),
    multiply(canonicalToPdf(mediaOnly), popplerToMediaCanonical),
  );
  const corners = [
    transformPoint(popplerToCanonical, bounds.x, bounds.y),
    transformPoint(popplerToCanonical, bounds.x + bounds.width, bounds.y),
    transformPoint(popplerToCanonical, bounds.x, bounds.y + bounds.height),
    transformPoint(
      popplerToCanonical,
      bounds.x + bounds.width,
      bounds.y + bounds.height,
    ),
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return Object.freeze({
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  });
}

function parseExtraction(xml: string, pageIndex: number, pageSpace: PageSpace): Readonly<{
  items: readonly ExtractedTextItem[];
  width: number;
  height: number;
}> {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: true,
    parseTagValue: false,
    trimValues: false,
  }).parse(xml) as { html?: { body?: { doc?: { page?: XmlPage | readonly XmlPage[] } } } };
  const page = array(parsed.html?.body?.doc?.page)[0];
  if (page === undefined) throw new Error('Poppler bbox XML did not contain a page');
  const width = finite(page.width, 'page width');
  const height = finite(page.height, 'page height');
  const items: ExtractedTextItem[] = [];
  for (const flow of array(page.flow)) {
    for (const block of array(flow.block)) {
      for (const line of array(block.line)) {
        const words = array(line.word);
        if (words.length === 0) continue;
        const xMinimum = Math.min(...words.map((word) => finite(word.xMin, 'word xMin')));
        const yMinimum = Math.min(...words.map((word) => finite(word.yMin, 'word yMin')));
        const xMaximum = Math.max(...words.map((word) => finite(word.xMax, 'word xMax')));
        const yMaximum = Math.max(...words.map((word) => finite(word.yMax, 'word yMax')));
        items.push(Object.freeze({
          text: words.map((word) => word['#text'] ?? '').join(' '),
          pageIndex,
          bounds: transformBounds(Object.freeze({
            x: xMinimum,
            y: height - yMaximum,
            width: xMaximum - xMinimum,
            height: yMaximum - yMinimum,
          }), pageSpace),
        }));
      }
    }
  }
  return Object.freeze({ items: Object.freeze(items), width, height });
}

export async function collectPopplerEvidence(
  bytes: Uint8Array,
  pageIndex: number,
): Promise<PopplerValidationEvidence> {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    throw new Error('Poppler page index must be a non-negative safe integer');
  }
  const directory = await mkdtemp(join(tmpdir(), 'pdf-editor-validation-'));
  const inputPath = join(directory, 'document.pdf');
  const xmlPath = join(directory, 'text.xml');
  const imagePrefix = join(directory, 'page');
  const imagePath = `${imagePrefix}.png`;
  const pageNumber = String(pageIndex + 1);
  const textArgs = Object.freeze([
    '-bbox-layout', '-f', pageNumber, '-l', pageNumber, inputPath, xmlPath,
  ]);
  const renderArgs = Object.freeze([
    '-png', '-cropbox', '-r', '144', '-f', pageNumber, '-l', pageNumber, '-singlefile', inputPath, imagePrefix,
  ]);
  try {
    await writeFile(inputPath, bytes);
    await run('pdftotext', textArgs);
    await run('pdftoppm', renderArgs);
    const [xml, pngBytes] = await Promise.all([
      readFile(xmlPath, 'utf8'),
      readFile(imagePath),
    ]);
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    const pdfPage = document.getPage(pageIndex);
    const media = pdfPage.getMediaBox();
    const crop = pdfPage.getCropBox();
    const pageSpace: PageSpace = {
      mediaBox: [media.x, media.y, media.x + media.width, media.y + media.height],
      cropBox: [crop.x, crop.y, crop.x + crop.width, crop.y + crop.height],
      rotate: pdfPage.getRotation().angle,
      userUnit: pdfPage.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber)?.asNumber() ?? 1,
    };
    const extraction = parseExtraction(xml, pageIndex, pageSpace);
    const png = PNG.sync.read(pngBytes);
    const [pageWidth, pageHeight] = canonicalPageSize(pageSpace);
    return Object.freeze({
      consumer: 'poppler',
      extraction: extraction.items,
      image: Object.freeze({
        width: png.width,
        height: png.height,
        rgba: new Uint8Array(png.data),
      }),
      pageWidth,
      pageHeight,
      commands: Object.freeze([
        Object.freeze({ executable: 'pdftotext', args: textArgs }),
        Object.freeze({ executable: 'pdftoppm', args: renderArgs }),
      ]),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
