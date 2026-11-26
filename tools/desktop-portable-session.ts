import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const DEBUG_START_TIMEOUT_MS = 45_000;
const APP_SHUTDOWN_TIMEOUT_MS = 15_000;
const WINDOWS_HELPER_TIMEOUT_MS = 90_000;
const MAX_CHILD_PROCESS_TIMEOUT_MS = 2_147_483_647;
const OWNED_PROCESS_QUERY_RECORD_LIMIT = 32;
const OWNED_PROCESS_POLL_INTERVAL_MS = 150;
const execFileAsync = promisify(execFile);

export type AppSession = {
  applicationRoot: string;
  downloadDirectory: string;
  runtimeProcessId: number;
  debugPort: number;
  child: ChildProcess;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  stdoutCapture?: ReturnType<typeof captureDiagnostics>;
  stderrCapture?: ReturnType<typeof captureDiagnostics>;
  closed: boolean;
};

export type PortableWindowDiagnostic = Readonly<{
  event: 'portable-window-ready';
  requestedWidth: number;
  requestedHeight: number;
  width: number;
  height: number;
  displayId: number;
  workArea: Readonly<{ x: number; y: number; width: number; height: number }>;
  minWidth: 760;
  minHeight: 560;
}>;

type CdpConnector = Pick<typeof chromium, 'connectOverCDP'>;

export type OwnedProcessRecord = Readonly<{
  processId: number;
  parentProcessId: number;
  executablePath: string;
  creationTime: string | null;
}>;

export type OwnedProcessSnapshot = Readonly<{
  totalCount: number;
  truncated: boolean;
  records: readonly OwnedProcessRecord[];
}>;

export type OwnedProcessQuery = (timeoutMs: number) => Promise<OwnedProcessSnapshot>;

export type OwnedProcessWaitOptions = Readonly<{
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

export class OwnedProcessShutdownError extends Error {
  constructor(
    readonly initialSnapshot: OwnedProcessSnapshot | undefined,
    readonly lastSnapshot: OwnedProcessSnapshot | undefined,
    timeoutMs: number,
  ) {
    super(
      `Owned portable processes remained under the application root after ${timeoutMs}ms; `
      + `initial=${JSON.stringify(initialSnapshot ?? null)}; last=${JSON.stringify(lastSnapshot ?? null)}`,
    );
    this.name = 'OwnedProcessShutdownError';
  }
}

export class OwnedProcessQueryError extends Error {
  constructor(
    readonly initialSnapshot: OwnedProcessSnapshot | undefined,
    readonly lastSnapshot: OwnedProcessSnapshot | undefined,
    cause: unknown,
  ) {
    super(
      `Could not verify that owned portable processes have exited; refusing relocation. `
      + `initial=${JSON.stringify(initialSnapshot ?? null)}; last=${JSON.stringify(lastSnapshot ?? null)}`,
      { cause },
    );
    this.name = 'OwnedProcessQueryError';
  }
}

export function parseOwnedProcessSnapshot(stdout: string): OwnedProcessSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error('Native Windows process snapshot was not valid JSON.', { cause: error });
  }
  if (!isRecord(value)
    || !hasExactKeys(value, ['operation', 'totalCount', 'truncated', 'records'])
    || value.operation !== 'SnapshotOwnedProcesses'
    || !Number.isSafeInteger(value.totalCount)
    || (value.totalCount as number) < 0
    || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.records)
    || value.records.length > OWNED_PROCESS_QUERY_RECORD_LIMIT) {
    throw new Error('Native Windows process snapshot did not match its bounded schema.');
  }

  const totalCount = value.totalCount as number;
  const records: OwnedProcessRecord[] = value.records.map((record: unknown) => {
    if (!isRecord(record)
      || !hasExactKeys(record, ['processId', 'parentProcessId', 'executablePath', 'creationTime'])
      || !Number.isSafeInteger(record.processId)
      || (record.processId as number) < 1
      || !Number.isSafeInteger(record.parentProcessId)
      || (record.parentProcessId as number) < 0
      || typeof record.executablePath !== 'string'
      || record.executablePath.length === 0
      || !(record.creationTime === null || typeof record.creationTime === 'string')) {
      throw new Error('Native Windows process snapshot contained an invalid process record.');
    }
    return {
      processId: record.processId as number,
      parentProcessId: record.parentProcessId as number,
      executablePath: record.executablePath,
      creationTime: record.creationTime,
    };
  });

  const shouldBeTruncated = totalCount > OWNED_PROCESS_QUERY_RECORD_LIMIT;
  const expectedRecords = Math.min(totalCount, OWNED_PROCESS_QUERY_RECORD_LIMIT);
  if (value.truncated !== shouldBeTruncated || records.length !== expectedRecords) {
    throw new Error('Native Windows process snapshot count did not match its records.');
  }

  return { totalCount, truncated: value.truncated, records };
}

