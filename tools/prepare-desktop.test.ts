import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  assertEditorTagVersion,
  assertDesktopOutputDirectory,
  createDesktopProvenance,
  prepareDesktopApp,
  validateEditorAssets,
} from './prepare-desktop';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

test('requires a stable editor package version to match the selected release tag', () => {
  expect(assertEditorTagVersion('v1.0.0', '1.0.0')).toBe('1.0.0');
  expect(() => assertEditorTagVersion('v1.0.0', '1.1.0'))
    .toThrow('does not match editor package version');
  expect(() => assertEditorTagVersion('v1.0.0-beta.1', '1.0.0-beta.1'))
    .toThrow('must be a stable MAJOR.MINOR.PATCH version');
  expect(() => assertEditorTagVersion('1.0.0', '1.0.0'))
    .toThrow('must be v<version>');
});

test('records a stable version and both full source revisions', () => {
  expect(createDesktopProvenance({
    editorVersion: '1.0.0',
    editorSha: 'a'.repeat(40),
    packagingSha: 'b'.repeat(40),
  })).toEqual({
    schemaVersion: 1,
    editor: { version: '1.0.0', tag: 'v1.0.0', sha: 'a'.repeat(40) },
    packaging: { sha: 'b'.repeat(40) },
  });
  expect(() => createDesktopProvenance({
    editorVersion: 'v1.0.0',
    editorSha: 'a'.repeat(40),
    packagingSha: 'b'.repeat(40),
  })).toThrow('must be a stable MAJOR.MINOR.PATCH version');
  expect(() => createDesktopProvenance({
    editorVersion: '1.0.0',
    editorSha: 'deadbeef',
    packagingSha: 'b'.repeat(40),
  })).toThrow('full 40-character Git SHA');
});

test('rejects packaging assets without a compiled index.html', async () => {
  const assets = await createTemporaryDirectory();

  await expect(validateEditorAssets(assets)).rejects.toThrow('missing index.html');

  await writeFile(join(assets, 'index.html'), '<!doctype html><html></html>');
  await expect(validateEditorAssets(assets)).resolves.toBeUndefined();

  await writeFile(
    join(assets, 'index.html'),
    '<!doctype html><html><script type="module" src="/assets/app.js"></script></html>',
  );
  await expect(validateEditorAssets(assets)).rejects.toThrow('references missing local asset');
  await mkdir(join(assets, 'assets'));
  await writeFile(join(assets, 'assets', 'app.js'), 'void 0;');
  await expect(validateEditorAssets(assets)).resolves.toBeUndefined();
});

test('does not accept a symlink as the editor asset root', async () => {
  const root = await createTemporaryDirectory();
  const actualAssets = join(root, 'actual-assets');
  const linkedAssets = join(root, 'linked-assets');
  await mkdir(actualAssets);
  await writeFile(join(actualAssets, 'index.html'), '<!doctype html><html></html>');
  await symlink(actualAssets, linkedAssets, 'dir');

  await expect(validateEditorAssets(linkedAssets)).rejects.toThrow('not a regular directory');
});

test('keeps desktop package output beneath artifacts/desktop when parent paths are symlinked', async () => {
  const root = await createTemporaryDirectory();
  const repository = join(root, 'wrapper');
  const outside = join(root, 'outside');
  await mkdir(join(repository, 'artifacts'), { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(repository, 'artifacts', 'desktop'), 'dir');

  await expect(assertDesktopOutputDirectory(
    repository,
    join(repository, 'artifacts', 'desktop', 'prepared'),
  )).rejects.toThrow('not a regular directory');
});

test('stages the selected editor build with the current wrapper and both source SHAs', async () => {
  const root = await createTemporaryDirectory();
  const assets = join(root, 'editor-assets');
  const repository = join(root, 'wrapper');
  const output = join(repository, 'artifacts', 'desktop', 'prepared');
  await Promise.all([
    mkdir(join(assets, 'assets'), { recursive: true }),
    mkdir(join(repository, 'apps', 'desktop', 'runtime'), { recursive: true }),
    mkdir(join(repository, 'apps', 'cli', 'lib'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(assets, 'index.html'), '<!doctype html><script src="/assets/app.js"></script>'),
    writeFile(join(assets, 'assets', 'app.js'), 'void 0;'),
    writeFile(join(repository, 'apps', 'desktop', 'runtime', 'main.cjs'), 'main'),
    writeFile(join(repository, 'apps', 'desktop', 'security-policy.js'), 'policy'),
    writeFile(join(repository, 'apps', 'cli', 'lib', 'server.js'), 'server'),
    writeFile(
      join(repository, 'apps', 'desktop', 'package.json'),
      JSON.stringify({ devDependencies: { electron: '45.1.0' } }),
    ),
  ]);

  const provenance = await prepareDesktopApp({
    editorAssetsPath: assets,
    editorTag: 'v1.0.0',
    editorVersion: '1.0.0',
    editorSha: 'a'.repeat(40),
    packagingSha: 'b'.repeat(40),
    outputDirectory: output,
    repositoryRoot: repository,
  });

  expect(provenance.editor.sha).toBe('a'.repeat(40));
  expect(provenance.packaging.sha).toBe('b'.repeat(40));
  expect(JSON.parse(await readFile(join(output, 'package.json'), 'utf8'))).toMatchObject({
    version: '1.0.0',
    main: 'main.cjs',
    devDependencies: { electron: '45.1.0' },
  });
  await expect(readFile(join(output, 'web', 'assets', 'app.js'), 'utf8')).resolves.toBe('void 0;');
  await expect(readFile(join(output, 'main.cjs'), 'utf8')).resolves.toBe('main');
  await expect(readFile(join(output, 'server.mjs'), 'utf8')).resolves.toBe('server');
  await expect(readFile(join(output, 'provenance.json'), 'utf8'))
    .resolves.toContain('"packaging"');
});

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'pdf-scrubber-desktop-test-'));
  temporaryDirectories.push(path);
  return path;
}
