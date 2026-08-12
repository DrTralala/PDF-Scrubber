import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import open from 'open';

import { parseArguments, usage } from './arguments.js';
import { startStaticServer } from './server.js';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {{
 *   startServer?: typeof startStaticServer,
 *   openBrowser?: (url: string) => Promise<unknown>,
 *   stdout?: Pick<NodeJS.WriteStream, 'write'>,
 *   stderr?: Pick<NodeJS.WriteStream, 'write'>,
 *   packageVersion?: string,
 * }} RunDependencies
 */

/**
 * @param {readonly string[]} argv
 * @param {RunDependencies} [dependencies]
 */
export async function run(argv, dependencies = {}) {
  const parsed = parseArguments(argv);
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  if (parsed.command === 'help') {
    stdout.write(`${usage()}\n`);
    return null;
  }

  if (parsed.command === 'version') {
    stdout.write(`${dependencies.packageVersion ?? (await readPackageVersion())}\n`);
    return null;
  }

  const startServer = dependencies.startServer ?? startStaticServer;
  const runningServer = await startServer({
    webRoot: resolve(cliRoot, 'dist'),
    port: parsed.port,
    explicitPort: parsed.explicitPort,
  });

  let managedServer;

  try {
    managedServer = createManagedServer(runningServer, stderr);
    stdout.write(`PDF-Scrubber is ready at ${managedServer.url}\n`);

    if (parsed.openBrowser) {
      try {
        await (dependencies.openBrowser ?? open)(managedServer.url);
      } catch {
        stderr.write(`Open this URL manually: ${managedServer.url}\n`);
      }
    }

    return managedServer;
  } catch (error) {
    await (managedServer?.close() ?? runningServer.close()).catch(() => undefined);
    throw error;
  }
}

async function readPackageVersion() {
  const packageJson = JSON.parse(await readFile(resolve(cliRoot, 'package.json'), 'utf8'));
  if (typeof packageJson.version !== 'string') {
    throw new Error('CLI package version is unavailable');
  }
  return packageJson.version;
}

function createManagedServer(runningServer, stderr) {
  const closeServer = runningServer.close.bind(runningServer);
  let shutdownPromise;

  const removeHandlers = () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  };
  const close = () => {
    removeHandlers();
    shutdownPromise ??= closeServer();
    return shutdownPromise;
  };
  const shutdown = () =>
    close().catch((error) => {
      try {
        stderr.write(`Failed to shut down PDF-Scrubber: ${errorMessage(error)}\n`);
      } catch {
        // Signal shutdown must never create an unhandled rejection.
      }
      process.exitCode = 1;
    });

  try {
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    removeHandlers();
    throw error;
  }

  return {
    server: runningServer.server,
    host: runningServer.host,
    port: runningServer.port,
    url: runningServer.url,
    close,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