export async function readOwnedProcessSnapshot(
  applicationRoot: string,
  launcherPath: string,
  timeoutMs = WINDOWS_HELPER_TIMEOUT_MS,
): Promise<OwnedProcessSnapshot> {
  const result = await runWindowsSmokeHelper([
    '-Operation', 'SnapshotOwnedProcesses',
    '-ApplicationRoot', applicationRoot,
    '-LauncherPath', launcherPath,
  ], timeoutMs);
  return parseOwnedProcessSnapshot(result.stdout.trim());
}

export async function waitForOwnedProcessShutdown(
  query: OwnedProcessQuery,
  options: OwnedProcessWaitOptions = {},
): Promise<Readonly<{
  initialSnapshot: OwnedProcessSnapshot;
  finalSnapshot: OwnedProcessSnapshot;
}>> {
  const timeoutMs = options.timeoutMs ?? APP_SHUTDOWN_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? OWNED_PROCESS_POLL_INTERVAL_MS;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? delay;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Owned-process shutdown timeout must be a positive finite number.');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError('Owned-process poll interval must be a positive finite number.');
  }

  const deadline = now() + timeoutMs;
  let initialSnapshot: OwnedProcessSnapshot | undefined;
  let lastSnapshot: OwnedProcessSnapshot | undefined;
  while (true) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new OwnedProcessShutdownError(initialSnapshot, lastSnapshot, timeoutMs);
    }

    let snapshot: OwnedProcessSnapshot;
    try {
      snapshot = await query(remainingMs);
    } catch (error) {
      throw new OwnedProcessQueryError(initialSnapshot, lastSnapshot, error);
    }
    initialSnapshot ??= snapshot;
    lastSnapshot = snapshot;

    const remainingAfterQueryMs = deadline - now();
    if (remainingAfterQueryMs < 0) {
      throw new OwnedProcessShutdownError(initialSnapshot, lastSnapshot, timeoutMs);
    }
    if (snapshot.totalCount === 0 && !snapshot.truncated && snapshot.records.length === 0) {
      return { initialSnapshot, finalSnapshot: snapshot };
    }
    if (remainingAfterQueryMs <= 0) {
      throw new OwnedProcessShutdownError(initialSnapshot, lastSnapshot, timeoutMs);
    }
    await sleep(Math.min(pollIntervalMs, remainingAfterQueryMs));
  }
}

export async function openPortableSession(
  executable: string,
  applicationRoot: string,
  temporaryRoot: string,
): Promise<AppSession> {
  const downloadDirectory = join(temporaryRoot, `launch-${randomUUID()}`);
  await mkdir(downloadDirectory);
  const debugPort = await reserveLoopbackPort();
  const child = spawn(executable, [
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--pdf-scrubber-smoke-save-dir=${downloadDirectory}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const stdoutCapture = child.stdout === null
    ? undefined
    : captureDiagnostics(child.stdout);
  const stderrCapture = child.stderr === null
    ? undefined
    : captureDiagnostics(child.stderr);
  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    await once(child as unknown as NodeJS.EventEmitter, 'spawn');
    const endpoint = await waitForCdpEndpoint(debugPort, child);
    browser = await connectElectronBrowser(endpoint);
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('Portable app did not expose a browser context');
    page = await waitForEditorPage(context);
    const runtimeProcessId = assertManagedPaths(
      await readPortableDiagnostics({ downloadDirectory }),
      applicationRoot,
    );
    const session: AppSession = {
      applicationRoot,
      downloadDirectory,
      runtimeProcessId,
      debugPort,
      child,
      browser,
      context,
      page,
      ...(stdoutCapture === undefined ? {} : { stdoutCapture }),
      ...(stderrCapture === undefined ? {} : { stderrCapture }),
      closed: false,
    };
    return session;
  } catch (error) {
    if (page !== undefined && !page.isClosed()) await page.close().catch(() => undefined);
    if (browser !== undefined) await browser.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) {
      await terminateOwnedPortableTree(child, applicationRoot).catch(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      });
      await waitForChildClose(child, 5_000).catch(() => undefined);
    }
    await drainSessionReaders(child, stdoutCapture, stderrCapture);
    throw error;
  }
}

