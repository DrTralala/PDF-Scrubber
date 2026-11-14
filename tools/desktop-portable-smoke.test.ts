import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { chromium, type Browser } from '@playwright/test';

import { chooseFittingNonDefaultWindowSize } from './desktop-portable-lifecycle';
import {
  assertPortableWindowFitsWorkArea,
  assertPortableWindowRecord,
  assertPortableShutdownDiagnostic,
  waitForDiagnosticRecord,
} from './desktop-portable-session';
import {
  archiveName,
  assertPortableArchiveFile,
  assertPortableArchivePaths,
  assertPortableProvenance,
  assertPortableRootEntries,
  parsePortableSmokeArguments,
  parseSevenZipEntries,
} from './desktop-portable-archive';
import { connectElectronBrowser, drainDiagnosticReaders } from './desktop-portable-smoke';

test('keeps Electron’s browser-managed download policy when attaching over CDP', async () => {
  const calls: Array<Readonly<{ endpoint: string; noDefaults: boolean | undefined }>> = [];
  const browser = {} as Browser;
  const connector = {
    async connectOverCDP(endpoint: string, options?: { noDefaults?: boolean }) {
      calls.push({ endpoint, noDefaults: options?.noDefaults });
      return browser;
    },
  } as unknown as typeof chromium;

  await expect(connectElectronBrowser('http://127.0.0.1:9222', connector)).resolves.toBe(browser);
  expect(calls).toEqual([{ endpoint: 'http://127.0.0.1:9222', noDefaults: true }]);
});

test('closes diagnostic streams and bounds waiting for a stalled reader', async () => {
  let streamsClosed = false;
  const stalledReader = new Promise<void>(() => {});

  await expect(drainDiagnosticReaders([stalledReader], () => {
    streamsClosed = true;
  }, 5)).resolves.toBeUndefined();
  expect(streamsClosed).toBe(true);
});

test('waits for a delayed portable window-ready diagnostic before asserting its dimensions', async () => {
  let reads = 0;
  const record = await waitForDiagnosticRecord(async () => {
    reads += 1;
    return reads < 3 ? [] : [{ event: 'portable-window-ready', width: 1200, height: 800 }];
  }, 'portable-window-ready', { timeoutMs: 250, pollIntervalMs: 1 });

  expect(reads).toBeGreaterThanOrEqual(3);
  expect(record).toMatchObject({ event: 'portable-window-ready', width: 1200, height: 800 });
});

test('reports a missing readiness diagnostic on timeout or if its process exits first', async () => {
  const noRecords = async () => [];

  await expect(waitForDiagnosticRecord(noRecords, 'portable-window-ready', {
    timeoutMs: 25,
    pollIntervalMs: 1,
  })).rejects.toThrow(/did not emit portable-window-ready within 25ms/);
  await expect(waitForDiagnosticRecord(noRecords, 'portable-window-ready', {
    child: { exitCode: 1, signalCode: null },
  })).rejects.toThrow(/exited before emitting portable-window-ready/);
});

test('requires a file-backed shutdown diagnostic so failed diagnostic writes cannot pass silently', () => {
  expect(() => assertPortableShutdownDiagnostic([
    { event: 'portable-managed-paths' },
    { event: 'portable-window-ready' },
  ])).toThrow(/portable-shutdown/);
  expect(() => assertPortableShutdownDiagnostic([
    { event: 'portable-managed-paths' },
    { event: 'portable-window-ready' },
    { event: 'portable-shutdown' },
  ])).not.toThrow();
});

test('accepts requested dimensions clamped exactly to the observed Electron display work area', () => {
  const observedWindow = {
    event: 'portable-window-ready',
    requestedWidth: 1280,
    requestedHeight: 860,
    width: 1024,
    height: 720,
    displayId: 1,
    minWidth: 760,
    minHeight: 560,
    workArea: { x: 0, y: 0, width: 1024, height: 720 },
  };

  expect(assertPortableWindowRecord(observedWindow, 1280, 860)).toEqual(observedWindow);
  expect(() => assertPortableWindowRecord({ ...observedWindow, requestedWidth: 1024 }, 1280, 860))
    .toThrow();
  expect(() => assertPortableWindowRecord({ ...observedWindow, width: 1023 }, 1280, 860))
    .toThrow();
});

