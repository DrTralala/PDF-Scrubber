import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';

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
    const decodedRequestUrl = decodeURIComponent(requestUrl);
    if (decodedRequestUrl.split(/[?#]/, 1)[0].split(/[\\/]/).includes('..')) {
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
  const rootStats = await lstat(webRoot);
  if (!rootStats.isDirectory()) {
    throw new Error(`Web root is not a directory: ${options.webRoot}`);
  }

  const server = createServer(async (request, response) => {
    try {
      const assetPath = resolveAssetPath(webRoot, request.url ?? '/');
      if (assetPath === null) {
        respondNotFound(response);
        return;
      }

      const realAssetPath = await realpath(assetPath);
      if (!isContained(webRoot, realAssetPath)) {
        respondNotFound(response);
        return;
      }

      const assetStats = await lstat(realAssetPath);
      if (!assetStats.isFile()) {
        respondNotFound(response);
        return;
      }

      response.writeHead(200, { 'Content-Type': contentTypeFor(realAssetPath) });
      createReadStream(realAssetPath).pipe(response);
    } catch (error) {
      if (isNotFound(error)) {
        respondNotFound(response);
        return;
      }

      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Internal Server Error');
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
  return error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(error.code);
}