export async function closePortableSession(session: AppSession): Promise<void> {
  if (session.closed) return;
  let shutdownError: unknown;
  if (!session.page.isClosed()) await session.page.close().catch(() => undefined);
  await session.browser.close().catch(() => undefined);
  try {
    await waitForCdpShutdown(session.debugPort, APP_SHUTDOWN_TIMEOUT_MS);
  } catch (error) {
    shutdownError = error;
  }
  if (session.child.exitCode === null && session.child.signalCode === null) {
    try {
      await waitForChildExit(session.child, APP_SHUTDOWN_TIMEOUT_MS);
    } catch (error) {
      shutdownError ??= error;
      await terminateOwnedPortableTree(session.child, session.applicationRoot).catch(() => {
        if (session.child.exitCode === null && session.child.signalCode === null) session.child.kill();
      });
      await waitForChildClose(session.child, 5_000).catch(() => undefined);
    }
  }
  await drainSessionReaders(session.child, session.stdoutCapture, session.stderrCapture);
  const records = await readElectronDiagnostics(session);
  try {
    assertPortableShutdownDiagnostic(records);
  } catch (error) {
    shutdownError ??= error;
  }
  session.closed = true;
  if (shutdownError !== undefined) throw shutdownError;
}

export function assertPortableShutdownDiagnostic(records: readonly Record<string, unknown>[]): void {
  if (!records.some(({ event }) => event === 'portable-shutdown')) {
    throw new Error('Portable app did not emit the required file-backed portable-shutdown diagnostic.');
  }
}

export async function assertPortableWindow(
  session: AppSession,
  width: number,
  height: number,
): Promise<PortableWindowDiagnostic> {
  const record = await waitForDiagnosticRecord(
    () => readElectronDiagnostics(session),
    'portable-window-ready',
    { child: session.child },
  );
  return assertPortableWindowRecord(record, width, height);
}

export function assertPortableWindowRecord(
  record: Readonly<Record<string, unknown>>,
  width: number,
  height: number,
): PortableWindowDiagnostic {
  if (!Number.isSafeInteger(record.displayId)) {
    throw new Error('Portable window diagnostic is missing a valid display identity.');
  }
  const workAreaValue = record.workArea;
  if (workAreaValue === null || typeof workAreaValue !== 'object') {
    throw new Error('Portable window diagnostic is missing the observed display work area.');
  }
  const workArea = workAreaValue as Record<string, unknown>;
  for (const name of ['x', 'y', 'width', 'height']) {
    if (typeof workArea[name] !== 'number' || !Number.isInteger(workArea[name])) {
      throw new Error(`Portable window diagnostic has an invalid display work-area ${name}.`);
    }
  }
  const workAreaWidth = workArea.width as number;
  const workAreaHeight = workArea.height as number;
  if (workAreaWidth < 760 || workAreaHeight < 560) {
    throw new Error(
      `Observed display work area ${workAreaWidth}x${workAreaHeight} is smaller than the portable window minimum 760x560.`,
    );
  }
  expect(record).toMatchObject({
    event: 'portable-window-ready',
    requestedWidth: width,
    requestedHeight: height,
    displayId: expect.any(Number),
    minWidth: 760,
    minHeight: 560,
  });
  const expectedWidth = Math.min(width, workAreaWidth);
  const expectedHeight = Math.min(height, workAreaHeight);
  expect(record.width,
    `actual width must equal requested ${width} clipped to work-area width ${workAreaWidth}`)
    .toBe(expectedWidth);
  expect(record.height,
    `actual height must equal requested ${height} clipped to work-area height ${workAreaHeight}`)
    .toBe(expectedHeight);
  return record as PortableWindowDiagnostic;
}

export function assertPortableWindowFitsWorkArea(
  record: PortableWindowDiagnostic,
  width: number,
  height: number,
): void {
  if (width > record.workArea.width || height > record.workArea.height) {
    throw new Error(
      `Custom portable window ${width}x${height} does not fit observed display work area `
      + `${record.workArea.width}x${record.workArea.height}.`,
    );
  }
  expect(record.requestedWidth).toBe(width);
  expect(record.requestedHeight).toBe(height);
  expect(record.width).toBe(width);
  expect(record.height).toBe(height);
}

