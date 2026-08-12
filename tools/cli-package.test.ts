import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  assertBuiltAssetClosure,
  assertCliPackageFiles,
  packageFilesFromReport,
} from './cli-package';

const fixedFiles = [
  'LICENSE',
  'README.md',
  'bin/pdf-scrubber.js',
  'lib/arguments.js',
  'lib/run.js',
  'lib/server.js',
  'package.json',
  'dist/index.html',
] as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

describe('packageFilesFromReport', () => {
  test('extracts file paths from one complete npm package report', () => {
    expect(packageFilesFromReport([{
      id: 'pdf-scrubber@0.0.1',
      name: 'pdf-scrubber',
      version: '0.0.1',
      files: [
        { path: 'LICENSE', size: 1, mode: 0o644 },
        { path: 'bin/pdf-scrubber.js', size: 1, mode: 0o755 },
      ],
    }])).toEqual(['LICENSE', 'bin/pdf-scrubber.js']);
  });

  test.each([
    { report: [], failure: 'exactly one entry' },
    { report: [{ files: [] }, { files: [] }], failure: 'exactly one entry' },
    { report: [{ files: [{ path: 42 }] }], failure: 'file path' },
  ])('rejects malformed npm report: $failure', ({ report, failure }) => {
    expect(() => packageFilesFromReport(report)).toThrow(failure);
  });
});

describe('assertCliPackageFiles', () => {
  test('accepts exactly the fixed package files plus dist assets', () => {
    expect(() => assertCliPackageFiles([
      ...fixedFiles,
      'dist/assets/index-a1b2c3.js',
      'dist/assets/fonts/body-a1b2c3.woff2',
    ])).not.toThrow();
  });

  test.each([
    { paths: fixedFiles.filter((path) => path !== 'LICENSE'), failure: 'LICENSE' },
    { paths: [...fixedFiles, 'src/index.ts'], failure: 'src/index.ts' },
    { paths: [...fixedFiles, 'tests/package.test.ts'], failure: 'tests/package.test.ts' },
    { paths: [...fixedFiles, 'fixtures/sample.pdf'], failure: 'fixtures/sample.pdf' },
    { paths: [...fixedFiles, '.opencode/skills/private.md'], failure: '.opencode' },
    { paths: [...fixedFiles, 'package-lock.json'], failure: 'package-lock.json' },
    { paths: [...fixedFiles, 'docs/second-top-level.md'], failure: 'docs/' },
    { paths: [...fixedFiles, 'dist/manifest.json'], failure: 'dist/manifest.json' },
    { paths: [...fixedFiles, 'dist/assets/../secret.js'], failure: 'dist/assets/../secret.js' },
    { paths: [...fixedFiles, '/dist/assets/rooted.js'], failure: '/dist/assets/rooted.js' },
    { paths: [...fixedFiles, 'dist/assets\\windows.js'], failure: 'dist/assets\\windows.js' },
    { paths: [...fixedFiles, 'LICENSE'], failure: 'duplicate' },
  ])('rejects a missing or unapproved package path: $failure', ({ paths, failure }) => {
    expect(() => assertCliPackageFiles(paths)).toThrow(failure);
  });
});

describe('assertBuiltAssetClosure', () => {
  test('accepts local asset references from HTML, CSS, and JavaScript when packaged', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '<script src="/assets/app.js"></script><link href="/assets/app.css">',
      'dist/assets/app.css': '@font-face { src: url("/assets/font.woff2?#iefix") }',
      'dist/assets/app.js': 'const worker = new URL("/assets/worker.js", import.meta.url)',
      'dist/assets/font.woff2': 'font',
      'dist/assets/worker.js': 'postMessage("ready")',
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/app.css',
      'dist/assets/app.js',
      'dist/assets/font.woff2',
      'dist/assets/worker.js',
    ])).resolves.toBeUndefined();
  });

  test('rejects an asset referenced by built JavaScript but omitted from the report', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '<script src="/assets/app.js"></script>',
      'dist/assets/app.js': 'const worker = "/assets/missing-worker.js"',
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/app.js',
    ])).rejects.toThrow('dist/assets/missing-worker.js');
  });
});

async function createPackageRoot(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pdf-scrubber-package-test-'));
  temporaryDirectories.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const output = join(root, path);
    await mkdir(join(output, '..'), { recursive: true });
    await writeFile(output, contents);
  }
  return root;
}
