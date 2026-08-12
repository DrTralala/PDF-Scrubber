import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { win32 } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  assertUrlUnreachable,
  buildInstalledCliCommand,
  buildNpmCommand,
  cleanupCliSmoke,
  resolveNpmCliPath,
  runWithCleanup,
  terminateOwnedChild,
  waitForOwnedChild,
  waitForReadiness,
  type OwnedChild,
} from './cli-smoke';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

describe('CLI smoke command construction', () => {
  test('constructs POSIX npm and installed-bin commands as direct Node invocations', () => {
    expect(buildNpmCommand(['pack'], {
      nodeExecutable: '/usr/bin/node',
      npmCliPath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
    })).toEqual({
      executable: '/usr/bin/node',
      arguments: ['/usr/lib/node_modules/npm/bin/npm-cli.js', 'pack'],
    });
    expect(buildInstalledCliCommand('/tmp/consumer', 'linux', '/usr/bin/node')).toEqual({
      executable: '/usr/bin/node',
      arguments: ['/tmp/consumer/node_modules/pdf-scrubber/bin/pdf-scrubber.js', '--no-open'],
    });
  });

  test('constructs Windows commands without .cmd or shell parsing', () => {
    expect(buildNpmCommand(['install', 'C:\\scratch\\package.tgz'], {
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npmCliPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    })).toEqual({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      arguments: [
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
        'install',
        'C:\\scratch\\package.tgz',
      ],
    });
    expect(buildInstalledCliCommand(
      'C:\\scratch\\consumer',
      'win32',
      'C:\\Program Files\\nodejs\\node.exe',
    )).toEqual({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      arguments: [
        win32.resolve('C:\\scratch\\consumer', 'node_modules/pdf-scrubber/bin/pdf-scrubber.js'),
        '--no-open',
      ],
    });
  });

  test('prefers a valid npm_execpath on POSIX and Windows representations', async () => {
    const root = await createTemporaryDirectory();
    const posixCli = join(root, 'npm-cli.js');
    await writeFile(posixCli, '#!/usr/bin/env node');
    await expect(resolveNpmCliPath({ npm_execpath: posixCli }, '/usr/bin/node', 'linux'))
      .resolves.toBe(posixCli);

    const exists = vi.fn(async (path: string) => path === 'C:\\npm\\npm-cli.js');
    await expect(resolveNpmCliPath(
      { npm_execpath: 'C:\\npm\\npm-cli.js' },
      'C:\\node\\node.exe',
      'win32',
      exists,
    )).resolves.toBe('C:\\npm\\npm-cli.js');
  });

  test('rejects a .cmd npm_execpath and uses an existing JavaScript fallback', async () => {
    const exists = vi.fn(async (path: string) => (
      path === 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
    ));

    await expect(resolveNpmCliPath(
      { npm_execpath: 'C:\\Program Files\\nodejs\\npm.cmd' },
      'C:\\Program Files\\nodejs\\node.exe',
      'win32',
      exists,
    )).resolves.toBe('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js');
  });

  test('fails actionably when no JavaScript npm CLI can be found', async () => {
    await expect(resolveNpmCliPath(
      {},
      '/opt/node/bin/node',
      'linux',
      async () => false,
    )).rejects.toThrow('Set npm_execpath to npm-cli.js');
  });
});