export async function waitForDiagnosticRecord(
  readRecords: () => Promise<readonly Record<string, unknown>[]>,
  eventName: string,
  options: Readonly<{
    timeoutMs?: number;
    pollIntervalMs?: number;
    child?: Pick<ChildProcess, 'exitCode' | 'signalCode'>;
  }> = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? DEBUG_START_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const record = (await readRecords()).find(({ event }) => event === eventName);
    if (record !== undefined) return record;
    if (options.child !== undefined
      && (options.child.exitCode !== null || options.child.signalCode !== null)) {
      throw new Error(
        `Portable app exited before emitting ${eventName} `
        + `(exit=${String(options.child.exitCode)}, signal=${String(options.child.signalCode)})`,
      );
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Portable app did not emit ${eventName} within ${timeoutMs}ms`);
    }
    await delay(Math.min(pollIntervalMs, remainingMs));
  }
}

export async function assertProfileCookie(
  session: AppSession,
  cookieName: string,
  cookieValue: string,
): Promise<void> {
  const cookies = await session.context.cookies();
  expect(cookies).toContainEqual(expect.objectContaining({ name: cookieName, value: cookieValue }));
}

export async function waitForDownloadedPdf(directory: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const files = (await readdir(directory)).filter((file) => file.toLowerCase().endsWith('.pdf'));
    if (files.length === 1) {
      const path = join(directory, files[0]!);
      const fileStats = await stat(path);
      if (fileStats.size > 0) return path;
    }
    if (files.length > 1) throw new Error('Portable app wrote multiple PDFs for one download action');
    await delay(100);
  }
  throw new Error('Portable app did not save the edited PDF');
}

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const listening = once(server as unknown as NodeJS.EventEmitter, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeNetServer(server);
    throw new Error('Could not reserve a loopback debugging port');
  }
  const port = address.port;
  await closeNetServer(server);
  return port;
}

export async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    assertChildExitedSuccessfully(child);
    return;
  }
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const emitter = child as unknown as NodeJS.EventEmitter;
  const closed = once(emitter, 'close', { signal: controller.signal });
  const failed = once(emitter, 'error', { signal: controller.signal })
    .then(([error]) => Promise.reject(error));
  try {
    await Promise.race([
      closed,
      failed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Portable app process did not exit after its window was closed')),
          timeoutMs,
        );
      }),
    ]);
    assertChildExitedSuccessfully(child);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

export async function invokeWindowsSmokeHelper(arguments_: readonly string[]): Promise<void> {
  const result = await runWindowsSmokeHelper(arguments_, WINDOWS_HELPER_TIMEOUT_MS);
  if (!result.stdout.includes('passed')) {
    throw new Error('Native Windows lifecycle helper did not report its operation as passed.');
  }
}

export function createWindowsSmokeHelperExecOptions(timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Windows smoke helper timeout must be finite positive milliseconds.');
  }
  return {
    timeout: Math.min(MAX_CHILD_PROCESS_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs))),
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  };
}

export async function connectElectronBrowser(
  endpoint: string,
  connector: CdpConnector = chromium,
): Promise<Browser> {
  // Electron owns its DownloadItem/save path; Playwright's default CDP override redirects downloads to its temp folder.
  return connector.connectOverCDP(endpoint, { noDefaults: true });
}

export async function drainDiagnosticReaders(
  readers: readonly Promise<unknown>[],
  closeStreams: () => void,
  timeoutMs = 250,
): Promise<void> {
  closeStreams();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(readers).then(() => undefined, () => undefined),
      new Promise<void>((resolvePromise) => {
        timer = setTimeout(resolvePromise, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForCdpEndpoint(port: number, child: ChildProcess): Promise<string> {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + DEBUG_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const details = await response.json() as { webSocketDebuggerUrl?: unknown };
        if (typeof details.webSocketDebuggerUrl === 'string') return endpoint;
      }
    } catch {
      // The packaged launcher may need several seconds to unpack its portable image.
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Portable app exited before the debugging endpoint appeared (${child.exitCode})`);
    }
    await delay(200);
  }
  throw new Error(`Portable app did not expose its loopback debugging endpoint: ${endpoint}`);
}

async function waitForCdpShutdown(port: number, timeoutMs: number): Promise<void> {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        await delay(100);
        continue;
      }
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error('Portable app left its loopback debugging endpoint running after shutdown');
}

async function waitForEditorPage(context: BrowserContext): Promise<Page> {
  const deadline = Date.now() + DEBUG_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const page = context.pages().find((candidate) => {
      try {
        return new URL(candidate.url()).hostname === '127.0.0.1';
      } catch {
        return false;
      }
    });
    if (page !== undefined) {
      await page.waitForLoadState('domcontentloaded', { timeout: DEBUG_START_TIMEOUT_MS });
      return page;
    }
    await delay(100);
  }
  throw new Error('Portable app did not open the local PDF-Scrubber editor');
}

