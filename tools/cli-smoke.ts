import { access, rm } from 'node:fs/promises';
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

type ChildResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
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

export async function resolveNpmCliPath(
  environment: Readonly<{ npm_execpath?: string | undefined }>,
  nodeExecutable: string,
  platform: NodeJS.Platform,
  exists: (path: string) => Promise<boolean> = pathExists,
): Promise<string> {
  const path = platform === 'win32' ? win32 : posix;
  const invoked = environment.npm_execpath;
  const candidates = [
    invoked !== undefined && /(?:^|[\\/])npm-cli\.js$/i.test(invoked) ? invoked : undefined,
    path.resolve(
      path.dirname(nodeExecutable),
      platform === 'win32'
        ? 'node_modules/npm/bin/npm-cli.js'
        : '../lib/node_modules/npm/bin/npm-cli.js',
    ),
  ].filter((candidate): candidate is string => candidate !== undefined);

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(
    'Unable to locate npm\'s JavaScript CLI. Set npm_execpath to npm-cli.js.',
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
  const gracefulWait = createChildWaiter(child, gracefulTimeoutMs, 'owned CLI child');
  if (!child.kill('SIGTERM')) {
    const error = new Error('Failed to signal owned CLI child');
    gracefulWait.cancel(error);
    await gracefulWait.promise.catch(() => undefined);
    throw error;
  }
  try {
    await gracefulWait.promise;
    return;
  } catch (error) {
    if (!isTimeoutError(error)) throw error;
  }
  if (options.forceSignalSupported === false) {
    throw new Error('Owned CLI child did not exit and forced termination is unsupported');
  }
  const forceWait = createChildWaiter(
    child,
    forceTimeoutMs,
    'owned CLI child after forced termination',
  );
  if (!child.kill('SIGKILL')) {
    const error = new Error('Failed to force-terminate owned CLI child');
    forceWait.cancel(error);
    await forceWait.promise.catch(() => undefined);
    throw error;
  }
  try {
    await forceWait.promise;
  } catch (error) {
    if (isTimeoutError(error)) throw new Error('Owned CLI child did not exit after forced termination');
    throw error;
  }
}

export function waitForOwnedChild(
  child: OwnedChild,
  timeoutMs: number,
  name: string,
): Promise<ChildResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return createChildWaiter(child, timeoutMs, name).promise;
}

export async function waitForOwnedChildOrTerminate(
  child: OwnedChild,
  timeoutMs: number,
  name: string,
  terminateOptions: Parameters<typeof terminateOwnedChild>[1] = {},
): Promise<ChildResult> {
  try {
    return await waitForOwnedChild(child, timeoutMs, name);
  } catch (waitError) {
    try {
      await terminateOwnedChild(child, terminateOptions);
    } catch (terminationError) {
      throw new AggregateError(
        [waitError, terminationError],
        `${name} wait and termination failed`,
      );
    }
    throw waitError;
  }
}

function createChildWaiter(
  child: OwnedChild,
  timeoutMs: number,
  name: string,
): Readonly<{
  cancel(error: Error): void;
  promise: Promise<ChildResult>;
}> {
  let cancel = (_error: Error): void => undefined;
  const promise = new Promise<ChildResult>((resolvePromise, reject) => {
    let settled = false;
    let lastError: Error | undefined;
    const clean = (): void => {
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const finish = (result: ChildResult): void => {
      if (settled) return;
      settled = true;
      clean();
      resolvePromise(result);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish({ code, signal });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish({ code, signal });
    };
    const onError = (error: Error): void => { lastError = error; };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clean();
      reject(new Error(
        `Timed out waiting for ${name}${lastError === undefined ? '' : ` after error: ${lastError.message}`}`,
      ));
    }, timeoutMs);
    child.once('close', onClose);
    child.once('error', onError);
    child.once('exit', onExit);
    cancel = (error): void => {
      if (settled) return;
      settled = true;
      clean();
      reject(error);
    };
  });
  return { cancel, promise };
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

export async function runWithCleanup<T>(
  run: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let result: T | undefined;
  let runError: unknown;
  try {
    result = await run();
  } catch (error) {
    runError = error;
  }

  let cleanupError: unknown;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }

  if (runError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([runError, cleanupError], 'CLI smoke run and cleanup failed');
  }
  if (runError !== undefined) throw runError;
  if (cleanupError !== undefined) throw cleanupError;
  return result!;
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Timed out waiting for');
}
