import { constants, copyFileSync, existsSync, rmSync } from 'node:fs';
import { open, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fsMockState = vi.hoisted(() => ({ procfsUnavailable: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: vi.fn(async (path: Parameters<typeof actual.realpath>[0]) => {
      if (fsMockState.procfsUnavailable && String(path).startsWith('/proc/self/fd/')) {
        throw Object.assign(new Error('procfs unavailable'), { code: 'EACCES' });
      }
      return actual.realpath(path);
    }),
  };
});

// @ts-expect-error The published runtime is intentionally plain JavaScript with JSDoc types.
import { contentTypeFor, resolveAssetPath, startStaticServer } from '../lib/server.js';

let webRoot: string;
let outsideRoot: string;
const runningServers: Array<Awaited<ReturnType<typeof startStaticServer>>> = [];
const blockers: Server[] = [];
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  fsMockState.procfsUnavailable = false;
  webRoot = await mkdtemp(join(tmpdir(), 'pdf-scrubber-server-'));
  outsideRoot = await mkdtemp(join(tmpdir(), 'pdf-scrubber-outside-'));
  await mkdir(join(webRoot, 'assets'));
  await writeFile(join(webRoot, 'index.html'), '<h1>PDF-Scrubber</h1>');
  await writeFile(join(webRoot, 'assets', 'editor.woff2'), Buffer.from([1, 2, 3]));
  await writeFile(join(webRoot, 'assets', 'shape.wasm'), Buffer.from([0, 97, 115, 109]));
});

afterEach(async () => {
  fsMockState.procfsUnavailable = false;
  vi.restoreAllMocks();
  await Promise.all(runningServers.splice(0).map((running) => running.close()));
  await Promise.all(blockers.splice(0).map(closeServer));
  await Promise.all([
    rm(webRoot, { recursive: true, force: true }),
    rm(outsideRoot, { recursive: true, force: true }),
  ]);
});

describe('contentTypeFor', () => {
  test('identifies JavaScript modules', () => {
    expect(contentTypeFor('app.mjs')).toBe('text/javascript; charset=utf-8');
  });

  test('identifies WebAssembly', () => {
    expect(contentTypeFor('shape.wasm')).toBe('application/wasm');
  });
});

describe('resolveAssetPath', () => {
  test('maps the root URL to index.html', () => {
    expect(resolveAssetPath(webRoot, '/')).toBe(resolve(webRoot, 'index.html'));
  });

  test('rejects traversal outside the web root', () => {
    expect(resolveAssetPath(webRoot, '/../secret')).toBeNull();
  });

  test('rejects encoded traversal outside the web root', () => {
    expect(resolveAssetPath(webRoot, '/%2e%2e/secret')).toBeNull();
  });

  test('rejects traversal hidden behind encoded delimiters', () => {
    expect(resolveAssetPath(webRoot, '/dir%3F/%2e%2e%2fsecret')).toBeNull();
    expect(resolveAssetPath(webRoot, '/dir%23/%2e%2e%2fsecret')).toBeNull();
  });
});