describe('CLI smoke process lifecycle', () => {
  test('bounds readiness output and keeps stdout draining after the URL is found', async () => {
    const child = new FakeChild();
    const readiness = waitForReadiness(child, 100);
    child.stdout.write('x'.repeat(20_000));
    child.stdout.write('\nPDF-Scrubber is ready at http://127.0.0.1:61234/\n');

    await expect(readiness).resolves.toBe('http://127.0.0.1:61234/');
    expect(child.stdout.readableFlowing).toBe(true);
  });

  test('escalates from graceful to forced termination for only the owned child', async () => {
    const child = new FakeChild();
    child.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') child.exit(signal);
      return true;
    });

    await terminateOwnedChild(child, { gracefulTimeoutMs: 5, forceTimeoutMs: 50 });

    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });

  test('bounds the forced termination wait', async () => {
    const child = new FakeChild();

    await expect(terminateOwnedChild(child, {
      gracefulTimeoutMs: 5,
      forceTimeoutMs: 5,
    })).rejects.toThrow('did not exit after forced termination');
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });

  test('observes a synchronous exit caused by the graceful signal', async () => {
    const child = new FakeChild();
    child.kill.mockImplementation((signal) => {
      if (signal === 'SIGTERM') child.exit(signal);
      return true;
    });

    await expect(terminateOwnedChild(child, { gracefulTimeoutMs: 20 }))
      .resolves.toBeUndefined();
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
  });

  test('does not attempt unsupported forced termination', async () => {
    const child = new FakeChild();

    await expect(terminateOwnedChild(child, {
      forceSignalSupported: false,
      gracefulTimeoutMs: 5,
    })).rejects.toThrow('forced termination is unsupported');
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
  });

  test('does not treat a child error event as confirmed exit', async () => {
    const child = new FakeChild();
    const waiting = waitForOwnedChild(child, 10, 'test child');
    child.emit('error', new Error('spawn error'));

    await expect(waiting).rejects.toThrow('Timed out waiting for test child');
  });

  test('resolves child wait only after close or an already-exited state', async () => {
    const child = new FakeChild();
    const waiting = waitForOwnedChild(child, 100, 'test child');
    child.emit('close', 0, null);
    await expect(waiting).resolves.toMatchObject({ code: 0, signal: null });

    child.exitCode = 0;
    await expect(waitForOwnedChild(child, 1, 'test child'))
      .resolves.toMatchObject({ code: 0, signal: null });
  });

  test('does not treat an aborted reachability request as proof of shutdown', async () => {
    const hangingFetch: typeof fetch = vi.fn((
      _url: string | URL | Request,
      init?: RequestInit,
    ) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));

    await expect(assertUrlUnreachable('http://127.0.0.1:61234/', {
      attempts: 1,
      fetchImplementation: hangingFetch,
      requestTimeoutMs: 5,
      retryDelayMs: 0,
    })).rejects.toThrow('could not be proved unreachable');
  });

  test('attempts every cleanup stage and aggregates their failures', async () => {
    const events: string[] = [];
    const child = new FakeChild();

    await expect(cleanupCliSmoke({
      child,
      readinessUrl: 'http://127.0.0.1:61234/',
      temporaryRoot: '/tmp/opencode/owned-smoke',
    }, {
      removeTemporaryRoot: async () => {
        events.push('remove');
        throw new Error('remove failed');
      },
      terminateChild: async () => {
        events.push('terminate');
        throw new Error('terminate failed');
      },
      verifyUnreachable: async () => {
        events.push('verify');
        throw new Error('verify failed');
      },
    })).rejects.toMatchObject({ errors: expect.arrayContaining([
      expect.objectContaining({ message: 'terminate failed' }),
      expect.objectContaining({ message: 'verify failed' }),
      expect.objectContaining({ message: 'remove failed' }),
    ]) });
    expect(events).toEqual(['terminate', 'verify', 'remove']);
  });

  test('preserves the original failure together with cleanup failures', async () => {
    await expect(runWithCleanup(
      async () => { throw new Error('original failed'); },
      async () => { throw new Error('cleanup failed'); },
    )).rejects.toMatchObject({ errors: [
      expect.objectContaining({ message: 'original failed' }),
      expect.objectContaining({ message: 'cleanup failed' }),
    ] });
  });
});

class FakeChild extends EventEmitter implements OwnedChild {
  readonly stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true);

  exit(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.emit('exit', null, signal);
  }
}

async function createTemporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pdf-scrubber-cli-smoke-test-'));
  temporaryDirectories.push(root);
  return root;
}
