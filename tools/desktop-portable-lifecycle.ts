import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { analysePage, ObjectStore, PROVISIONAL_LIMITS } from '@pdf-editor/pdf-engine';

import {
  acceptRichFontSubstitutions,
  activateByKeyboard,
  expandAllowedWidth,
} from '../apps/web/tests/editor-interactions';
import { installNoNetworkGuard } from './check-no-network';
import { runHandleDiagnostic, type HandleDiagnosticResult } from './desktop-handle-diagnostic';
import {
  assertPortableWindowFitsWorkArea,
  assertPortableWindow,
  assertProfileCookie,
  closePortableSession,
  invokeWindowsSmokeHelper,
  openPortableSession,
  OwnedProcessQueryError,
  OwnedProcessShutdownError,
  readOwnedProcessSnapshot,
  reserveLoopbackPort,
  waitForChildExit,
  waitForDownloadedPdf,
  waitForOwnedProcessShutdown,
  type OwnedProcessQuery,
  type OwnedProcessSnapshot,
  type AppSession,
} from './desktop-portable-session';
import { assertPortableRootEntries } from './desktop-portable-archive';

type PortableLifecycleInput = Readonly<{
  archive: string;
  temporaryRoot: string;
  applicationRoot: string;
  fixture: string;
}>;

const EXPECTED_CONFIG_ENTRIES = ['crashes', 'logs', 'profile', 'provenance.json', 'runtime', 'temp'];

type PortableRelocationDependencies = Readonly<{
  queryOwnedProcesses?: OwnedProcessQuery;
  renameDirectory?: (source: string, destination: string) => Promise<void>;
  report?: (record: Readonly<Record<string, unknown>>) => void;
  handleDiagnostic?: (applicationRoot: string) => Promise<HandleDiagnosticResult>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

export async function relocatePortableApplication(
  sourceRoot: string,
  destinationRoot: string,
  launcherPath: string,
  dependencies: PortableRelocationDependencies = {},
): Promise<void> {
  const queryOwnedProcesses = dependencies.queryOwnedProcesses ?? (
    (timeoutMs) => readOwnedProcessSnapshot(sourceRoot, launcherPath, timeoutMs)
  );
  const report = dependencies.report ?? ((record: Readonly<Record<string, unknown>>) => {
    process.stdout.write(`PDF_SCRUBBER_SMOKE ${JSON.stringify(record)}\n`);
  });

  let shutdown: Awaited<ReturnType<typeof waitForOwnedProcessShutdown>>;
  try {
    shutdown = await waitForOwnedProcessShutdown(queryOwnedProcesses, {
      ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs }),
      ...(dependencies.pollIntervalMs === undefined ? {} : { pollIntervalMs: dependencies.pollIntervalMs }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
    });
  } catch (error) {
    const snapshots = error instanceof OwnedProcessShutdownError || error instanceof OwnedProcessQueryError
      ? { initialSnapshot: error.initialSnapshot, lastSnapshot: error.lastSnapshot }
      : {};
    reportWithoutMasking(report, {
      event: 'portable-owned-process-shutdown-failed',
      applicationRoot: sourceRoot,
      ...snapshots,
      error: describeError(error),
    });
    throw error;
  }

  report({
    event: 'portable-owned-process-shutdown',
    applicationRoot: sourceRoot,
    initialSnapshot: shutdown.initialSnapshot,
    finalSnapshot: shutdown.finalSnapshot,
  });

  try {
    await (dependencies.renameDirectory ?? rename)(sourceRoot, destinationRoot);
  } catch (renameError) {
    const configuredHandleExecutable = process.env.PDF_SCRUBBER_HANDLE_EXE;
    const handleDiagnostic = dependencies.handleDiagnostic ?? (
      configuredHandleExecutable === undefined || configuredHandleExecutable.length === 0
        ? undefined
        : (applicationRoot: string) => runHandleDiagnostic(configuredHandleExecutable, applicationRoot)
    );
    let handleDiagnosticResult: Readonly<Record<string, unknown>> | undefined;
    if (handleDiagnostic !== undefined) {
      try {
        handleDiagnosticResult = await handleDiagnostic(sourceRoot);
      } catch (error) {
        handleDiagnosticResult = { status: 'failed', error: describeError(error) };
      }
    }

    let processSnapshot: OwnedProcessSnapshot | undefined;
    let processSnapshotError: Readonly<Record<string, unknown>> | undefined;
    try {
      processSnapshot = await queryOwnedProcesses(5_000);
    } catch (error) {
      processSnapshotError = describeError(error);
    }

    const rootAttributes = await readObservedRootAttributes(sourceRoot);

    const diagnostic = {
      event: 'portable-relocation-failed',
      sourceRoot,
      destinationRoot,
      renameError: describeError(renameError),
      ...(handleDiagnosticResult === undefined ? {} : { handleDiagnostic: handleDiagnosticResult }),
      processSnapshot: processSnapshot ?? null,
      ...(processSnapshotError === undefined ? {} : { processSnapshotError }),
      rootAttributes,
    };
    reportWithoutMasking(report, diagnostic);

    const wrapped = Object.assign(
      new Error(`Portable application relocation failed: ${JSON.stringify(diagnostic)}`, { cause: renameError }),
      pickErrorFields(renameError),
      {
        name: 'PortableRelocationError',
        processSnapshot,
        processSnapshotError,
        rootAttributes,
      },
    );
    throw wrapped;
  }
}