test('serves regular app assets on IPv4 loopback with correct content types', async () => {
  const running = await startTrackedServer(0, true);

  expect(running.host).toBe('127.0.0.1');
  expect(running.server.address()).toMatchObject({ address: '127.0.0.1' });

  const indexResponse = await fetch(running.url);
  expect(indexResponse.status).toBe(200);
  expect(indexResponse.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(await indexResponse.text()).toBe('<h1>PDF-Scrubber</h1>');

  const fontResponse = await fetch(new URL('assets/editor.woff2', running.url));
  expect(fontResponse.status).toBe(200);
  expect(fontResponse.headers.get('content-type')).toBe('font/woff2');

  const wasmResponse = await fetch(new URL('assets/shape.wasm', running.url));
  expect(wasmResponse.status).toBe(200);
  expect(wasmResponse.headers.get('content-type')).toBe('application/wasm');
});

test('returns 404 for unknown assets and directories', async () => {
  const running = await startTrackedServer(0, true);

  expect((await fetch(new URL('missing.js', running.url))).status).toBe(404);
  expect((await fetch(new URL('assets/', running.url))).status).toBe(404);
});

test('does not serve a symlink whose target escapes the web root', async (context) => {
  const outsidePath = join(outsideRoot, 'secret.txt');
  await writeFile(outsidePath, 'external secret');
  try {
    await symlink(outsidePath, join(webRoot, 'assets', 'escape.txt'));
  } catch (error) {
    if (isWindowsSymlinkPrivilegeError(error)) {
      context.skip();
      return;
    }
    throw error;
  }
  const running = await startTrackedServer(0, true);

  const response = await fetch(new URL('assets/escape.txt', running.url));

  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain('external secret');
});

test('streams from a pinned descriptor when the pathname is replaced after validation', async (context) => {
  const assetPath = join(webRoot, 'assets', 'race.txt');
  const outsidePath = join(outsideRoot, 'race.txt');
  await writeFile(assetPath, 'safe bytes');
  await writeFile(outsidePath, 'external bytes');
  if (!(await canReplaceOpenPath(assetPath))) {
    context.skip();
    return;
  }
  const { prototype, originalCreateReadStream } = await fileHandleStreamPrototype(assetPath);
  const createReadStream = vi
    .spyOn(prototype, 'createReadStream')
    .mockImplementation(function (this: typeof prototype, options) {
      rmSync(assetPath);
      copyFileSync(outsidePath, assetPath);
      return originalCreateReadStream.call(this, options);
    });
  const running = await startTrackedServer(0, true);

  const response = await fetch(new URL('assets/race.txt', running.url));

  expect(createReadStream).toHaveBeenCalledOnce();
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('safe bytes');
});

test.skipIf(process.platform !== 'linux')(
  'falls back to descriptor and pathname identity when procfs is unavailable',
  async () => {
    fsMockState.procfsUnavailable = true;
    const running = await startTrackedServer(0, true);

    const response = await fetch(running.url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>PDF-Scrubber</h1>');
  },
);

test.skipIf(process.platform !== 'linux')(
  'rejects pathname replacement during procfs fallback identity validation',
  async () => {
    const assetPath = join(webRoot, 'assets', 'fallback-race.txt');
    const outsidePath = join(outsideRoot, 'fallback-race.txt');
    await writeFile(assetPath, 'safe bytes');
    await writeFile(outsidePath, 'external bytes');
    const { prototype, originalStat } = await fileHandlePrototype(assetPath);
    vi.spyOn(prototype, 'stat').mockImplementationOnce(async function (this: typeof prototype) {
      const assetStats = await originalStat.call(this);
      rmSync(assetPath);
      copyFileSync(outsidePath, assetPath);
      return assetStats;
    });
    fsMockState.procfsUnavailable = true;
    const running = await startTrackedServer(0, true);

    const response = await fetch(new URL('assets/fallback-race.txt', running.url));

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('external bytes');
  },
);

test.skipIf(process.platform === 'win32')(
  'returns promptly for a stable FIFO without serving it',
  async () => {
    const fifoPath = join(webRoot, 'assets', 'stable-fifo');
    await execFileAsync('mkfifo', [fifoPath]);
    const running = await startTrackedServer(0, true);
    const rescue = setTimeout(() => {
      void open(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK)
        .then((handle) => handle.close())
        .catch(() => undefined);
    }, 1_000);

    const response = await fetch(new URL('assets/stable-fifo', running.url), {
      signal: AbortSignal.timeout(500),
    });
    clearTimeout(rescue);
    expect(response.status).toBe(404);
  },
);

test('contains asynchronous file-read failures and keeps serving', async () => {
  const assetPath = join(webRoot, 'index.html');
  const { prototype } = await fileHandleStreamPrototype(assetPath);
  const createReadStream = vi
    .spyOn(prototype, 'createReadStream')
    .mockImplementationOnce(
      () =>
        new Readable({
          read() {
            queueMicrotask(() => this.destroy(new Error('forced asynchronous read failure')));
          },
        }) as ReturnType<(typeof prototype)['createReadStream']>,
    );
  const running = await startTrackedServer(0, true);

  await expect(fetch(running.url).then((response) => response.text())).rejects.toThrow();
  expect(createReadStream).toHaveBeenCalledOnce();
  expect((await fetch(new URL('assets/shape.wasm', running.url))).status).toBe(200);
});

test('shutdown is idempotent', async () => {
  const running = await startTrackedServer(0, true);

  await running.close();
  await expect(running.close()).resolves.toBeUndefined();
});

test('rejects startup when the built web root is unavailable', async () => {
  await expect(
    startStaticServer({
      webRoot: join(webRoot, 'missing-dist'),
      port: 0,
      explicitPort: true,
    }),
  ).rejects.toThrow();
});

test('falls back once to an ephemeral port when default port 5173 is occupied', async () => {
  await occupy5173IfAvailable();

  const running = await startTrackedServer(5173, false);

  expect(running.port).not.toBe(5173);
  expect(running.url).toBe(`http://127.0.0.1:${running.port}/`);
  expect((await fetch(running.url)).status).toBe(200);
});

test('rejects a requested occupied port when the port was explicit', async () => {
  await occupy5173IfAvailable();

  await expect(startStaticServer({ webRoot, port: 5173, explicitPort: true })).rejects.toThrow(
    'Port 5173 is already in use',
  );
});

async function startTrackedServer(port: number, explicitPort: boolean) {
  const running = await startStaticServer({ webRoot, port, explicitPort });
  runningServers.push(running);
  return running;
}

async function occupy5173IfAvailable() {
  const blocker = createServer();

  try {
    await listen(blocker, 5173);
    blockers.push(blocker);
  } catch (error) {
    if (!isAddressInUse(error)) {
      throw error;
    }
  }
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function isAddressInUse(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

function isWindowsSymlinkPrivilegeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    process.platform === 'win32' &&
    error instanceof Error &&
    'code' in error &&
    ['EACCES', 'EPERM'].includes(String(error.code))
  );
}

async function fileHandleStreamPrototype(assetPath: string) {
  const { prototype, originalCreateReadStream } = await fileHandlePrototype(assetPath);
  return { prototype, originalCreateReadStream };
}

async function fileHandlePrototype(assetPath: string) {
  const fileHandle = await open(assetPath, 'r');
  const prototype = Object.getPrototypeOf(fileHandle) as Pick<
    typeof fileHandle,
    'createReadStream' | 'stat'
  >;
  const originalCreateReadStream = prototype.createReadStream;
  const originalStat = prototype.stat;
  await fileHandle.close();
  return { prototype, originalCreateReadStream, originalStat };
}

async function canReplaceOpenPath(assetPath: string) {
  const probePath = `${assetPath}.replacement-probe`;
  const fileHandle = await open(assetPath, 'r');
  copyFileSync(assetPath, probePath);
  try {
    try {
      rmSync(assetPath);
      copyFileSync(probePath, assetPath);
      return true;
    } catch (error) {
      if (isWindowsOpenPathReplacementError(error)) {
        return false;
      }
      throw error;
    }
  } finally {
    await fileHandle.close();
    if (!existsSync(assetPath)) {
      copyFileSync(probePath, assetPath);
    }
    rmSync(probePath, { force: true });
  }
}

function isWindowsOpenPathReplacementError(error: unknown): error is NodeJS.ErrnoException {
  return (
    process.platform === 'win32' &&
    error instanceof Error &&
    'code' in error &&
    ['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code))
  );
}
