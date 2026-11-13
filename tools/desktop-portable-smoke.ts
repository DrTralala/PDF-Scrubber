import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { expect } from '@playwright/test';

import {
  archiveName,
  assertPortableArchiveFile,
  assertPortableArchivePaths,
  assertPortableProvenance,
  assertPortableRootEntries,
  parsePortableSmokeArguments,
  parseSevenZipEntries,
  portableArchiveVersion,
} from './desktop-portable-archive';
import { runPortableLifecycle } from './desktop-portable-lifecycle';

const execFileAsync = promisify(execFile);

export { connectElectronBrowser, drainDiagnosticReaders } from './desktop-portable-session';

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Portable archive lifecycle smoke testing must run on Windows');
  }
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== 'Windows') {
    throw new Error('Portable archive lifecycle smoke requires a Windows GitHub Actions runner for bounded diagnostics.');
  }

  const options = parsePortableSmokeArguments(process.argv.slice(2));
  const archive = resolve(options.archive);
  const fixture = resolve(options.fixture);
  assertPortableArchiveFile(archive);
  const fixtureStats = await stat(fixture);
  if (!fixtureStats.isFile()) throw new Error(`Smoke fixture is not a file: ${fixture}`);

  await smokePortableArchive(archive, fixture);
  process.stdout.write('Portable Windows archive lifecycle smoke passed.\n');
}

export async function smokePortableArchive(archive: string, fixture: string): Promise<void> {
  assertPortableArchiveFile(archive);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'pdf-scrubber-desktop-smoke-'));
  try {
    const sevenZip = await findSevenZip();
    const listing = await execFileAsync(sevenZip, ['l', '-slt', archive], {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    const archivePaths = parseSevenZipEntries(listing.stdout);
    assertPortableArchivePaths(archivePaths);

    const extractionDirectory = join(temporaryRoot, 'extracted');
    await mkdir(extractionDirectory);
    await execFileAsync(sevenZip, ['x', '-t7z', '-y', `-o${extractionDirectory}`, archive], {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });

    const applicationRoot = join(extractionDirectory, 'PDF-Scrubber');
    const rootStats = await lstat(applicationRoot);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new Error('Archive did not extract its single regular PDF-Scrubber/ directory.');
    }
    await assertNoReparseTree(applicationRoot);
    assertPortableRootEntries(await readdir(applicationRoot));
    if (archiveName(portableArchiveVersion(archive)) !== basename(archive)) {
      throw new Error('Portable archive filename does not match the required stable naming contract.');
    }

    const configDirectory = join(applicationRoot, 'config');
    const runtimeExecutable = join(configDirectory, 'runtime', 'PDF-Scrubber.exe');
    const launcherExecutable = join(applicationRoot, 'PDF-Scrubber.exe');
    const settingsPath = join(applicationRoot, 'settings.json');
    const embeddedProvenancePath = join(configDirectory, 'provenance.json');
    const sidecarProvenancePath = join(dirname(archive), 'provenance.json');
    for (const requiredPath of [
      launcherExecutable,
      runtimeExecutable,
      settingsPath,
      embeddedProvenancePath,
      sidecarProvenancePath,
    ]) {
      const details = await stat(requiredPath);
      if (!details.isFile()) throw new Error(`Portable archive contract file is not a file: ${requiredPath}`);
    }

    const [embeddedProvenance, sidecarProvenance, initialSettings] = await Promise.all([
      readJsonFile(embeddedProvenancePath),
      readJsonFile(sidecarProvenancePath),
      readJsonFile(settingsPath),
    ]);
    assertPortableProvenance(embeddedProvenance, sidecarProvenance, basename(archive));
    expect(initialSettings).toEqual({
      schemaVersion: 1,
      window: { width: 1280, height: 860 },
    });

    await runPortableLifecycle({
      archive,
      temporaryRoot,
      applicationRoot,
      fixture,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function findSevenZip(): Promise<string> {
  const candidates = [process.env.PDF_SCRUBBER_7Z, '7z.exe', '7z']
    .filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['i'], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
      return candidate;
    } catch {
      // Try the next already-installed command name; this smoke never installs tooling.
    }
  }
  throw new Error('Could not find the existing 7-Zip command used to build the portable archive.');
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function assertNoReparseTree(directory: string): Promise<void> {
  const visit = async (current: string): Promise<void> => {
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      throw new Error(`Portable archive contains a reparse point: ${current}`);
    }
    if (!details.isDirectory()) return;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      await visit(join(current, entry.name));
    }
  };
  await visit(directory);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