export function chooseFittingNonDefaultWindowSize(
  workArea: Readonly<{ width: number; height: number }>,
): Readonly<{ width: number; height: number }> {
  const width = Math.min(900, workArea.width);
  const height = Math.min(640, workArea.height);
  if (!Number.isInteger(width) || width < 760 || !Number.isInteger(height) || height < 560) {
    throw new Error(
      `Observed display work area ${workArea.width}x${workArea.height} cannot fit a non-default portable window above 760x560.`,
    );
  }
  return Object.freeze({ width, height });
}

export async function runPortableLifecycle(input: PortableLifecycleInput): Promise<void> {
  let applicationRoot = input.applicationRoot;
  let runtimeDirectory = join(applicationRoot, 'config', 'runtime');
  let launcherExecutable = join(applicationRoot, 'PDF-Scrubber.exe');
  let settingsPath = join(applicationRoot, 'settings.json');
  let activeSession: AppSession | undefined;
  let firstReadyMs = 0;
  let repeatReadyMs = 0;
  const runtimeInventory = await collectTreeInventory(runtimeDirectory);
  const appDataBefore = await snapshotLegacyAppData();
  const profileCookie = `pdf-scrubber-${randomUUID()}`;
  const profileCookieValue = randomUUID();

  const openSession = async (): Promise<AppSession> => {
    const session = await openPortableSession(launcherExecutable, applicationRoot, input.temporaryRoot);
    activeSession = session;
    return session;
  };
  const closeSession = async (): Promise<void> => {
    if (activeSession === undefined) return;
    await closePortableSession(activeSession);
    activeSession = undefined;
  };

  try {
    const firstStart = Date.now();
    const first = await openSession();
    firstReadyMs = Date.now() - firstStart;
    const firstWindow = await assertPortableWindow(first, 1280, 860);
    const customWindowSize = chooseFittingNonDefaultWindowSize(firstWindow.workArea);
    const customSettings = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      window: customWindowSize,
    }, null, 2)}\n`, 'utf8');
    const remoteRequests = await installNoNetworkGuard(first.page);
    const rendererCapabilities = await first.page.evaluate(() => ({
      require: typeof (window as Window & { require?: unknown }).require,
      process: typeof (window as Window & { process?: unknown }).process,
    }));
    expect(rendererCapabilities).toEqual({ require: 'undefined', process: 'undefined' });

    await first.page.getByLabel('Open PDF').setInputFiles(input.fixture);
    await expect(first.page.getByTestId('pdf-canvas')).toBeVisible({ timeout: 20_000 });
    await activateByKeyboard(first.page, first.page.getByRole('button', { name: /Target 01 — Editable/ }));
    await first.page.getByLabel('Edit selected text').fill('Portable desktop edit');
    await expandAllowedWidth(first.page);
    await acceptRichFontSubstitutions(first.page);
    const apply = first.page.getByRole('button', { name: 'Apply replacement' });
    await expect(apply).toBeEnabled({ timeout: 20_000 });
    await apply.click();
    await expect(first.page.getByRole('button', { name: /Portable desktop edit — Editable/ }))
      .toBeVisible({ timeout: 20_000 });
    await first.page.getByRole('button', { name: 'Download copy' }).click();
    const downloadPath = await waitForDownloadedPdf(first.downloadDirectory);
    const bytes = new Uint8Array(await readFile(downloadPath));
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(0);
    const objectStore = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
    const pageAnalysis = await analysePage(objectStore, 0);
    const pageText = pageAnalysis.spans.map(({ unicode }) => unicode ?? '').join(' ');
    expect(pageText).toContain('Portable desktop edit');
    expect(remoteRequests).toEqual([]);
    await first.context.addCookies([{
      name: profileCookie,
      value: profileCookieValue,
      domain: '127.0.0.1',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: true,
    }]);
    await closeSession();
    expect(await readFile(settingsPath)).toEqual(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      window: { width: 1280, height: 860 },
    }, null, 2) + '\n'));

    const repeatStart = Date.now();
    const repeat = await openSession();
    repeatReadyMs = Date.now() - repeatStart;
    await assertPortableWindow(repeat, 1280, 860);
    await assertProfileCookie(repeat, profileCookie, profileCookieValue);
    await closeSession();

    await writeFile(settingsPath, customSettings);
    const movedRoot = join(input.temporaryRoot, 'Moved portable application with spaces and café');
    await relocatePortableApplication(applicationRoot, movedRoot, launcherExecutable);
    applicationRoot = movedRoot;
    runtimeDirectory = join(applicationRoot, 'config', 'runtime');
    launcherExecutable = join(applicationRoot, 'PDF-Scrubber.exe');
    settingsPath = join(applicationRoot, 'settings.json');

    const moved = await openSession();
    const movedWindow = await assertPortableWindow(moved, customWindowSize.width, customWindowSize.height);
    assertPortableWindowFitsWorkArea(movedWindow, customWindowSize.width, customWindowSize.height);
    await assertProfileCookie(moved, profileCookie, profileCookieValue);
    await closeSession();
    expect(await readFile(settingsPath)).toEqual(customSettings);
    await assertRootLayout(applicationRoot);
    await assertRuntimeUnchanged(runtimeDirectory, runtimeInventory);

    const primary = await openSession();
    const primaryWindow = await assertPortableWindow(primary, customWindowSize.width, customWindowSize.height);
    assertPortableWindowFitsWorkArea(primaryWindow, customWindowSize.width, customWindowSize.height);
    const concurrentPort = await reserveLoopbackPort();
    const concurrentChild = spawnSecondLauncher(launcherExecutable, concurrentPort);
    await once(concurrentChild as unknown as NodeJS.EventEmitter, 'spawn');
    await waitForChildExit(concurrentChild, 15_000);
    if (primary.child.exitCode !== null || primary.child.signalCode !== null || primary.page.isClosed()) {
      throw new Error('Concurrent launcher disrupted the already-running portable application.');
    }
    await closeSession();

    await invokeWindowsSmokeHelper([
      '-Operation', 'ForceRuntimeExit',
      '-ApplicationRoot', applicationRoot,
      '-LauncherPath', launcherExecutable,
      '-Port', String(await reserveLoopbackPort()),
    ]);
    const afterForcedExit = await openSession();
    const afterForcedExitWindow = await assertPortableWindow(
      afterForcedExit,
      customWindowSize.width,
      customWindowSize.height,
    );
    assertPortableWindowFitsWorkArea(
      afterForcedExitWindow,
      customWindowSize.width,
      customWindowSize.height,
    );
    await assertProfileCookie(afterForcedExit, profileCookie, profileCookieValue);
    await closeSession();

    await rm(settingsPath);
    try {
      const missingSettings = await openSession();
      await assertPortableWindow(missingSettings, 1280, 860);
      await closeSession();
      expect(await readJsonFile(settingsPath)).toEqual({
        schemaVersion: 1,
        window: { width: 1280, height: 860 },
      });
    } finally {
      await closeSession();
      await writeFile(settingsPath, customSettings);
    }

    await assertRootLayout(applicationRoot);
    assertPortableConfigEntries(await readdir(join(applicationRoot, 'config')));
    expect(await readFile(settingsPath)).toEqual(customSettings);
    await assertRuntimeUnchanged(runtimeDirectory, runtimeInventory);
    const appDataAfter = await snapshotLegacyAppData();
    if (appDataAfter !== appDataBefore) {
      throw new Error('An owned portable-app launch created or modified a known PDF-Scrubber AppData location.');
    }
    process.stdout.write(`PDF_SCRUBBER_SMOKE ${JSON.stringify({
      event: 'portable-lifecycle-complete',
      archive: input.archive,
      firstReadyMs,
      repeatReadyMs,
      managedPathsChecked: true,
      knownLegacyAppDataUnchanged: true,
      runtimeInventoryUnchanged: true,
      automatedNegativeDialogChecks: false,
      manualNegativeDialogCheck: 'pending',
      directInnerRuntimeNegativeCheck: 'pending',
    })}\n`);
  } finally {
    await closeSession();
  }
}

function reportWithoutMasking(
  report: (record: Readonly<Record<string, unknown>>) => void,
  record: Readonly<Record<string, unknown>>,
): void {
  try {
    report(record);
  } catch {
    // A diagnostic write must not replace the original shutdown or rename failure.
  }
}

function describeError(error: unknown): Readonly<Record<string, unknown>> {
  const details: Record<string, unknown> = {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
  };
  Object.assign(details, pickErrorFields(error));
  return details;
}

function pickErrorFields(error: unknown): Readonly<Record<string, unknown>> {
  if (error === null || typeof error !== 'object') return {};
  const details: Record<string, unknown> = {};
  const properties = error as Record<string, unknown>;
  for (const name of ['code', 'syscall', 'path', 'dest'] as const) {
    if (name in properties) details[name] = properties[name];
  }
  return details;
}

async function readObservedRootAttributes(sourceRoot: string): Promise<Readonly<Record<string, unknown>>> {
  try {
    const details = await lstat(sourceRoot);
    return {
      exists: true,
      isDirectory: details.isDirectory(),
      isSymbolicLink: details.isSymbolicLink(),
      mode: details.mode,
    };
  } catch (error) {
    return { exists: false, error: describeError(error) };
  }
}

function spawnSecondLauncher(executable: string, port: number) {
  const child: ChildProcess = spawn(executable, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
  ], { stdio: 'ignore', windowsHide: true });
  return child;
}

async function assertRootLayout(applicationRoot: string): Promise<void> {
  assertPortableRootEntries(await readdir(applicationRoot));
}

async function assertRuntimeUnchanged(runtimeDirectory: string, expected: readonly string[]): Promise<void> {
  if (JSON.stringify(await collectTreeInventory(runtimeDirectory)) !== JSON.stringify(expected)) {
    throw new Error('The packaged Electron runtime tree changed during portable-app execution.');
  }
}

async function collectTreeInventory(directory: string, hashContents = false): Promise<string[]> {
  const records: string[] = [];
  const visit = async (current: string, relative: string): Promise<void> => {
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      throw new Error(`Portable smoke found a reparse point in an owned tree: ${relative || '.'}`);
    }
    if (details.isDirectory()) {
      records.push(`${relative}\tD\t${details.mtimeMs}`);
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((first, second) => first.name.localeCompare(second.name));
      for (const entry of entries) {
        await visit(join(current, entry.name), relative.length === 0 ? entry.name : `${relative}/${entry.name}`);
      }
      return;
    }
    if (!details.isFile()) throw new Error(`Portable smoke found a non-file entry in an owned tree: ${relative}`);
    let digest = '';
    if (hashContents) digest = createHash('sha256').update(await readFile(current)).digest('hex');
    records.push(`${relative}\tF\t${details.size}\t${details.mtimeMs}\t${digest}`);
  };
  await visit(directory, '');
  return records;
}

async function snapshotLegacyAppData(): Promise<string> {
  const locations = [
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'PDF-Scrubber'),
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'PDF-Scrubber'),
  ].filter((value): value is string => value !== undefined);
  const snapshots: string[] = [];
  const seen = new Set<string>();
  for (const location of locations) {
    const key = normaliseWindowsPath(location);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const details = await lstat(location);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new Error('A legacy PDF-Scrubber AppData location is not a regular directory.');
      }
      snapshots.push(`${key}\n${(await collectTreeInventory(location, true)).join('\n')}`);
    } catch (error) {
      if (isMissingPathError(error)) snapshots.push(`${key}\nABSENT`);
      else throw error;
    }
  }
  return snapshots.sort().join('\n---\n');
}

function isMissingPathError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function normaliseWindowsPath(value: string): string {
  return resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function assertPortableConfigEntries(entries: readonly string[]): void {
  const expected = [...EXPECTED_CONFIG_ENTRIES].sort();
  const actual = [...entries].sort();
  expect(actual, 'portable config contains only managed storage and the packaged runtime/provenance')
    .toEqual(expected);
}
