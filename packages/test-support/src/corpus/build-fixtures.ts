import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { fingerprint } from '@pdf-editor/pdf-engine';

import { buildFormFixture } from './forms';
import { buildHostileFixture } from './hostile';
import { CORPUS } from './manifest';
import {
  buildAddedImageFixture,
  buildNotoTextFixture,
  buildOperatorFixture,
  buildWkhtmltopdfRichLineFixture,
} from './operators';
import { buildPolicyFixture } from './policy';
import type { BuiltCorpusCase, CorpusCase } from './types';

async function generateFixture(item: CorpusCase): Promise<Uint8Array> {
  if (item.classes.includes('wkhtmltopdfRichLine')) {
    return buildWkhtmltopdfRichLineFixture(item);
  }
  if (item.classes.includes('formXObject')) return buildFormFixture(item);
  if (item.classes.includes('nestedFormXObject')) return buildFormFixture(item);
  if (item.classes.includes('sharedFormXObject')) return buildFormFixture(item);
  if (
    item.classes.includes('pdfUaMarker') ||
    item.classes.includes('pdfAMarker') ||
    item.classes.includes('signatureMarker')
  ) {
    return buildPolicyFixture(item);
  }
  if (
    item.classes.includes('encryptionMarker') ||
    item.classes.includes('malformedStream') ||
    item.classes.includes('decompressionAbuse')
  ) {
    return buildHostileFixture(item);
  }
  if (item.classes.includes('addedImageControl')) {
    return buildAddedImageFixture(item);
  }
  if (item.assets.length > 0) return buildNotoTextFixture(item);
  return buildOperatorFixture(item);
}

async function removePreviousGeneratedFiles(
  outputDirectory: string,
): Promise<void> {
  const names = await readdir(outputDirectory);
  await Promise.all(
    names
      .filter((name) => name.endsWith('.pdf') || name === 'manifest.json')
      .map((name) => unlink(resolve(outputDirectory, name))),
  );
}

export async function buildFixtures(outputDirectory: string): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await removePreviousGeneratedFiles(outputDirectory);

  const builtCases: BuiltCorpusCase[] = [];
  for (const item of CORPUS) {
    const bytes = await generateFixture(item);
    await writeFile(resolve(outputDirectory, `${item.id}.pdf`), bytes);
    builtCases.push({ ...item, sha256: await fingerprint(bytes) });
  }

  await writeFile(
    resolve(outputDirectory, 'manifest.json'),
    `${JSON.stringify(builtCases, null, 2)}\n`,
    'utf8',
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  await buildFixtures(resolve('fixtures/generated'));
}
