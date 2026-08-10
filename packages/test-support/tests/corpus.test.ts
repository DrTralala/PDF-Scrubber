import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analysePage, ObjectStore, PROVISIONAL_LIMITS } from '@pdf-editor/pdf-engine';
import { PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CORPUS,
  MANDATORY_CLASSES,
  buildFixtures,
  type BuiltCorpusCase,
} from '../src/index';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-editor-corpus-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('M0 synthetic corpus', () => {
  it('defines a sanitised wkhtmltopdf rich-line regression fixture', () => {
    expect(CORPUS.find(({ id }) => id === '30-wkhtmltopdf-rich-line')).toMatchObject({
      classes: ['wkhtmltopdfRichLine'],
      eligibleText: {
        sourceGlyphCount: 50,
        groups: [
          { text: 'Shopee', styleRunCount: 1, replacementRuns: ['Store'] },
          { text: 'Customer Name:', styleRunCount: 1, replacementRuns: ['Account Name:'] },
          { text: 'Alex Morgan', styleRunCount: 1, replacementRuns: ['Alex Moreno'] },
          {
            text: 'this is a bold text',
            styleRunCount: 3,
            replacementRuns: ['this is a ', 'firm', ' text'],
          },
        ],
        excludedGraphicCount: 1,
      },
    });
  });

  it('contains every mandatory M0 class without duplicate ids', () => {
    expect(CORPUS).toHaveLength(30);
    expect(new Set(CORPUS.map((item) => item.id)).size).toBe(30);
    for (const required of MANDATORY_CLASSES) {
      expect(
        CORPUS.some((item) => item.classes.includes(required)),
        required,
      ).toBe(true);
    }
  });

  it('locks ids and expected baseline outcomes', () => {
    expect(
      CORPUS.map(({ id, expected }) => [id, expected]),
    ).toEqual(JSON.parse(`
      [
        ["01-simple-tj", {"capability": "safeReplacement", "kind": "capability"}],
        ["02-kerned-tj-array", {"capability": "safeReplacement", "kind": "capability"}],
        ["03-single-quote", {"capability": "safeReplacement", "kind": "capability"}],
        ["04-double-quote", {"capability": "safeReplacement", "kind": "capability"}],
        ["05-spacing-rise-scale", {"capability": "safeReplacement", "kind": "capability"}],
        ["06-subset-font", {"capability": "replacementWithSubstitution", "kind": "capability"}],
        ["07-ligature", {"capability": "replacementWithSubstitution", "kind": "capability"}],
        ["08-combining-marks", {"capability": "replacementWithSubstitution", "kind": "capability"}],
        ["09-bidirectional", {"capability": "replacementWithSubstitution", "kind": "capability"}],
        ["10-vertical-writing", {"capability": "readOnly", "kind": "capability", "reason": "unsupportedEncoding"}],
        ["11-rotate-90", {"capability": "safeReplacement", "kind": "capability"}],
        ["12-rotate-180", {"capability": "safeReplacement", "kind": "capability"}],
        ["13-rotate-270", {"capability": "safeReplacement", "kind": "capability"}],
        ["14-crop-nonzero-origin", {"capability": "safeReplacement", "kind": "capability"}],
        ["15-user-unit", {"capability": "safeReplacement", "kind": "capability"}],
        ["16-form-xobject", {"capability": "safeReplacement", "kind": "capability"}],
        ["17-nested-form-xobject", {"capability": "safeReplacement", "kind": "capability"}],
        ["18-shared-form-xobject", {"capability": "readOnly", "kind": "capability", "reason": "sharedResource"}],
        ["19-custom-encoding", {"capability": "replacementWithSubstitution", "kind": "capability"}],
        ["20-missing-tounicode", {"capability": "replacementWithSubstitution", "kind": "capability"}],
        ["21-incorrect-tounicode", {"capability": "replacementWithSubstitution", "kind": "capability"}],
        ["22-tagged-pdfua-marker", {"capability": "safeReplacement", "kind": "capability"}],
        ["23-pdfa-marker", {"capability": "safeReplacement", "kind": "capability"}],
        ["24-signature-marker", {"capability": "safeReplacement", "kind": "capability"}],
        ["25-encryption-marker", {"error": "UNSUPPORTED_DOCUMENT", "kind": "rejected"}],
        ["26-malformed-stream", {"error": "MALFORMED_INPUT", "kind": "rejected"}],
        ["27-decompression-abuse", {"error": "RESOURCE_LIMIT", "kind": "rejected"}],
        ["28-added-text-control", {"kind": "crossConsumerControl"}],
        ["29-added-image-control", {"kind": "crossConsumerControl"}],
        ["30-wkhtmltopdf-rich-line", {"capability": "replacementWithSubstitution", "kind": "capability"}]
      ]
    `));
  });

  it(
    'builds 30 byte-reproducible PDFs and a hashed manifest',
    async () => {
      const firstDirectory = await temporaryDirectory();
      const secondDirectory = await temporaryDirectory();

      await buildFixtures(firstDirectory);
      await buildFixtures(secondDirectory);

      const firstFiles = (await readdir(firstDirectory)).sort();
      const secondFiles = (await readdir(secondDirectory)).sort();
      expect(firstFiles).toEqual(secondFiles);
      expect(firstFiles.filter((name) => name.endsWith('.pdf'))).toHaveLength(
        30,
      );

      for (const file of firstFiles) {
        expect(await readFile(join(firstDirectory, file))).toEqual(
          await readFile(join(secondDirectory, file)),
        );
      }

      const manifest = JSON.parse(
        await readFile(join(firstDirectory, 'manifest.json'), 'utf8'),
      ) as BuiltCorpusCase[];
      expect(manifest).toHaveLength(30);
      for (const item of manifest) {
        expect(item.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(item.source).toBe('synthetic');
        expect(item.generatorVersion).toBe(1);
        expect(item.targetUnicode.length).toBeGreaterThan(0);
        expect(item.replacementUnicode.length).toBeGreaterThan(0);
      }
    },
    15_000,
  );

  it('emits the four text-showing operator forms directly', async () => {
    const directory = await temporaryDirectory();
    await buildFixtures(directory);

    const simple = await readFile(join(directory, '01-simple-tj.pdf'), 'latin1');
    const array = await readFile(
      join(directory, '02-kerned-tj-array.pdf'),
      'latin1',
    );
    const singleQuote = await readFile(
      join(directory, '03-single-quote.pdf'),
      'latin1',
    );
    const doubleQuote = await readFile(
      join(directory, '04-double-quote.pdf'),
      'latin1',
    );

    expect(simple).toContain('(Target 01) Tj');
    expect(array).toContain('[(Tar) 40 (get 02)] TJ');
    expect(singleQuote).toContain("(Target 03) '");
    expect(doubleQuote).toContain('0 0 (Target 04) "');
  });

  it('emits the wkhtmltopdf regression structure without personal data', async () => {
    const directory = await temporaryDirectory();
    await buildFixtures(directory);

    const richLine = await readFile(
      join(directory, '30-wkhtmltopdf-rich-line.pdf'),
      'latin1',
    );

    expect(richLine).toContain(
      '0.750000000 0 0 -0.750000000 28.5000000 656.750000 cm',
    );
    expect(richLine).toContain('beginbfrange');
    expect(richLine).toMatch(/<([0-9A-F]{4})> <\1> \[<[0-9A-F]{4}>\]/);
    expect(richLine.match(/<[0-9A-F]{4}> Tj/g)).toHaveLength(50);
    expect(richLine.match(/0 0 18 18 re/g)).toHaveLength(1);
    expect(richLine).not.toContain('Trevor');
  });

  it('records local font provenance and disclosure expectations', () => {
    const fontCases = CORPUS.filter((item) => item.assets.length > 0);
    expect(fontCases.length).toBeGreaterThan(0);
    for (const item of fontCases) {
      expect(item.assets).toHaveLength(1);
      expect(item.assets[0]).toMatchObject({ version: '5.3.0', licence: 'OFL-1.1' });
    }
    expect(CORPUS.find(({ id }) => id === '09-bidirectional')?.assets).toEqual([{
      package: '@fontsource/noto-sans-arabic',
      version: '5.3.0',
      licence: 'OFL-1.1',
    }]);
    expect(CORPUS.find(({ id }) => id === '22-tagged-pdfua-marker'))
      .toHaveProperty('expectedDisclosureCodes', ['PDF_UA']);
    expect(CORPUS.find(({ id }) => id === '23-pdfa-marker'))
      .toHaveProperty('expectedDisclosureCodes', ['PDF_A']);
    expect(CORPUS.find(({ id }) => id === '24-signature-marker'))
      .toHaveProperty('expectedDisclosureCodes', ['SIGNATURE']);
  });

  it('emits an actual vertical Type0 encoding that classifies read-only', async () => {
    const directory = await temporaryDirectory();
    await buildFixtures(directory);
    const bytes = new Uint8Array(await readFile(join(directory, '10-vertical-writing.pdf')));
    const page = await analysePage(await ObjectStore.open(bytes, PROVISIONAL_LIMITS), 0);

    expect(page.spans[0]?.resource.writingMode).toBe(1);
    expect(page.spans[0]?.capability).toEqual({
      kind: 'readOnly',
      reasons: ['unsupportedEncoding'],
    });
  }, 15_000);

  it(
    'emits encryption evidence and non-cyclic Form resources',
    async () => {
      const directory = await temporaryDirectory();
      await buildFixtures(directory);

      const encryption = await readFile(
        join(directory, '25-encryption-marker.pdf'),
        'latin1',
      );
      expect(encryption).toMatch(/\/Encrypt\s+1\s+0\s+R/);

      const nestedBytes = await readFile(
        join(directory, '17-nested-form-xobject.pdf'),
      );
      const document = await PDFDocument.load(nestedBytes, {
        updateMetadata: false,
      });
      const pageResources = document.getPage(0).node.Resources();
      const pageXObjects = pageResources?.lookup(PDFName.of('XObject'), PDFDict);
      const outerName = pageXObjects?.keys()[0];
      const outerReference =
        outerName === undefined ? undefined : pageXObjects?.get(outerName);
      expect(outerReference).toBeInstanceOf(PDFRef);
      const outer = document.context.lookup(outerReference, PDFStream);
      const outerXObjects = outer.dict
        .lookup(PDFName.of('Resources'), PDFDict)
        .lookup(PDFName.of('XObject'), PDFDict);
      const innerReference = outerXObjects.get(PDFName.of('Inner'));
      expect(innerReference).toBeInstanceOf(PDFRef);
      const inner = document.context.lookup(innerReference, PDFStream);
      const innerXObjects = inner.dict
        .lookupMaybe(PDFName.of('Resources'), PDFDict)
        ?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      expect(innerXObjects?.values()).not.toContainEqual(outerReference);
    },
    15_000,
  );
});