test('chooses a genuinely fitting non-default custom window size from the observed work area', () => {
  const custom = chooseFittingNonDefaultWindowSize({ width: 1024, height: 720 });
  expect(custom).toEqual({ width: 900, height: 640 });
  expect(chooseFittingNonDefaultWindowSize({ width: 800, height: 600 }))
    .toEqual({ width: 800, height: 600 });
  const customRecord = assertPortableWindowRecord({
    event: 'portable-window-ready',
    requestedWidth: custom.width,
    requestedHeight: custom.height,
    width: custom.width,
    height: custom.height,
    displayId: 1,
    minWidth: 760,
    minHeight: 560,
    workArea: { x: 0, y: 0, width: 1024, height: 720 },
  }, custom.width, custom.height);
  expect(customRecord).toMatchObject({ width: 900, height: 640 });
  expect(() => assertPortableWindowFitsWorkArea(customRecord, 900, 640)).not.toThrow();
  expect(() => assertPortableWindowFitsWorkArea(customRecord, 1200, 800)).toThrow(/does not fit/);
  expect(() => chooseFittingNonDefaultWindowSize({ width: 759, height: 560 })).toThrow();
});

test('routes Electron CI diagnostics to the file-backed sink without direct stdout writes', async () => {
  const main = await readFile(join(import.meta.dirname, '../apps/desktop/runtime/main.cjs'), 'utf8');

  expect(main).toContain("require('./smoke-diagnostics.cjs')");
  expect(main).toContain('appendFile: appendFileSync');
  expect(main).toContain("event: 'portable-shutdown'");
  expect(main).toContain('screen.getDisplayMatching(bounds)');
  expect(main).toContain('workArea: display.workArea');
  expect(main).not.toContain('process.stdout.write');
});

test('names the final ordinary portable archive from a stable version', () => {
  expect(archiveName('1.1.0')).toBe('PDF-Scrubber-1.1.0-win-x64-portable.7z');
  expect(() => archiveName('1.1')).toThrow();
  expect(() => archiveName('1.1.0-beta.1')).toThrow();
});

test('parses only the archive and generated fixture smoke arguments', () => {
  expect(parsePortableSmokeArguments([
    '--archive', 'release/PDF-Scrubber-1.1.0-win-x64-portable.7z',
    '--fixture=fixtures/01-simple-tj.pdf',
  ])).toEqual({
    archive: 'release/PDF-Scrubber-1.1.0-win-x64-portable.7z',
    fixture: 'fixtures/01-simple-tj.pdf',
  });
  expect(() => parsePortableSmokeArguments(['--fixture', 'input.pdf'])).toThrow(/--archive/);
  expect(() => parsePortableSmokeArguments(['--archive', 'app.7z'])).toThrow(/--fixture/);
  expect(() => parsePortableSmokeArguments(['--executable', 'app.exe', '--fixture', 'input.pdf']))
    .toThrow(/Unknown option/);
});

test('rejects missing or non-7z archive inputs before extraction', () => {
  expect(() => assertPortableArchiveFile(join(tmpdir(), `pdf-scrubber-task2-missing-${randomUUID()}.7z`)))
    .toThrow(/archive/i);
  expect(() => assertPortableArchiveFile('/tmp/PDF-Scrubber-1.1.0.exe')).toThrow(/\.7z/i);
});

test('requires a single clean application root in the portable archive', () => {
  expect(() => assertPortableRootEntries(['PDF-Scrubber.exe', 'settings.json', 'config'])).not.toThrow();
  expect(() => assertPortableRootEntries([
    'PDF-Scrubber.exe', 'settings.json', 'config', 'extra.dll',
  ])).toThrow(/root/i);
  expect(() => assertPortableArchivePaths([
    'PDF-Scrubber',
    'PDF-Scrubber/PDF-Scrubber.exe',
    'PDF-Scrubber/settings.json',
    'PDF-Scrubber/config/runtime/PDF-Scrubber.exe',
  ])).not.toThrow();
  expect(() => assertPortableArchivePaths([
    'PDF-Scrubber/PDF-Scrubber.exe',
    'Other/extra.dll',
  ])).toThrow(/single PDF-Scrubber/i);
  expect(() => assertPortableArchivePaths([
    'PDF-Scrubber/PDF-Scrubber.exe',
    'PDF-Scrubber/../../outside.txt',
  ])).toThrow(/unsafe/i);
});

