import { readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';

const FIXED_FILES = Object.freeze([
  'LICENSE',
  'README.md',
  'bin/pdf-scrubber.js',
  'lib/arguments.js',
  'lib/run.js',
  'lib/server.js',
  'package.json',
  'dist/index.html',
]);

type PackageFile = Readonly<{
  path: string;
  size?: number;
  mode?: number;
}>;

type PackageReportEntry = Readonly<{
  id?: string;
  name?: string;
  version?: string;
  files: readonly PackageFile[];
}>;

export function packageReportEntry(report: unknown): PackageReportEntry {
  if (!Array.isArray(report) || report.length !== 1) {
    throw new Error('npm package report must contain exactly one entry');
  }

  const entry: unknown = report[0];
  if (!isRecord(entry) || !Array.isArray(entry.files)) {
    throw new Error('npm package report entry must contain a files array');
  }

  for (const file of entry.files) {
    if (!isRecord(file) || typeof file.path !== 'string') {
      throw new Error('npm package report contains an invalid file path');
    }
    if (
      file.mode !== undefined
      && (
        typeof file.mode !== 'number'
        || !Number.isSafeInteger(file.mode)
        || file.mode < 0
      )
    ) {
      throw new Error(`npm package report contains an invalid mode for ${file.path}`);
    }
  }

  return entry as PackageReportEntry;
}

export function packageFilesFromReport(report: unknown): readonly string[] {
  return Object.freeze(packageReportEntry(report).files.map((file) => file.path));
}

export function assertCliPackageFiles(paths: readonly string[]): void {
  const uniquePaths = new Set(paths);
  if (uniquePaths.size !== paths.length) {
    throw new Error('CLI package report contains a duplicate path');
  }

  for (const requiredPath of FIXED_FILES) {
    if (!uniquePaths.has(requiredPath)) {
      throw new Error(`CLI package is missing required file: ${requiredPath}`);
    }
  }

  for (const path of paths) {
    if (posix.normalize(path) !== path || path.startsWith('/')) {
      throw new Error(`CLI package contains an invalid path: ${path}`);
    }
    if (!FIXED_FILES.includes(path) && !isAssetPath(path)) {
      throw new Error(`CLI package contains unapproved file: ${path}`);
    }
  }
}

export async function assertBuiltAssetClosure(
  packageRoot: string,
  paths: readonly string[],
): Promise<void> {
  const packagedPaths = new Set(paths);
  const textPaths = paths.filter((path) => (
    path === 'dist/index.html' || /^dist\/assets\/.*\.(?:css|js|mjs)$/.test(path)
  ));

  for (const path of textPaths) {
    const contents = await readFile(resolve(packageRoot, path), 'utf8');
    for (const assetPath of referencedAssets(path, contents)) {
      const packagedPath = `dist${assetPath}`;
      if (
        !isAssetPath(packagedPath)
        || posix.normalize(packagedPath) !== packagedPath
      ) {
        throw new Error(`unsafe built asset reference: ${assetPath}`);
      }
      if (!packagedPaths.has(packagedPath)) {
        throw new Error(`Built asset reference is missing from package: ${packagedPath}`);
      }
    }
  }
}

function isAssetPath(path: string): boolean {
  return path.startsWith('dist/assets/')
    && path.length > 'dist/assets/'.length
    && !path.includes('\\');
}

function referencedAssets(path: string, contents: string): readonly string[] {
  if (path.endsWith('.html')) return htmlAssetReferences(contents);
  if (path.endsWith('.css')) return cssAssetReferences(contents);
  return javascriptAssetReferences(contents);
}

function htmlAssetReferences(contents: string): readonly string[] {
  const assets = new Set<string>();
  const attribute = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of contents.matchAll(attribute)) {
    addAssetReference(assets, decodeHtmlReferences(match[1] ?? match[2] ?? match[3] ?? ''));
  }
  return [...assets];
}

function cssAssetReferences(contents: string): readonly string[] {
  const assets = new Set<string>();
  const withoutComments = contents.replace(/\/\*[\s\S]*?\*\//g, '');
  const url = /url\(\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s)]*))\s*\)/gi;
  for (const match of withoutComments.matchAll(url)) {
    addAssetReference(assets, decodeCssEscapes(match[1] ?? match[2] ?? match[3] ?? ''));
  }
  return [...assets];
}

function javascriptAssetReferences(contents: string): readonly string[] {
  const assets = new Set<string>();
  const literals = javascriptStringLiterals(contents);
  for (const literal of literals) {
    addAssetReference(assets, decodeJavascriptEscapes(literal));
  }
  return [...assets];
}

function javascriptStringLiterals(contents: string): readonly string[] {
  const literals: string[] = [];
  let index = 0;
  while (index < contents.length) {
    const character = contents[index];
    const next = contents[index + 1];
    if (character === '/' && next === '/') {
      index = contents.indexOf('\n', index + 2);
      if (index === -1) break;
      continue;
    }
    if (character === '/' && next === '*') {
      index = contents.indexOf('*/', index + 2);
      if (index === -1) break;
      index += 2;
      continue;
    }
    if (character !== '"' && character !== "'") {
      index += 1;
      continue;
    }

    const quote = character;
    let value = '';
    index += 1;
    while (index < contents.length) {
      const current = contents[index];
      if (current === '\\' && index + 1 < contents.length) {
        value += current + contents[index + 1];
        index += 2;
      } else if (current === quote) {
        index += 1;
        literals.push(value);
        break;
      } else if (current === '\n' || current === '\r') {
        index += 1;
        break;
      } else {
        value += current;
        index += 1;
      }
    }
  }
  return literals;
}

function addAssetReference(assets: Set<string>, decoded: string): void {
  if (!decoded.startsWith('/assets/')) return;
  const pathname = decoded.split(/[?#]/, 1)[0];
  if (pathname !== undefined) assets.add(pathname);
}

function decodeHtmlReferences(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(?:sol));/gi, (entity, decimal, hexadecimal) => {
    const point = decimal === undefined
      ? hexadecimal === undefined ? 0x2f : Number.parseInt(hexadecimal, 16)
      : Number.parseInt(decimal, 10);
    return validCodePoint(point) ? String.fromCodePoint(point) : entity;
  });
}

function decodeCssEscapes(value: string): string {
  return value.replace(/\\(?:([0-9a-f]{1,6})\s?|([^\r\n0-9a-f]))/gi, (escape, hexadecimal, character) => {
    if (hexadecimal === undefined) return character ?? escape;
    const point = Number.parseInt(hexadecimal, 16);
    return validCodePoint(point) ? String.fromCodePoint(point) : '\uFFFD';
  });
}

function decodeJavascriptEscapes(value: string): string {
  return value.replace(
    /\\(?:x([0-9a-f]{2})|u([0-9a-f]{4})|u\{([0-9a-f]{1,6})\}|([^\r\n]))/gi,
    (escape, hexadecimal, unicode, codePoint, character) => {
      const encoded = hexadecimal ?? unicode ?? codePoint;
      if (encoded === undefined) return character ?? escape;
      const point = Number.parseInt(encoded, 16);
      return validCodePoint(point) ? String.fromCodePoint(point) : '\uFFFD';
    },
  );
}

function validCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