function captureDiagnostics(stream: NodeJS.ReadableStream): Readonly<{
  reader: ReturnType<typeof createInterface>;
  completed: Promise<void>;
}> {
  const reader = createInterface({ input: stream });
  const completed = (async () => {
    for await (const line of reader) void line;
  })();
  return Object.freeze({ reader, completed });
}

async function drainSessionReaders(
  child: ChildProcess,
  stdoutCapture: ReturnType<typeof captureDiagnostics> | undefined,
  stderrCapture: ReturnType<typeof captureDiagnostics> | undefined,
): Promise<void> {
  await drainDiagnosticReaders([
    ...(stdoutCapture === undefined ? [] : [stdoutCapture.completed]),
    ...(stderrCapture === undefined ? [] : [stderrCapture.completed]),
  ], () => {
    stdoutCapture?.reader.close();
    stderrCapture?.reader.close();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }, 250);
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const closed = once(child as unknown as NodeJS.EventEmitter, 'close', { signal: controller.signal });
  try {
    await Promise.race([
      closed.then(() => undefined),
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned portable process did not close in time')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

async function readElectronDiagnostics(session: AppSession): Promise<Record<string, unknown>[]> {
  return readPortableDiagnostics(session);
}

export async function readPortableDiagnostics(
  session: Readonly<{ downloadDirectory: string }>,
): Promise<Record<string, unknown>[]> {
  let diagnosticText: string;
  try {
    diagnosticText = await readFile(join(session.downloadDirectory, 'desktop-diagnostics.jsonl'), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw new Error('Could not read the file-backed portable smoke diagnostics.', { cause: error });
  }
  const lines = diagnosticText.split(/\r?\n/);
  return lines.flatMap((line) => {
    if (line.length === 0) return [];
    try {
      const value: unknown = JSON.parse(line);
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? [value as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

function isMissingFileError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function assertManagedPaths(records: readonly Record<string, unknown>[], applicationRoot: string): number {
  const record = records.find(({ event }) => event === 'portable-managed-paths');
  expect(record, 'portable managed-paths CI diagnostic').toBeDefined();
  const config = join(applicationRoot, 'config');
  const expectedPaths: Readonly<Record<string, string>> = {
    root: applicationRoot,
    userData: join(config, 'profile'),
    sessionData: join(config, 'profile'),
    temp: join(config, 'temp'),
    logs: join(config, 'logs'),
    crashDumps: join(config, 'crashes'),
  };
  for (const [key, expectedPath] of Object.entries(expectedPaths)) {
    expect(normaliseWindowsPath(record?.[key]), `${key} path remains portable`).toBe(
      normaliseWindowsPath(expectedPath),
    );
  }
  expect(record?.processId).toEqual(expect.any(Number));
  if (typeof record?.processId !== 'number' || !Number.isSafeInteger(record.processId)) {
    throw new Error('Portable managed-paths diagnostic is missing a valid Electron process identity.');
  }
  const temporaryEnvironment = record?.tempEnvironment as Record<string, unknown> | undefined;
  for (const name of ['TMP', 'TEMP', 'TMPDIR']) {
    expect(normaliseWindowsPath(temporaryEnvironment?.[name]), `${name} points to portable temp`).toBe(
      normaliseWindowsPath(join(config, 'temp')),
    );
  }
  return record.processId;
}

function normaliseWindowsPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

async function terminateOwnedPortableTree(child: ChildProcess, applicationRoot: string): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await invokeWindowsSmokeHelper([
    '-Operation', 'TerminateOwnedTree',
    '-ApplicationRoot', applicationRoot,
    '-LauncherPath', join(applicationRoot, 'PDF-Scrubber.exe'),
    '-RootProcessId', String(child.pid),
  ]);
}

function assertChildExitedSuccessfully(child: ChildProcess): void {
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw new Error(
      `Portable app process did not shut down cleanly (exit=${String(child.exitCode)}, signal=${String(child.signalCode)})`,
    );
  }
}

function closeNetServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

async function runWindowsSmokeHelper(
  arguments_: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const helperPath = join(import.meta.dirname, 'desktop-portable-smoke.windows.ps1');
  return execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    ...arguments_,
  ], createWindowsSmokeHelperExecOptions(timeoutMs));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}