test('reads 7-Zip detailed listings without treating archive metadata as an entry', () => {
  const listing = [
    'Path = PDF-Scrubber-1.1.0-win-x64-portable.7z',
    'Type = 7z',
    'Physical Size = 1234',
    '',
    '----------',
    'Path = PDF-Scrubber',
    'Folder = +',
    '',
    'Path = PDF-Scrubber\\PDF-Scrubber.exe',
    'Size = 42',
    '',
  ].join('\n');

  expect(parseSevenZipEntries(listing)).toEqual([
    'PDF-Scrubber',
    'PDF-Scrubber\\PDF-Scrubber.exe',
  ]);
  expect(() => parseSevenZipEntries('archive has no detailed entries')).toThrow(/listing/);
});

test('requires archive and sidecar provenance to match every source identity', () => {
  const inArchive = {
    schemaVersion: 1,
    editor: { version: '1.1.0', tag: 'v1.1.0', sha: 'a'.repeat(40) },
    packaging: { sha: 'b'.repeat(40) },
  };

  expect(() => assertPortableProvenance(inArchive, inArchive, 'PDF-Scrubber-1.1.0-win-x64-portable.7z'))
    .not.toThrow();
  expect(() => assertPortableProvenance(
    inArchive,
    { ...inArchive, packaging: { sha: 'c'.repeat(40) } },
    'PDF-Scrubber-1.1.0-win-x64-portable.7z',
  )).toThrow(/provenance/i);
});

test('retains owned-process forced-exit checks and marks negative dialog checks manual', async () => {
  const [helper, lifecycle] = await Promise.all([
    readFile(join(import.meta.dirname, 'desktop-portable-smoke.windows.ps1'), 'utf8'),
    readFile(join(import.meta.dirname, 'desktop-portable-lifecycle.ts'), 'utf8'),
  ]);

  expect(helper).toContain("[ValidateSet('ForceRuntimeExit', 'SnapshotOwnedProcesses', 'TerminateOwnedTree')]");
  expect(helper).toContain('Get-OwnedProcessTree');
  expect(helper).toContain('Get-OwnedProcessSnapshot');
  expect(helper).toContain('StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)');
  expect(helper).toContain('$executablePath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)');
  expect(helper).toContain('creationTime = $creationTime');
  expect(helper).toContain('Get-OwnedProcessExitCode');
  expect(helper).toContain('if ($exitCode -isnot [int])');
  expect(helper).toContain('[void]$process.Handle');
  expect(helper).toContain('Stop-Process -Id $runtimeId -Force');
  expect(helper).toContain('$runtimePath.Equals($nativeRuntime');
  expect(helper).toContain('finally {');
  expect(helper).not.toMatch(/ExpectedText|ExpectError|ExpectUnwritableProfile|Wait-ForOwnedErrorDialog|FindVisibleWindows|UIAutomation|EncodedCommand|Add-Type/);
  expect(helper).not.toContain('CommandLine');
  expect(helper).not.toContain('desktop-portable-dialog.windows.ps1');

  expect(lifecycle).toContain("automatedNegativeDialogChecks: false");
  expect(lifecycle).toContain("manualNegativeDialogCheck: 'pending'");
  expect(lifecycle).toContain("directInnerRuntimeNegativeCheck: 'pending'");
  expect(lifecycle).not.toMatch(/ExpectError|ExpectUnwritableProfile|ExpectedText/);
  expect(lifecycle).toContain("'-Operation', 'ForceRuntimeExit'");
  expect(lifecycle).toContain('await relocatePortableApplication(applicationRoot, movedRoot, launcherExecutable);');
  expect(lifecycle).toContain("event: 'portable-lifecycle-complete'");
  expect(lifecycle).toContain("'Portable desktop edit'");
  expect(lifecycle).toContain('remoteRequests');
  expect(lifecycle).toContain('missingSettings');
});
