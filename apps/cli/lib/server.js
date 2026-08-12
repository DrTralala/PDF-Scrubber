import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const HOST = '127.0.0.1';

/** @typedef {{ webRoot: string, port: number, explicitPort: boolean }} StartServerOptions */
/** @typedef {{ server: import('node:http').Server, host: '127.0.0.1', port: number, url: string, close(): Promise<void> }} RunningServer */

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

export function contentTypeFor(pathname) {
  return CONTENT_TYPES.get(extname(pathname).toLowerCase()) ?? 'application/octet-stream';
}

export function resolveAssetPath(webRoot, requestUrl) {
  try {
    const rawPathname = requestUrl.split(/[?#]/, 1)[0];
    if (rawPathname === undefined) {
      return null;
    }

    const decodedRawPathname = decodeURIComponent(rawPathname);
    if (decodedRawPathname.split(/[\\/]/).includes('..')) {
      return null;
    }

    const pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
    const assetPath = resolve(webRoot, pathname === '/' ? 'index.html' : `.${pathname}`);
    const containedPath = relative(resolve(webRoot), assetPath);

    if (containedPath === '..' || containedPath.startsWith(`..${sep}`) || containedPath === '') {
      return null;
    }

    return assetPath;
  } catch {
    return null;
  }
}

/**
 * @param {StartServerOptions} options
 * @returns {Promise<RunningServer>}
 */
export async function startStaticServer(options) {
  const webRoot = await realpath(options.webRoot);
  const rootStats = await stat(webRoot);
  if (!rootStats.isDirectory()) {
    throw new Error(`Web root is not a directory: ${options.webRoot}`);
  }

  const server = createServer(async (request, response) => {
    let assetHandle;

    try {
      const assetPath = resolveAssetPath(webRoot, request.url ?? '/');
      if (assetPath === null) {
        respondNotFound(response);
        return;
      }

      assetHandle = await openRegularAsset(webRoot, assetPath);
      if (assetHandle === null) {
        respondNotFound(response);
        return;
      }

      response.writeHead(200, { 'Content-Type': contentTypeFor(assetPath) });
      await pipeline(assetHandle.createReadStream({ autoClose: false }), response);
    } catch (error) {
      if (!response.headersSent) {
        if (isNotFound(error)) {
          respondNotFound(response);
        } else {
          response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Internal Server Error');
        }
      } else if (!response.destroyed) {
        response.destroy();
      }
    } finally {
      await closeAssetHandle(assetHandle, response);
    }
  });

  try {
    await listen(server, options.port);
  } catch (error) {
    if (!isAddressInUse(error)) {
      throw error;
    }

    if (options.explicitPort) {
      throw new Error(`Port ${options.port} is already in use`, { cause: error });
    }

    await listen(server, 0);
  }

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Static server did not expose a TCP address');
  }

  let closePromise;

  return {
    server,
    host: HOST,
    port: address.port,
    url: `http://${HOST}:${address.port}/`,
    close() {
      closePromise ??= closeServer(server);
      return closePromise;
    },
  };
}

async function openRegularAsset(webRoot, assetPath) {
  let assetHandle;

  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const nonBlocking = constants.O_NONBLOCK ?? 0;
    assetHandle = await open(assetPath, constants.O_RDONLY | noFollow | nonBlocking);
    const assetStats = await assetHandle.stat();
    if (!assetStats.isFile()) {
      await assetHandle.close();
      return null;
    }

    const openedPath = await resolveOpenedPath(assetHandle, assetPath, assetStats);
    if (!isContained(webRoot, openedPath)) {
      await assetHandle.close();
      return null;
    }

    return assetHandle;
  } catch (error) {
    if (assetHandle !== undefined) {
      await assetHandle.close().catch(() => undefined);
    }
    throw error;
  }
}

async function resolveOpenedPath(assetHandle, assetPath, assetStats) {
  if (process.platform === 'linux') {
    try {
      return await realpath(`/proc/self/fd/${assetHandle.fd}`);
    } catch (error) {
      if (!isProcfsUnavailable(error)) {
        throw error;
      }
    }
  }

  // O_NOFOLLOW prevents final-component symlinks where supported. On platforms
  // without accessible /proc, require the post-open path to identify the pinned
  // descriptor. O_NONBLOCK keeps replacement FIFOs from stalling validation.
  const openedPath = await realpath(assetPath);
  const pathHandle = await open(
    openedPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const pathStats = await pathHandle.stat();
    if (assetStats.dev !== pathStats.dev || assetStats.ino !== pathStats.ino) {
      throw Object.assign(new Error('Asset changed while opening'), { code: 'ENOENT' });
    }
  } finally {
    await pathHandle.close();
  }
  return openedPath;
}

async function closeAssetHandle(assetHandle, response) {
  if (assetHandle == null) {
    return;
  }

  try {
    await assetHandle.close();
  } catch {
    if (!response.destroyed) {
      response.destroy();
    }
  }
}

function isContained(webRoot, assetPath) {
  const containedPath = relative(webRoot, assetPath);
  return containedPath !== '..' && !containedPath.startsWith(`..${sep}`) && containedPath !== '';
}

function listen(server, port) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise, reject) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }

    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function respondNotFound(response) {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not Found');
}

function isAddressInUse(error) {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

function isNotFound(error) {
  return (
    error instanceof Error &&
    'code' in error &&
    ['EACCES', 'ELOOP', 'ENOENT', 'ENOTDIR'].includes(error.code)
  );
}

function isProcfsUnavailable(error) {
  return (
    error instanceof Error &&
    'code' in error &&
    ['EACCES', 'ENOENT', 'ENOTDIR', 'ENOSYS', 'EPERM'].includes(error.code)
  );
}
