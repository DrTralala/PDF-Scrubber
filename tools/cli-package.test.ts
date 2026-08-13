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
    { report: [{ files: [{ path: 'bin/pdf-scrubber.js', mode: -1 }] }], failure: 'invalid mode' },
    { report: [{ files: [{ path: 'bin/pdf-scrubber.js', mode: 493.5 }] }], failure: 'invalid mode' },
    { report: [{ files: [{ path: 'bin/pdf-scrubber.js', mode: Number.NaN }] }], failure: 'invalid mode' },
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

  test.each([
    {
      name: 'HTML character references',
      file: 'dist/index.html',
      contents: '<script src=\'&#x2f;assets/missing-html.js?cache=1\'></script>',
      missing: 'dist/assets/missing-html.js',
    },
    {
      name: 'CSS escapes',
      file: 'dist/assets/app.css',
      contents: String.raw`@font-face { src: url('\2f assets/missing-css.woff2#font') }`,
      missing: 'dist/assets/missing-css.woff2',
    },
    {
      name: 'JavaScript hexadecimal escapes',
      file: 'dist/assets/app.js',
      contents: String.raw`const worker = '\x2fassets/missing-worker.js';`,
      missing: 'dist/assets/missing-worker.js',
    },
    {
      name: 'JavaScript Unicode escapes in MJS',
      file: 'dist/assets/app.mjs',
      contents: String.raw`const worker = '\u002fassets/missing-module-worker.js';`,
      missing: 'dist/assets/missing-module-worker.js',
    },
  ])('rejects omitted browser-local references encoded with $name', async ({
    file,
    contents,
    missing,
  }) => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': file === 'dist/index.html' ? contents : '',
      [file]: contents,
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      ...(file === 'dist/index.html' ? [] : [file]),
    ])).rejects.toThrow(missing);
  });

  test('handles single-quoted URL literals without including the quote', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '<script src=\'/assets/app.js\'></script>',
      'dist/assets/app.js': "const worker = '/assets/worker.js';",
      'dist/assets/worker.js': 'postMessage("ready")',
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/app.js',
      'dist/assets/worker.js',
    ])).resolves.toBeUndefined();
  });

  test('ignores asset-like text that is not a browser-local URL literal', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '<p>/assets/html-text.js</p>',
      'dist/assets/app.css': '/* url("/assets/comment.css") */',
      'dist/assets/app.js': [
        '// const ignored = "/assets/line-comment.js";',
        '/* const ignored = "/assets/block-comment.js"; */',
        'const notRooted = "prefix/assets/substring.js";',
        'const external = "https://example.test/assets/remote.js";',
      ].join('\n'),
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/app.css',
      'dist/assets/app.js',
    ])).resolves.toBeUndefined();
  });

  test('rejects a local URL literal that normalises outside the assets root', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '<script src="/assets/../outside.js"></script>',
    });

    await expect(assertBuiltAssetClosure(packageRoot, fixedFiles))
      .rejects.toThrow('unsafe built asset reference');
  });

  test.each([
    {
      name: 'semicolonless HTML hexadecimal entity',
      file: 'dist/index.html',
      contents: '<script src="&#x2f&#97;ssets/missing-semicolon.js"></script>',
      missing: 'dist/assets/missing-semicolon.js',
    },
    {
      name: 'HTML srcset candidate',
      file: 'dist/index.html',
      contents: '<img srcset="/assets/first.png 1x, &#47assets/missing-srcset.png 2x">',
      missing: 'dist/assets/missing-srcset.png',
      packaged: ['dist/assets/first.png'],
    },
    {
      name: 'CSS string-form import',
      file: 'dist/assets/app.css',
      contents: '@import "/assets/missing-import.css" screen;',
      missing: 'dist/assets/missing-import.css',
    },
    {
      name: 'static JavaScript template literal',
      file: 'dist/assets/app.js',
      contents: 'const worker = `/assets/missing-template.js`;',
      missing: 'dist/assets/missing-template.js',
    },
  ])('rejects omitted active reference from $name', async ({
    file,
    contents,
    missing,
    packaged = [],
  }) => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': file === 'dist/index.html' ? contents : '',
      [file]: contents,
      ...Object.fromEntries(packaged.map((path) => [path, 'packaged'])),
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      ...(file === 'dist/index.html' ? [] : [file]),
      ...packaged,
    ])).rejects.toThrow(missing);
  });

  test('ignores HTML comments containing active-looking elements', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': [
        '<!-- <script src="/assets/commented-script.js"></script> -->',
        '<!-- <img srcset="/assets/commented-image.png 2x"> -->',
      ].join(''),
    });

    await expect(assertBuiltAssetClosure(packageRoot, fixedFiles)).resolves.toBeUndefined();
  });

  test('does not desynchronise JavaScript scanning on regex or interpolated templates', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '',
      'dist/assets/app.js': [
        String.raw`const expression = /['\"]/g;`,
        'const dynamic = `/assets/${name}.js`;',
        'const worker = "/assets/real-worker.js";',
      ].join('\n'),
      'dist/assets/real-worker.js': 'postMessage("ready")',
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/app.js',
      'dist/assets/real-worker.js',
    ])).resolves.toBeUndefined();
  });

  test('uses JavaScript syntax so regex contexts cannot create asset literals', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '',
      'dist/assets/app.js': [
        String.raw`function matcher() { return /["'\x60]\/assets\/regex-only\.js/; }`,
        "const dynamic = `/assets/${(() => { const braces = \"}\"; return /[{\"']/; })()}.js`;",
        'const worker = "/assets/real-worker.js";',
      ].join('\n'),
      'dist/assets/real-worker.js': 'postMessage("ready")',
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/app.js',
      'dist/assets/real-worker.js',
    ])).resolves.toBeUndefined();
  });

  test('finds a static literal after a return-position regex containing quotes', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '',
      'dist/assets/app.js': [
        String.raw`function matcher() { return /["']/; }`,
        'const missing = "/assets/after-regex.js";',
      ].join('\n'),
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/app.js',
    ])).rejects.toThrow('dist/assets/after-regex.js');
  });

  test('finds a static literal after a complex interpolated template', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '',
      'dist/assets/app.js': [
        "const dynamic = `/assets/${(() => { const braces = \"}\"; return /[{\"']/; })()}.js`;",
        'const missing = "/assets/after-template.js";',
      ].join('\n'),
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/app.js',
    ])).rejects.toThrow('dist/assets/after-template.js');
  });

  test('walks literal nodes inside template expressions but ignores the dynamic template value', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '',
      'dist/assets/app.mjs': [
        'const dynamic = `/assets/${pick("/assets/expression-worker.js")}.js`;',
        'const staticTemplate = `/assets/static-worker.js`;',
      ].join('\n'),
      'dist/assets/expression-worker.js': 'postMessage("expression")',
      'dist/assets/static-worker.js': 'postMessage("static")',
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/app.mjs',
      'dist/assets/expression-worker.js',
      'dist/assets/static-worker.js',
    ])).resolves.toBeUndefined();
  });

  test('checks static string literal nodes nested inside template expressions', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '',
      'dist/assets/app.mjs': 'const dynamic = `/assets/${pick("/assets/expression-missing.js")}.js`;',
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/app.mjs',
    ])).rejects.toThrow('dist/assets/expression-missing.js');
  });

  test('accepts no-whitespace CSS string imports and ignores URL text inside comments and strings', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '',
      'dist/assets/app.css': [
        '@import"/assets/imported.css";',
        '/* @import"/assets/commented.css"; */',
        '.label::before { content: \'url("/assets/string-only.png")\'; }',
        '.hero { background: url("/assets/background.png"); }',
      ].join('\n'),
      'dist/assets/imported.css': '',
      'dist/assets/background.png': 'png',
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/app.css',
      'dist/assets/imported.css',
      'dist/assets/background.png',
    ])).resolves.toBeUndefined();
  });

  test('checks a no-whitespace CSS string import when the asset is omitted', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '',
      'dist/assets/app.css': '@import"/assets/missing-tight-import.css";',
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/app.css',
    ])).rejects.toThrow('dist/assets/missing-tight-import.css');
  });

  test('checks every srcset candidate while preserving commas inside local URLs', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': [
        '<img srcset="/assets/image,wide.png 1x,',
        ' &#47assets/missing-srcset.png 2x">',
      ].join(''),
      'dist/assets/image,wide.png': 'png',
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/image,wide.png',
    ])).rejects.toThrow('dist/assets/missing-srcset.png');
  });

  test('recognises a trailing comma as a srcset separator without a descriptor', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '<img srcset="/assets/first.png, /assets/missing-second.png">',
      'dist/assets/first.png': 'png',
    });

    await expect(assertBuiltAssetClosure(packageRoot, [
      ...fixedFiles,
      'dist/assets/first.png',
    ])).rejects.toThrow('dist/assets/missing-second.png');
  });

  test('does not decode a semicolonless named HTML entity followed by an ASCII letter', async () => {
    const packageRoot = await createPackageRoot({
      'dist/index.html': '<script src="&solassets/not-active.js"></script>',
    });

    await expect(assertBuiltAssetClosure(packageRoot, fixedFiles)).resolves.toBeUndefined();
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
