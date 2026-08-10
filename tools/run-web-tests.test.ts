import { EventEmitter } from 'node:events';

import { describe, expect, test, vi } from 'vitest';

import {
  launchPlaywright,
  parseWebTestArguments,
  runWebTests,
  type WebTestChild,
  type WebTestSpawn,
} from './run-web-tests';

const ENVIRONMENT: NodeJS.ProcessEnv = {
  PDF_SCRUBBER_COMMITTED_PDF_MODE: 'routine',
};

function fakeChild(): EventEmitter {
  return new EventEmitter();
}

function fakeSpawn(child: EventEmitter) {
  return vi.fn<WebTestSpawn>(() => child as unknown as WebTestChild);
}

describe('web test wrapper', () => {
  test('uses routine mode and forwards ordinary Playwright arguments unchanged', () => {
    expect(parseWebTestArguments(['editor.spec.ts', '--grep', 'downloads'])).toEqual({
      mode: 'routine',
      playwrightArguments: ['editor.spec.ts', '--grep', 'downloads'],
    });
  });

  test('consumes exactly one --full while preserving every other argument', () => {
    expect(parseWebTestArguments(['--project', 'chromium', '--full', '--workers=1'])).toEqual({
      mode: 'full',
      playwrightArguments: ['--project', 'chromium', '--workers=1'],
    });
    expect(() => parseWebTestArguments(['--full', '--full'])).toThrow(/only once/);
  });

  test('sets full mode and returns the Playwright child exit status', async () => {
    const launch = vi.fn(async () => 7);

    await expect(runWebTests(['--full', 'committed-pdf-suites.spec.ts'], { launch }))
      .resolves.toBe(7);
    expect(launch).toHaveBeenCalledWith(
      ['test', '--config', 'apps/web/playwright.config.ts', 'committed-pdf-suites.spec.ts'],
      expect.objectContaining({ PDF_SCRUBBER_COMMITTED_PDF_MODE: 'full' }),
    );
  });

  test('sets routine mode and preserves path, grep, project, reporter, and worker arguments', async () => {
    const launch = vi.fn(async () => 0);
    const arguments_ = [
      'apps/web/tests/editor.spec.ts',
      '--grep',
      'downloads',
      '--project',
      'chromium',
      '--reporter=line',
      '--workers=1',
    ];

    await expect(runWebTests(arguments_, { launch })).resolves.toBe(0);
    expect(launch).toHaveBeenCalledWith(
      ['test', '--config', 'apps/web/playwright.config.ts', ...arguments_],
      expect.objectContaining({ PDF_SCRUBBER_COMMITTED_PDF_MODE: 'routine' }),
    );
  });

  test('resolves a numeric status from the production child close lifecycle', async () => {
    const child = fakeChild();
    const spawn = fakeSpawn(child);
    const forwardedArguments = ['test', '--grep', 'downloads; echo unsafe'];

    const result = launchPlaywright(forwardedArguments, ENVIRONMENT, spawn);
    child.emit('close', 7, null);

    await expect(result).resolves.toBe(7);
    const call = spawn.mock.calls[0];
    if (!call) throw new Error('spawn was not called');
    expect(call[0]).toBe(process.execPath);
    expect(call[1].slice(1)).toEqual(forwardedArguments);
    expect(call[1][0]).toMatch(/node_modules[\\/]@playwright[\\/]test[\\/]cli\.js$/);
    expect(call[2]).toMatchObject({
      cwd: process.cwd(),
      env: ENVIRONMENT,
      stdio: 'inherit',
    });
    expect(call[2].shell).toBe(false);
  });

  test('rejects a production child close with null status and no signal', async () => {
    const child = fakeChild();
    const result = launchPlaywright([], ENVIRONMENT, fakeSpawn(child));

    child.emit('close', null, null);

    await expect(result).rejects.toThrow('Playwright exited with null status');
  });

  test('rejects a production child close with a signal', async () => {
    const child = fakeChild();
    const result = launchPlaywright([], ENVIRONMENT, fakeSpawn(child));

    child.emit('close', null, 'SIGTERM');

    await expect(result).rejects.toThrow('Playwright terminated by SIGTERM');
  });

  test('propagates a production child error event', async () => {
    const child = fakeChild();
    const result = launchPlaywright([], ENVIRONMENT, fakeSpawn(child));
    const failure = new Error('spawn failed');

    child.emit('error', failure);

    await expect(result).rejects.toBe(failure);
  });

  test('rejects when the injected spawn boundary throws synchronously', async () => {
    const failure = new Error('spawn invocation failed');
    const spawn = vi.fn<WebTestSpawn>(() => {
      throw failure;
    });

    await expect(launchPlaywright([], ENVIRONMENT, spawn)).rejects.toBe(failure);
  });

  test('settles once when child error and close events race', async () => {
    const errorFirstChild = fakeChild();
    const errorFirst = launchPlaywright([], ENVIRONMENT, fakeSpawn(errorFirstChild));
    const failure = new Error('error won the race');
    errorFirstChild.emit('error', failure);
    errorFirstChild.emit('close', 7, null);
    await expect(errorFirst).rejects.toBe(failure);

    const closeFirstChild = fakeChild();
    const closeFirst = launchPlaywright([], ENVIRONMENT, fakeSpawn(closeFirstChild));
    closeFirstChild.emit('close', 0, null);
    closeFirstChild.emit('error', new Error('late error must be ignored'));
    await expect(closeFirst).resolves.toBe(0);
  });
});
