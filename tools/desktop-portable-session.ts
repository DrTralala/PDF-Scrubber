import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const DEBUG_START_TIMEOUT_MS = 45_000;
const APP_SHUTDOWN_TIMEOUT_MS = 15_000;
const WINDOWS_HELPER_TIMEOUT_MS = 90_000;
const execFileAsync = promisify(execFile);

export type AppSession = {
  applicationRoot: string;
  downloadDirectory: string;
  debugPort: number;
  child: ChildProcess;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  stdoutCapture?: ReturnType<typeof captureDiagnostics>;
  stderrCapture?: ReturnType<typeof captureDiagnostics>;
  closed: boolean;
};

type CdpConnector = Pick<typeof chromium, 'connectOverCDP'>;

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
    const session: AppSession = {
      applicationRoot,
      downloadDirectory,
      debugPort,
      child,
      browser,
      context,
      page,
      ...(stdoutCapture === undefined ? {} : { stdoutCapture }),
      ...(stderrCapture === undefined ? {} : { stderrCapture }),
      closed: false,
    };
    assertManagedPaths(await readElectronDiagnostics(session), applicationRoot);
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

export async function assertPortableWindow(session: AppSession, width: number, height: number): Promise<void> {
  const record = await waitForDiagnosticRecord(
    () => readElectronDiagnostics(session),
    'portable-window-ready',
    { child: session.child },
  );
  expect(record).toMatchObject({
    requestedWidth: width,
    requestedHeight: height,
    width,
    height,
    minWidth: 760,
    minHeight: 560,
  });
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
  const helperPath = join(import.meta.dirname, 'desktop-portable-smoke.windows.ps1');
  const result = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    ...arguments_,
  ], {
    timeout: WINDOWS_HELPER_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  if (!result.stdout.includes('passed')) {
    throw new Error('Native Windows lifecycle helper did not report its operation as passed.');
  }
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

function assertManagedPaths(records: readonly Record<string, unknown>[], applicationRoot: string): void {
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
  const temporaryEnvironment = record?.tempEnvironment as Record<string, unknown> | undefined;
  for (const name of ['TMP', 'TEMP', 'TMPDIR']) {
    expect(normaliseWindowsPath(temporaryEnvironment?.[name]), `${name} points to portable temp`).toBe(
      normaliseWindowsPath(join(config, 'temp')),
    );
  }
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
