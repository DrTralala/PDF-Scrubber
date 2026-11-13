import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type DesktopProvenance = Readonly<{
  schemaVersion: 1;
  editor: Readonly<{ version: string; tag: string; sha: string }>;
  packaging: Readonly<{ sha: string }>;
}>;

type DesktopSourceInput = Readonly<{
  editorVersion: string;
  editorSha: string;
  packagingSha: string;
}>;

type PrepareDesktopOptions = DesktopSourceInput & Readonly<{
  editorTag: string;
  editorAssetsPath: string;
  outputDirectory: string;
  repositoryRoot?: string;
}>;

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_GIT_SHA = /^[\da-f]{40}$/i;

export function assertEditorTagVersion(tag: string, version: string): string {
  const stableVersion = assertStableVersion(version);
  if (tag !== `v${stableVersion}`) {
    if (!tag.startsWith('v')) {
      throw new Error(`Editor tag must be v<version>; received ${tag}`);
    }
    throw new Error(`Editor tag ${tag} does not match editor package version ${stableVersion}`);
  }
  return stableVersion;
}

export function createDesktopProvenance(input: DesktopSourceInput): DesktopProvenance {
  const version = assertStableVersion(input.editorVersion);
  return Object.freeze({
    schemaVersion: 1,
    editor: Object.freeze({
      version,
      tag: `v${version}`,
      sha: assertFullGitSha(input.editorSha, 'editorSha'),
    }),
    packaging: Object.freeze({ sha: assertFullGitSha(input.packagingSha, 'packagingSha') }),
  });
}

