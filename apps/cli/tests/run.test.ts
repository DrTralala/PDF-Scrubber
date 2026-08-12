import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// @ts-expect-error The published runtime is intentionally plain JavaScript with JSDoc types.
import { run } from '../lib/run.js';

const originalSignalListeners = {
  SIGINT: new Set(process.listeners('SIGINT')),
  SIGTERM: new Set(process.listeners('SIGTERM')),
};

beforeEach(() => {
  removeAddedSignalListeners();
});

afterEach(() => {
  removeAddedSignalListeners();
});

describe('run', () => {
  test.each([
    { argument: '--help', output: 'Usage: pdf-scrubber [--no-open] [--port <number>]\n' },
    { argument: '--version', output: '0.0.1-test\n' },
  ])('$argument prints and exits without starting a server', async ({ argument, output }) => {
    const dependencies = createDependencies();

    await expect(run([argument], dependencies)).resolves.toBeNull();

    expect(dependencies.startServer).not.toHaveBeenCalled();
    expect(dependencies.stdout.write).toHaveBeenCalledWith(output);
  });

  test('starts the packaged app and opens exactly the running server URL', async () => {
    const dependencies = createDependencies();

    await expect(run([], dependencies)).resolves.toBe(dependencies.runningServer);

    expect(dependencies.startServer).toHaveBeenCalledWith({
      webRoot: resolve(import.meta.dirname, '../dist'),
      port: 5173,
      explicitPort: false,
    });
    expect(dependencies.openBrowser).toHaveBeenCalledOnce();
    expect(dependencies.openBrowser).toHaveBeenCalledWith(dependencies.runningServer.url);
    expect(dependencies.stdout.write).toHaveBeenCalledWith(
      `PDF-Scrubber is ready at ${dependencies.runningServer.url}\n`,
    );
  });

  test('--no-open never calls the browser opener', async () => {
    const dependencies = createDependencies();

    await run(['--no-open'], dependencies);

    expect(dependencies.openBrowser).not.toHaveBeenCalled();
  });

  test('browser opening failure prints a manual URL and leaves the server running', async () => {
    const dependencies = createDependencies();
    dependencies.openBrowser.mockRejectedValueOnce(new Error('browser unavailable'));

    await expect(run([], dependencies)).resolves.toBe(dependencies.runningServer);

    expect(dependencies.stderr.write).toHaveBeenCalledWith(
      `Open this URL manually: ${dependencies.runningServer.url}\n`,
    );
    expect(dependencies.runningServer.close).not.toHaveBeenCalled();
  });

  test('startup failure rejects and does not call the browser opener', async () => {
    const dependencies = createDependencies();
    dependencies.startServer.mockRejectedValueOnce(new Error('missing build'));

    await expect(run([], dependencies)).rejects.toThrow('missing build');

    expect(dependencies.openBrowser).not.toHaveBeenCalled();
  });

  test('installed shutdown handler closes the running server exactly once', async () => {
    const dependencies = createDependencies();
    await run([], dependencies);
    const shutdown = addedSignalListener('SIGINT');

    await shutdown('SIGINT');
    await shutdown('SIGINT');

    expect(dependencies.runningServer.close).toHaveBeenCalledOnce();
  });
});

function createDependencies() {
  const stdout = { write: vi.fn(() => true) };
  const stderr = { write: vi.fn(() => true) };
  const runningServer = {
    server: null,
    host: '127.0.0.1' as const,
    port: 61234,
    url: 'http://127.0.0.1:61234/',
    close: vi.fn(async () => undefined),
  };

  return {
    stdout,
    stderr,
    runningServer,
    startServer: vi.fn(async () => runningServer),
    openBrowser: vi.fn(async () => undefined),
    packageVersion: '0.0.1-test',
  };
}

function addedSignalListener(signal: 'SIGINT' | 'SIGTERM') {
  const listener = process
    .listeners(signal)
    .find((candidate) => !originalSignalListeners[signal].has(candidate));
  if (listener === undefined) {
    throw new Error(`No ${signal} listener was installed`);
  }
  return listener;
}

function removeAddedSignalListeners() {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!originalSignalListeners[signal].has(listener)) {
        process.off(signal, listener);
      }
    }
  }
}
