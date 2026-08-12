import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..');

test('CLI workspace is the only publishable PDF-Scrubber package', async () => {
  const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const cliPackage = JSON.parse(await readFile(resolve(root, 'apps/cli/package.json'), 'utf8'));
  expect(rootPackage.private).toBe(true);
  expect(cliPackage).toMatchObject({
    name: 'pdf-scrubber',
    version: '0.0.1',
    license: 'MIT',
    type: 'module',
    bin: { 'pdf-scrubber': './bin/pdf-scrubber.js' },
    publishConfig: { access: 'public' },
    engines: { node: '24.18.0' },
  });
  expect(cliPackage.private).toBeUndefined();
  expect(cliPackage.files).toEqual(['bin/', 'lib/', 'dist/', 'README.md', 'LICENSE']);
});