export async function validateEditorAssets(assetsPath: string): Promise<void> {
  const requestedRootStats = await lstat(assetsPath).catch((error: unknown) => {
    throw new Error(`Editor assets directory is unavailable: ${assetsPath}`, { cause: error });
  });
  if (!requestedRootStats.isDirectory() || requestedRootStats.isSymbolicLink()) {
    throw new Error(`Editor assets path is not a regular directory: ${assetsPath}`);
  }
  const assetsRoot = await realpath(assetsPath).catch((error: unknown) => {
    throw new Error(`Editor assets directory is unavailable: ${assetsPath}`, { cause: error });
  });
  const rootStats = await lstat(assetsRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Editor assets path is not a regular directory: ${assetsPath}`);
  }

  const indexPath = resolve(assetsRoot, 'index.html');
  const indexStats = await lstat(indexPath).catch((error: unknown) => {
    if (isFileNotFound(error)) throw new Error(`Editor assets are missing index.html: ${assetsPath}`);
    throw error;
  });
  if (!indexStats.isFile() || indexStats.isSymbolicLink()) {
    throw new Error(`Editor assets are missing index.html: ${assetsPath}`);
  }

  const indexHtml = await readFile(indexPath, 'utf8');
  if (indexHtml.trim().length === 0) {
    throw new Error(`Editor assets contain an empty index.html: ${assetsPath}`);
  }
  await validateAssetTree(assetsRoot);

  for (const match of indexHtml.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
    const reference = match[2];
    if (reference === undefined || reference.startsWith('#')) continue;

    let resolvedUrl: URL;
    try {
      resolvedUrl = new URL(reference, 'http://pdf-scrubber.invalid/');
    } catch (error) {
      throw new Error(`Editor index.html contains an invalid asset reference: ${reference}`, { cause: error });
    }
    if (resolvedUrl.origin !== 'http://pdf-scrubber.invalid' || resolvedUrl.protocol !== 'http:') {
      throw new Error(`Editor index.html contains a non-local asset reference: ${reference}`);
    }

    const rawPath = decodeURIComponent(reference.split(/[?#]/, 1)[0] ?? '');
    if (rawPath.split(/[\\/]/).includes('..')) {
      throw new Error(`Editor index.html contains an unsafe asset reference: ${reference}`);
    }
    const assetPath = resolve(assetsRoot, `.${decodeURIComponent(resolvedUrl.pathname)}`);
    if (!isContained(assetsRoot, assetPath, true)) {
      throw new Error(`Editor index.html contains an unsafe asset reference: ${reference}`);
    }
    const assetStats = await lstat(assetPath).catch((error: unknown) => {
      if (isFileNotFound(error)) {
        throw new Error(`Editor index.html references missing local asset: ${reference}`);
      }
      throw error;
    });
    if (!assetStats.isFile() || assetStats.isSymbolicLink()) {
      throw new Error(`Editor index.html references a non-file local asset: ${reference}`);
    }
    const actualPath = await realpath(assetPath);
    if (!isContained(assetsRoot, actualPath, true)) {
      throw new Error(`Editor index.html references an asset outside its build directory: ${reference}`);
    }
  }
}

export async function assertDesktopOutputDirectory(
  repositoryRoot: string,
  outputDirectory: string,
): Promise<string> {
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const allowedOutputRoot = resolve(canonicalRepositoryRoot, 'artifacts', 'desktop');
  const target = resolve(outputDirectory);
  if (!isContained(allowedOutputRoot, target)) {
    throw new Error(`Desktop preparation output must be under ${allowedOutputRoot}`);
  }

  const outputParent = dirname(target);
  const relativeParent = relative(canonicalRepositoryRoot, outputParent);
  if (relativeParent === '..' || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) {
    throw new Error(`Desktop preparation output parent must be under ${allowedOutputRoot}`);
  }
  let currentDirectory = canonicalRepositoryRoot;
  for (const segment of relativeParent.split(sep).filter(Boolean)) {
    currentDirectory = resolve(currentDirectory, segment);
    let directoryStats;
    try {
      directoryStats = await lstat(currentDirectory);
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
      await mkdir(currentDirectory);
      directoryStats = await lstat(currentDirectory);
    }
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new Error(`Desktop preparation output parent is not a regular directory: ${currentDirectory}`);
    }
  }
  return resolve(currentDirectory, basename(target));
}

export async function prepareDesktopApp(options: PrepareDesktopOptions): Promise<DesktopProvenance> {
  const provenance = createDesktopProvenance(options);
  assertEditorTagVersion(options.editorTag, provenance.editor.version);
  await validateEditorAssets(options.editorAssetsPath);

  const repositoryRoot = resolve(
    options.repositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  );
  const outputDirectory = await assertDesktopOutputDirectory(repositoryRoot, options.outputDirectory);

  const desktopPackagePath = resolve(repositoryRoot, 'apps/desktop/package.json');
  const runtimeMainPath = resolve(repositoryRoot, 'apps/desktop/runtime/main.cjs');
  const runtimeStoragePath = resolve(repositoryRoot, 'apps/desktop/runtime/portable-storage.cjs');
  const smokeDiagnosticsPath = resolve(repositoryRoot, 'apps/desktop/runtime/smoke-diagnostics.cjs');
  const securityPolicyPath = resolve(repositoryRoot, 'apps/desktop/security-policy.js');
  const staticServerPath = resolve(repositoryRoot, 'apps/cli/lib/server.js');
  const [desktopPackageText] = await Promise.all([
    readFile(desktopPackagePath, 'utf8'),
    requireRegularFile(runtimeMainPath),
    requireRegularFile(runtimeStoragePath),
    requireRegularFile(smokeDiagnosticsPath),
    requireRegularFile(securityPolicyPath),
    requireRegularFile(staticServerPath),
  ]);
  const desktopPackage = JSON.parse(desktopPackageText) as {
    devDependencies?: Record<string, string>;
  };
  const electronVersion = desktopPackage.devDependencies?.electron;
  if (electronVersion === undefined) {
    throw new Error('Desktop workspace must pin Electron as a development dependency');
  }

  let outputCreated = false;
  try {
    await mkdir(outputDirectory);
    outputCreated = true;
    await cp(await realpath(options.editorAssetsPath), resolve(outputDirectory, 'web'), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    await Promise.all([
      copyFile(runtimeMainPath, resolve(outputDirectory, 'main.cjs')),
      copyFile(runtimeStoragePath, resolve(outputDirectory, 'portable-storage.cjs')),
      copyFile(smokeDiagnosticsPath, resolve(outputDirectory, 'smoke-diagnostics.cjs')),
      copyFile(securityPolicyPath, resolve(outputDirectory, 'security-policy.js')),
      copyFile(staticServerPath, resolve(outputDirectory, 'server.mjs')),
      writeFile(
        resolve(outputDirectory, 'provenance.json'),
        `${JSON.stringify(provenance, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      ),
      writeFile(
        resolve(outputDirectory, 'package.json'),
        `${JSON.stringify({
          name: 'pdf-scrubber-desktop-app',
          productName: 'PDF-Scrubber',
          version: provenance.editor.version,
          private: true,
          type: 'module',
          main: 'main.cjs',
          devDependencies: { electron: electronVersion },
        }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      ),
    ]);
  } catch (error) {
    if (outputCreated) {
      await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }

  return provenance;
}

function assertStableVersion(value: string): string {
  if (!STABLE_VERSION.test(value)) {
    throw new Error(`Editor version must be a stable MAJOR.MINOR.PATCH version: ${value}`);
  }
  return value;
}

function assertFullGitSha(value: string, name: string): string {
  if (!FULL_GIT_SHA.test(value)) {
    throw new Error(`${name} must be a full 40-character Git SHA`);
  }
  return value.toLowerCase();
}

async function validateAssetTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await validateAssetTree(entryPath);
    } else if (!entry.isFile()) {
      throw new Error(`Editor assets contain a non-regular file: ${entryPath}`);
    }
  }
}

async function requireRegularFile(path: string): Promise<void> {
  const fileStats = await lstat(path);
  if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
    throw new Error(`Required desktop packaging file is not a regular file: ${path}`);
  }
}

function isContained(root: string, candidate: string, allowRoot = false): boolean {
  const pathFromRoot = relative(root, candidate);
  if (allowRoot && pathFromRoot === '') return true;
  return pathFromRoot !== ''
    && pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function parseArguments(arguments_: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined || !argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${String(argument)}`);
    }
    const separatorIndex = argument.indexOf('=');
    const name = separatorIndex < 0 ? argument.slice(2) : argument.slice(2, separatorIndex);
    const value = separatorIndex < 0 ? arguments_[index + 1] : argument.slice(separatorIndex + 1);
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }
    if (values.has(name)) throw new Error(`Duplicate option: --${name}`);
    values.set(name, value);
    if (separatorIndex < 0) index += 1;
  }
  return values;
}

function requiredOption(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined) throw new Error(`Required option is missing: --${name}`);
  return value;
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const allowedOptions = new Set([
    'editor-assets',
    'editor-tag',
    'editor-version',
    'editor-sha',
    'packaging-sha',
    'output',
  ]);
  for (const name of values.keys()) {
    if (!allowedOptions.has(name)) throw new Error(`Unknown option: --${name}`);
  }

  const provenance = await prepareDesktopApp({
    editorAssetsPath: resolve(process.cwd(), requiredOption(values, 'editor-assets')),
    editorTag: requiredOption(values, 'editor-tag'),
    editorVersion: requiredOption(values, 'editor-version'),
    editorSha: requiredOption(values, 'editor-sha'),
    packagingSha: requiredOption(values, 'packaging-sha'),
    outputDirectory: resolve(process.cwd(), requiredOption(values, 'output')),
  });
  process.stdout.write(`${JSON.stringify(provenance)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
