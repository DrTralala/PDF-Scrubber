import { lstatSync } from 'node:fs';
import { basename, extname } from 'node:path';

export type PortableSmokeArguments = Readonly<{ archive: string; fixture: string }>;

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const EXPECTED_ROOT_ENTRIES = ['PDF-Scrubber.exe', 'config', 'settings.json'];
const EXPECTED_LOCALE_PACKS = ['en-gb.pak', 'en-us.pak'];
const REQUIRED_GRAPHICS_ASSETS = [
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'd3dcompiler_47.dll',
  'dxcompiler.dll',
  'vk_swiftshader.dll',
];

export function archiveName(version: string): string {
  if (!STABLE_VERSION.test(version)) {
    throw new Error(`Portable archive version must be a stable MAJOR.MINOR.PATCH value: ${version}`);
  }
  return `PDF-Scrubber-${version}-win-x64-portable.7z`;
}

export function parsePortableSmokeArguments(arguments_: readonly string[]): PortableSmokeArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined || !argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${String(argument)}`);
    }
    const separatorIndex = argument.indexOf('=');
    const name = separatorIndex < 0 ? argument.slice(2) : argument.slice(2, separatorIndex);
    if (name !== 'archive' && name !== 'fixture') throw new Error(`Unknown option: --${name}`);
    const value = separatorIndex < 0 ? arguments_[index + 1] : argument.slice(separatorIndex + 1);
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }
    if (values.has(name)) throw new Error(`Duplicate option: --${name}`);
    values.set(name, value);
    if (separatorIndex < 0) index += 1;
  }

  const archive = values.get('archive');
  if (archive === undefined) throw new Error('Required option is missing: --archive');
  const fixture = values.get('fixture');
  if (fixture === undefined) throw new Error('Required option is missing: --fixture');
  return Object.freeze({ archive, fixture });
}

export function assertPortableArchiveFile(archivePath: string): void {
  if (extname(archivePath).toLowerCase() !== '.7z') {
    throw new Error(`Portable archive must use the .7z extension: ${archivePath}`);
  }
  let details;
  try {
    details = lstatSync(archivePath);
  } catch (error) {
    throw new Error(`Portable archive is missing or unreadable: ${archivePath}`, { cause: error });
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`Portable archive is not a regular file: ${archivePath}`);
  }
}

export function parseSevenZipEntries(listing: string): string[] {
  const lines = listing.split(/\r?\n/);
  const firstEntryLine = lines.findIndex((line) => /^-{10,}\s*$/.test(line));
  if (firstEntryLine < 0) throw new Error('7-Zip did not return a detailed archive listing');

  const entries: string[] = [];
  let currentPath: string | undefined;
  const appendCurrent = () => {
    if (currentPath !== undefined) entries.push(currentPath);
    currentPath = undefined;
  };

  for (const line of lines.slice(firstEntryLine + 1)) {
    if (line.length === 0) {
      appendCurrent();
      continue;
    }
    if (line.startsWith('Path = ')) {
      appendCurrent();
      currentPath = line.slice('Path = '.length);
    }
  }
  appendCurrent();
  if (entries.length === 0) throw new Error('Portable archive contains no entries');
  return entries;
}

export function assertPortableArchivePaths(paths: readonly string[]): void {
  let sawRoot = false;
  for (const archivedPath of paths) {
    const normalized = archivedPath.replaceAll('\\', '/').replace(/\/$/, '');
    if (normalized.length === 0
      || normalized.startsWith('/')
      || /^[A-Za-z]:/.test(normalized)
      || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error(`Portable archive contains an unsafe path: ${archivedPath}`);
    }
    const parts = normalized.split('/');
    if (parts[0] !== 'PDF-Scrubber') {
      throw new Error(`Portable archive must contain a single PDF-Scrubber/ directory: ${archivedPath}`);
    }
    sawRoot ||= parts.length === 1;
  }
  if (!sawRoot) throw new Error('Portable archive is missing its PDF-Scrubber/ directory entry');
}

export function assertPortableRootEntries(entries: readonly string[]): void {
  const sortedEntries = [...entries].sort();
  const expectedEntries = [...EXPECTED_ROOT_ENTRIES].sort();
  if (sortedEntries.length !== expectedEntries.length
    || sortedEntries.some((entry, index) => entry !== expectedEntries[index])) {
    throw new Error(
      `Portable application root must contain exactly ${EXPECTED_ROOT_ENTRIES.join(', ')}; found ${entries.join(', ')}`,
    );
  }
}

export function assertPortableRuntimeEntries(paths: readonly string[]): void {
  const entries = paths.map((path) => path.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase());
  const entrySet = new Set(entries);
  const appNodeModules = 'pdf-scrubber/config/runtime/resources/app/node_modules';
  if (entries.some((path) => path === appNodeModules || path.startsWith(`${appNodeModules}/`))) {
    throw new Error('Portable runtime must not contain resources/app/node_modules.');
  }

  const localePacks = entries
    .filter((path) => path.startsWith('pdf-scrubber/config/runtime/locales/') && path.endsWith('.pak'))
    .map((path) => path.slice(path.lastIndexOf('/') + 1))
    .sort();
  if (localePacks.length !== EXPECTED_LOCALE_PACKS.length
    || localePacks.some((locale, index) => locale !== EXPECTED_LOCALE_PACKS[index])) {
    throw new Error('Portable runtime must contain only the en-US and en-GB locale packs.');
  }

  for (const asset of REQUIRED_GRAPHICS_ASSETS) {
    if (!entrySet.has(`pdf-scrubber/config/runtime/${asset}`)) {
      throw new Error(`Portable runtime is missing its Electron graphics asset: ${asset}`);
    }
  }

  const hasPdfWorker = entries.some((path) => (
    path.startsWith('pdf-scrubber/config/runtime/resources/app/web/assets/')
      && /\/pdf\.worker.*\.mjs$/.test(path)
  ));
  if (!hasPdfWorker) {
    throw new Error('Portable runtime is missing the packaged PDF.js worker module.');
  }
}

export function portableArchiveVersion(archivePath: string): string {
  const archiveFilename = basename(archivePath);
  const match = /^PDF-Scrubber-(.+)-win-x64-portable\.7z$/.exec(archiveFilename);
  if (match?.[1] === undefined || !STABLE_VERSION.test(match[1])) {
    throw new Error(`Unexpected portable archive filename: ${archiveFilename}`);
  }
  return match[1];
}
