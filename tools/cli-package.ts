import { readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';

import { parseAst } from 'vite';

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
  // The package build emits ordinary start tags. Support quoted/unquoted src and
  // href plus srcset candidates, while excluding HTML comments. Entity decoding
  // below covers numeric references and the slash named reference needed to
  // recognise browser-rooted /assets/ URLs.
  for (const tag of htmlStartTags(contents)) {
    for (const attribute of htmlAttributes(tag)) {
      if (attribute.name === 'src' || attribute.name === 'href') {
        addAssetReference(assets, decodeHtmlReferences(attribute.value));
      } else if (attribute.name === 'srcset') {
        for (const candidate of srcsetCandidates(decodeHtmlReferences(attribute.value))) {
          addAssetReference(assets, candidate);
        }
      }
    }
  }
  return [...assets];
}

function cssAssetReferences(contents: string): readonly string[] {
  const assets = new Set<string>();
  scanCssReferences(contents, assets);
  return [...assets];
}

function javascriptAssetReferences(contents: string): readonly string[] {
  const assets = new Set<string>();
  const root = parseAst(contents);
  visitAst(root, (node) => {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      addAssetReference(assets, node.value);
    } else if (
      node.type === 'TemplateLiteral'
      && Array.isArray(node.expressions)
      && node.expressions.length === 0
      && Array.isArray(node.quasis)
    ) {
      const quasi = node.quasis[0];
      if (isRecord(quasi) && isRecord(quasi.value) && typeof quasi.value.cooked === 'string') {
        addAssetReference(assets, quasi.value.cooked);
      }
    }
  });
  return [...assets];
}

function htmlStartTags(contents: string): readonly string[] {
  const tags: string[] = [];
  let index = 0;
  while (index < contents.length) {
    if (contents.startsWith('<!--', index)) {
      const end = contents.indexOf('-->', index + 4);
      index = end === -1 ? contents.length : end + 3;
      continue;
    }
    if (contents[index] !== '<' || contents[index + 1] === '/' || contents[index + 1] === '!') {
      index += 1;
      continue;
    }
    const start = index;
    let quote: string | undefined;
    index += 1;
    while (index < contents.length) {
      const character = contents[index];
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        tags.push(contents.slice(start, index + 1));
        index += 1;
        break;
      }
      index += 1;
    }
  }
  return tags;
}

function htmlAttributes(tag: string): readonly Readonly<{ name: string; value: string }>[] {
  const attributes: Readonly<{ name: string; value: string }>[] = [];
  let index = 1;
  while (index < tag.length && !/[\s>]/.test(tag[index] ?? '')) index += 1;
  while (index < tag.length) {
    while (/\s/.test(tag[index] ?? '')) index += 1;
    if (tag[index] === '>' || tag[index] === '/') break;
    const nameStart = index;
    while (index < tag.length && !/[\s=/>]/.test(tag[index] ?? '')) index += 1;
    const name = tag.slice(nameStart, index).toLowerCase();
    while (/\s/.test(tag[index] ?? '')) index += 1;
    if (tag[index] !== '=') continue;
    index += 1;
    while (/\s/.test(tag[index] ?? '')) index += 1;
    const quote = tag[index];
    let value: string;
    if (quote === '"' || quote === "'") {
      const valueStart = ++index;
      while (index < tag.length && tag[index] !== quote) index += 1;
      value = tag.slice(valueStart, index);
      index += 1;
    } else {
      const valueStart = index;
      while (index < tag.length && !/[\s>]/.test(tag[index] ?? '')) index += 1;
      value = tag.slice(valueStart, index);
    }
    attributes.push({ name, value });
  }
  return attributes;
}

function addAssetReference(assets: Set<string>, decoded: string): void {
  if (!decoded.startsWith('/assets/')) return;
  const pathname = decoded.split(/[?#]/, 1)[0];
  if (pathname !== undefined) assets.add(pathname);
}

function decodeHtmlReferences(value: string): string {
  return value.replace(/&(?:#(\d+);?|#x([0-9a-f]+);?|sol;|sol(?![0-9a-z=]))/gi, (entity, decimal, hexadecimal) => {
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

function validCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function srcsetCandidates(value: string): readonly string[] {
  const candidates: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index] ?? '')) index += 1;
    const start = index;
    while (index < value.length && !/\s/.test(value[index] ?? '')) index += 1;
    if (index > start) {
      const candidate = value.slice(start, index);
      if (candidate.endsWith(',')) {
        candidates.push(candidate.slice(0, -1));
        continue;
      }
      candidates.push(candidate);
    }
    while (index < value.length && value[index] !== ',') index += 1;
    if (value[index] === ',') index += 1;
  }
  return candidates;
}

function scanCssReferences(contents: string, assets: Set<string>): void {
  let index = 0;
  while (index < contents.length) {
    if (contents.startsWith('/*', index)) {
      const end = contents.indexOf('*/', index + 2);
      index = end === -1 ? contents.length : end + 2;
      continue;
    }
    const character = contents[index];
    if (character === '"' || character === "'") {
      index = readCssString(contents, index).end;
      continue;
    }
    if (
      cssTokenStartsAt(contents, index)
      && contents.slice(index, index + 4).toLowerCase() === 'url('
    ) {
      const parsed = readCssUrl(contents, index + 4);
      if (parsed.value !== undefined) addAssetReference(assets, decodeCssEscapes(parsed.value));
      index = parsed.end;
      continue;
    }
    if (
      cssTokenStartsAt(contents, index)
      && contents.slice(index, index + 7).toLowerCase() === '@import'
    ) {
      index += 7;
      while (/\s/.test(contents[index] ?? '')) index += 1;
      const quote = contents[index];
      if (quote === '"' || quote === "'") {
        const parsed = readCssString(contents, index);
        addAssetReference(assets, decodeCssEscapes(parsed.value));
        index = parsed.end;
        continue;
      }
    }
    index += 1;
  }
}

function cssTokenStartsAt(contents: string, index: number): boolean {
  return index === 0 || !/[a-z0-9_-]/i.test(contents[index - 1] ?? '');
}

function readCssString(contents: string, start: number): Readonly<{ end: number; value: string }> {
  const quote = contents[start];
  let value = '';
  let index = start + 1;
  while (index < contents.length) {
    const character = contents[index];
    if (character === '\\' && index + 1 < contents.length) {
      value += character + contents[index + 1];
      index += 2;
    } else if (character === quote) {
      return { end: index + 1, value };
    } else {
      value += character;
      index += 1;
    }
  }
  return { end: index, value };
}

function readCssUrl(
  contents: string,
  start: number,
): Readonly<{ end: number; value?: string }> {
  let index = start;
  while (/\s/.test(contents[index] ?? '')) index += 1;
  const quote = contents[index];
  if (quote === '"' || quote === "'") {
    const parsed = readCssString(contents, index);
    index = parsed.end;
    while (/\s/.test(contents[index] ?? '')) index += 1;
    return { end: contents[index] === ')' ? index + 1 : index, value: parsed.value };
  }
  const valueStart = index;
  while (index < contents.length && contents[index] !== ')') index += 1;
  return { end: index < contents.length ? index + 1 : index, value: contents.slice(valueStart, index).trim() };
}

type AstNode = Readonly<Record<string, unknown> & { type: string }>;

function visitAst(value: unknown, visitor: (node: AstNode) => void): void {
  if (!isRecord(value)) return;
  if (typeof value.type === 'string') visitor(value as AstNode);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'parent') continue;
    if (Array.isArray(child)) {
      for (const item of child) visitAst(item, visitor);
    } else {
      visitAst(child, visitor);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
