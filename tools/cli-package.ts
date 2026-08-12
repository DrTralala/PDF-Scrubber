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
    if (file.mode !== undefined && typeof file.mode !== 'number') {
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
    for (const assetPath of referencedAssets(contents)) {
      const packagedPath = `dist${assetPath}`;
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

function referencedAssets(contents: string): readonly string[] {
  const assets = new Set<string>();
  const matcher = /\/assets\/[A-Za-z0-9._~!$&'*+,;=:@%/-]+/g;
  for (const match of contents.matchAll(matcher)) {
    assets.add(match[0]);
  }
  return [...assets];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
