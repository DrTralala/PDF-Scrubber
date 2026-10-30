import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { analysePage, ObjectStore, PROVISIONAL_LIMITS } from '@pdf-editor/pdf-engine';

import { installNoNetworkGuard } from './check-no-network';
import {
  acceptRichFontSubstitutions,
  activateByKeyboard,
  expandAllowedWidth,
} from '../apps/web/tests/editor-interactions';

const DEBUG_START_TIMEOUT_MS = 45_000;
const APP_SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Portable executable smoke testing must run on Windows');
  }

  const options = parseArguments(process.argv.slice(2));
  const executable = resolve(requiredOption(options, 'executable'));
  const fixture = resolve(requiredOption(options, 'fixture'));
  const [executableStats, fixtureStats] = await Promise.all([stat(executable), stat(fixture)]);
  if (!executableStats.isFile()) throw new Error(`Portable executable is not a file: ${executable}`);
  if (!fixtureStats.isFile()) throw new Error(`Smoke fixture is not a file: ${fixture}`);

  await smokePortableExecutable(executable, fixture);
  process.stdout.write('Portable Windows app edit/download smoke passed.\n');
}

export async function smokePortableExecutable(executable: string, fixture: string): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'pdf-scrubber-desktop-smoke-'));
  const downloadDirectory = join(temporaryRoot, 'downloads');
  await (await import('node:fs/promises')).mkdir(downloadDirectory);

  const debugPort = await reserveLoopbackPort();
  const child = spawn(executable, [
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--pdf-scrubber-smoke-save-dir=${downloadDirectory}`,
  ], { stdio: 'ignore', windowsHide: true });
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    await once(child as unknown as NodeJS.EventEmitter, 'spawn');
    const endpoint = await waitForCdpEndpoint(debugPort, child);
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('Portable app did not expose a browser context');
    page = await waitForEditorPage(context);

    const remoteRequests = await installNoNetworkGuard(page);
    const rendererCapabilities = await page.evaluate(() => ({
      require: typeof (window as Window & { require?: unknown }).require,
      process: typeof (window as Window & { process?: unknown }).process,
    }));
    expect(rendererCapabilities).toEqual({ require: 'undefined', process: 'undefined' });

    await page.getByLabel('Open PDF').setInputFiles(fixture);
    await expect(page.getByTestId('pdf-canvas')).toBeVisible({ timeout: 20_000 });

    await activateByKeyboard(page, page.getByRole('button', { name: /Target 01 — Editable/ }));
    await page.getByLabel('Edit selected text').fill('Portable desktop edit');
    await expandAllowedWidth(page);
    await acceptRichFontSubstitutions(page);
    const apply = page.getByRole('button', { name: 'Apply replacement' });
    await expect(apply).toBeEnabled({ timeout: 20_000 });
    await apply.click();
    await expect(page.getByRole('button', { name: /Portable desktop edit — Editable/ }))
      .toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Download copy' }).click();
    const downloadPath = await waitForDownloadedPdf(downloadDirectory);
    const bytes = new Uint8Array(await readFile(downloadPath));
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(0);

    const objectStore = await ObjectStore.open(bytes, PROVISIONAL_LIMITS);
    const pageAnalysis = await analysePage(objectStore, 0);
    const pageText = pageAnalysis.spans.map(({ unicode }) => unicode ?? '').join(' ');
    expect(pageText).toContain('Portable desktop edit');
    expect(remoteRequests).toEqual([]);

    await page.close();
    page = undefined;
    await browser.close().catch(() => undefined);
    browser = undefined;
    await waitForCdpShutdown(debugPort, APP_SHUTDOWN_TIMEOUT_MS);
    await waitForChildExit(child, APP_SHUTDOWN_TIMEOUT_MS);
    process.stdout.write(
      `Portable output read ${pdf.getPageCount()} page(s); edited text verified in ${downloadPath}.\n`,
    );
  } finally {
    if (page !== undefined && !page.isClosed()) await page.close().catch(() => undefined);
    if (browser !== undefined) await browser.close().catch(() => undefined);
    let cdpShutdownError: unknown;
    try {
      await waitForCdpShutdown(debugPort, APP_SHUTDOWN_TIMEOUT_MS);
    } catch (error) {
      cdpShutdownError = error;
    }
    try {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          await waitForChildExit(child, APP_SHUTDOWN_TIMEOUT_MS);
        } catch {
          await terminateOwnedChild(child);
        }
      }
    } catch (error) {
      cdpShutdownError ??= error;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    if (cdpShutdownError !== undefined) throw cdpShutdownError;
  }
}

async function reserveLoopbackPort(): Promise<number> {
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

async function waitForDownloadedPdf(directory: string): Promise<string> {
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

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
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

function assertChildExitedSuccessfully(child: ChildProcess): void {
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw new Error(
      `Portable app process did not shut down cleanly (exit=${String(child.exitCode)}, signal=${String(child.signalCode)})`,
    );
  }
}

async function terminateOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.kill()) throw new Error('Could not signal the portable app process launched by this smoke test');
  await waitForChildExit(child, 5_000);
}

function closeNetServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
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

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
