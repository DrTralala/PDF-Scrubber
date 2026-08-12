import { rm } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { Readable } from 'node:stream';
import type { EventEmitter } from 'node:events';

export type Command = Readonly<{
  executable: string;
  arguments: readonly string[];
}>;

export type OwnedChild = Pick<EventEmitter, 'off' | 'once'> & Readonly<{
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  signalCode: NodeJS.Signals | null;
  stdout: Readable;
}>;

const readinessPattern = /PDF-Scrubber is ready at (http:\/\/127\.0\.0\.1:\d+\/)\s*$/m;
const readinessBufferLimit = 64 * 1024;

export function buildNpmCommand(
  arguments_: readonly string[],
  runtime: Readonly<{ nodeExecutable: string; npmCliPath: string }>,
): Command {
  return {
    executable: runtime.nodeExecutable,
    arguments: [runtime.npmCliPath, ...arguments_],
  };
}

export function npmCliPathForRuntime(
  nodeExecutable: string,
  platform: NodeJS.Platform,
): string {
  const path = platform === 'win32' ? win32 : posix;
  return path.resolve(
    path.dirname(nodeExecutable),
    platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js',
  );
}

export function buildInstalledCliCommand(
  consumerRoot: string,
  platform: NodeJS.Platform,
  nodeExecutable: string,
): Command {
  const path = platform === 'win32' ? win32 : posix;
  return {
    executable: nodeExecutable,
    arguments: [
      path.resolve(consumerRoot, 'node_modules/pdf-scrubber/bin/pdf-scrubber.js'),
      '--no-open',
    ],
  };
}

export function waitForReadiness(child: OwnedChild, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('Timed out waiting for CLI readiness URL')), timeoutMs);
    const finish = (error?: Error, url?: string): void => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stdout.resume();
      error === undefined ? resolvePromise(url!) : reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      output = (output + chunk.toString()).slice(-readinessBufferLimit);
      const match = readinessPattern.exec(output);
      if (match !== null) finish(undefined, match[1]);
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`CLI exited before readiness (status ${code}, signal ${signal})`));
    };
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

export async function terminateOwnedChild(
  child: OwnedChild,
  options: Readonly<{
    forceSignalSupported?: boolean;
    forceTimeoutMs?: number;
    gracefulTimeoutMs?: number;
  }> = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5_000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 5_000;
  const gracefulExit = waitForChildExit(child);
  if (!child.kill('SIGTERM')) throw new Error('Failed to signal owned CLI child');
  if (await settlesWithin(gracefulExit, gracefulTimeoutMs)) return;
  if (options.forceSignalSupported === false) {
    throw new Error('Owned CLI child did not exit and forced termination is unsupported');
  }
  if (!child.kill('SIGKILL')) throw new Error('Failed to force-terminate owned CLI child');
  if (!await settlesWithin(gracefulExit, forceTimeoutMs)) {
    throw new Error('Owned CLI child did not exit after forced termination');
  }
}

export async function assertUrlUnreachable(
  url: string,
  options: Readonly<{
    attempts?: number;
    fetchImplementation?: typeof fetch;
    requestTimeoutMs?: number;
    retryDelayMs?: number;
  }> = {},
): Promise<void> {
  const attempts = options.attempts ?? 20;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 500;
  const retryDelayMs = options.retryDelayMs ?? 50;
  let refused = false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('reachability request timed out')), requestTimeoutMs);
    try {
      await fetchImplementation(url, { signal: controller.signal });
    } catch {
      if (!controller.signal.aborted) {
        refused = true;
        break;
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt + 1 < attempts) await delay(retryDelayMs);
  }

  if (!refused) throw new Error(`Owned CLI URL could not be proved unreachable: ${url}`);
}

type CleanupState = Readonly<{
  child?: OwnedChild | undefined;
  readinessUrl?: string | undefined;
  temporaryRoot: string;
}>;

type CleanupDependencies = Readonly<{
  removeTemporaryRoot(path: string): Promise<void>;
  terminateChild(child: OwnedChild): Promise<void>;
  verifyUnreachable(url: string): Promise<void>;
}>;

const defaultCleanupDependencies: CleanupDependencies = Object.freeze({
  removeTemporaryRoot: (path) => rm(path, { force: true, recursive: true }),
  terminateChild: terminateOwnedChild,
  verifyUnreachable: assertUrlUnreachable,
});

export async function cleanupCliSmoke(
  state: CleanupState,
  dependencies: CleanupDependencies = defaultCleanupDependencies,
): Promise<void> {
  const errors: unknown[] = [];
  if (state.child !== undefined) {
    await collectCleanupError(errors, () => dependencies.terminateChild(state.child!));
  }
  if (state.readinessUrl !== undefined) {
    await collectCleanupError(errors, () => dependencies.verifyUnreachable(state.readinessUrl!));
  }
  await collectCleanupError(errors, () => dependencies.removeTemporaryRoot(state.temporaryRoot));
  if (errors.length > 0) throw new AggregateError(errors, 'CLI smoke cleanup failed');
}

function waitForChildExit(child: OwnedChild): Promise<void> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      child.off('error', finish);
      child.off('exit', finish);
      resolvePromise();
    };
    child.once('error', finish);
    child.once('exit', finish);
  });
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    delay(timeoutMs).then(() => false),
  ]);
}

async function collectCleanupError(errors: unknown[], cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
