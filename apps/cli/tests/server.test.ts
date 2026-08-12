import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

// @ts-expect-error The published runtime is intentionally plain JavaScript with JSDoc types.
import { contentTypeFor, resolveAssetPath, startStaticServer } from '../lib/server.js';

let webRoot: string;
const runningServers: Array<Awaited<ReturnType<typeof startStaticServer>>> = [];
const blockers: Server[] = [];

beforeEach(async () => {
  webRoot = await mkdtemp(join(tmpdir(), 'pdf-scrubber-server-'));
  await mkdir(join(webRoot, 'assets'));
  await writeFile(join(webRoot, 'index.html'), '<h1>PDF-Scrubber</h1>');
  await writeFile(join(webRoot, 'assets', 'editor.woff2'), Buffer.from([1, 2, 3]));
  await writeFile(join(webRoot, 'assets', 'shape.wasm'), Buffer.from([0, 97, 115, 109]));
});

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((running) => running.close()));
  await Promise.all(blockers.splice(0).map(closeServer));
  await rm(webRoot, { recursive: true, force: true });
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
