import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const packagePath = resolve(import.meta.dirname, '..', 'apps/cli/package.json');

test('publish-facing CLI bin target uses npm canonical relative path', async () => {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    bin?: Record<string, string>;
  };

  expect(packageJson.bin).toEqual({ 'pdf-scrubber': 'bin/pdf-scrubber.js' });
});
