import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, vi } from 'vitest';

import { relocatePortableApplication } from './desktop-portable-lifecycle';
import {
  createWindowsSmokeHelperExecOptions,
  parseOwnedProcessSnapshot,
  waitForOwnedProcessShutdown,
  type OwnedProcessSnapshot,
} from './desktop-portable-session';

const liveProcess: OwnedProcessSnapshot = {
  totalCount: 1,
  truncated: false,
  records: [{
    processId: 41,
    parentProcessId: 17,
    executablePath: 'C:\\temp\\extracted\\PDF-Scrubber\\config\\runtime\\PDF-Scrubber.exe',
    creationTime: '20261114120000.000000+000',
  }],
};

const noProcesses: OwnedProcessSnapshot = {
  totalCount: 0,
  truncated: false,
  records: [],
};

test('waits for owned package processes to transition from live to empty before resolving', async () => {
  let now = 0;
  let calls = 0;
  const result = await waitForOwnedProcessShutdown(async (timeoutMs) => {
    expect(timeoutMs).toBeGreaterThan(0);
    calls += 1;
    return calls === 1 ? liveProcess : noProcesses;
  }, {
    timeoutMs: 500,
    pollIntervalMs: 150,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  });

  expect(calls).toBe(2);
  expect(now).toBe(150);
  expect(result).toEqual({ initialSnapshot: liveProcess, finalSnapshot: noProcesses });
});

test('fails at the deadline with the initial and last observed owned-process snapshots', async () => {
  let now = 0;
  let calls = 0;
  await expect(waitForOwnedProcessShutdown(async () => {
    calls += 1;
    return liveProcess;
  }, {
    timeoutMs: 250,
    pollIntervalMs: 100,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  })).rejects.toMatchObject({
    name: 'OwnedProcessShutdownError',
    initialSnapshot: liveProcess,
    lastSnapshot: liveProcess,
  });
  expect(calls).toBe(3);
  expect(now).toBe(250);
});

test('uses a monotonic default clock despite a wall-clock rollback', async () => {
  let wallClock = 1_000;
  const wallClockSpy = vi.spyOn(Date, 'now').mockImplementation(() => wallClock);
  let sleeps = 0;
  try {
    await expect(waitForOwnedProcessShutdown(async () => liveProcess, {
      timeoutMs: 5,
      pollIntervalMs: 1,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) wallClock -= 60_000;
        if (sleeps === 2) wallClock = 1_006;
      },
    })).rejects.toMatchObject({ name: 'OwnedProcessShutdownError' });
    expect(wallClockSpy).not.toHaveBeenCalled();
  } finally {
    wallClockSpy.mockRestore();
  }
});

test('passes an integer timeout to the real child_process API for fractional remaining time', async () => {
  const options = createWindowsSmokeHelperExecOptions(14_999.5);
  expect(options.timeout).toBe(14_999);
  const version = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ['--version'], options, (error, stdout) => {
      if (error !== null) reject(error);
      else resolve(stdout);
    });
  });
  expect(version.trim()).toBe(process.version);
});

test('bounds helper timeouts to positive integers supported by Node', async () => {
  expect(createWindowsSmokeHelperExecOptions(0.5).timeout).toBe(1);
  expect(createWindowsSmokeHelperExecOptions(2_147_483_648).timeout).toBe(2_147_483_647);
  expect(() => createWindowsSmokeHelperExecOptions(0)).toThrow(/finite positive/);
  expect(() => createWindowsSmokeHelperExecOptions(Number.POSITIVE_INFINITY)).toThrow(/finite positive/);
});

test('fails closed on a process-query error and preserves the last trusted snapshot and cause', async () => {
  const denied = new Error('Win32_Process query denied');
  let calls = 0;
  await expect(waitForOwnedProcessShutdown(async () => {
    calls += 1;
    if (calls === 1) return liveProcess;
    throw denied;
  }, {
    timeoutMs: 500,
    pollIntervalMs: 100,
    now: () => 0,
    sleep: async () => undefined,
  })).rejects.toMatchObject({
    name: 'OwnedProcessQueryError',
    initialSnapshot: liveProcess,
    lastSnapshot: liveProcess,
    cause: denied,
  });
  expect(calls).toBe(2);
});

test('rejects malformed process-snapshot JSON and records outside the bounded schema', async () => {
  expect(parseOwnedProcessSnapshot(JSON.stringify({
    operation: 'SnapshotOwnedProcesses',
    totalCount: 1,
    truncated: false,
    records: [{
      processId: 41,
      parentProcessId: 17,
      executablePath: 'C:\\temp\\PDF-Scrubber.exe',
      creationTime: '20261114120000.000000+000',
    }],
  }))).toEqual({
    totalCount: 1,
    truncated: false,
    records: [{
      processId: 41,
      parentProcessId: 17,
      executablePath: 'C:\\temp\\PDF-Scrubber.exe',
      creationTime: '20261114120000.000000+000',
    }],
  });
  expect(() => parseOwnedProcessSnapshot('{not json')).toThrow(/JSON/i);
  expect(() => parseOwnedProcessSnapshot(JSON.stringify({
    operation: 'SnapshotOwnedProcesses',
    totalCount: 1,
    truncated: false,
    records: [{ ...liveProcess.records[0], commandLine: 'must not be logged' }],
  }))).toThrow(/schema|record/i);
  const excessRecords = Array.from({ length: 33 }, (_unused, index) => ({
    processId: index + 1,
    parentProcessId: 17,
    executablePath: 'C:\\temp\\PDF-Scrubber.exe',
    creationTime: null,
  }));
  expect(() => parseOwnedProcessSnapshot(JSON.stringify({
    operation: 'SnapshotOwnedProcesses',
    totalCount: 33,
    truncated: true,
    records: excessRecords,
  }))).toThrow(/bounded schema/i);
});

test('emits initial and final snapshots immediately around the relocation boundary', async () => {
  let now = 0;
  let queries = 0;
  const reports: Readonly<Record<string, unknown>>[] = [];
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'pdf-scrubber-relocation-test-'));
  const sourceRoot = join(temporaryRoot, 'extracted', 'PDF-Scrubber');
  const destinationRoot = join(temporaryRoot, 'Moved portable application with spaces and café');
  const settings = join(sourceRoot, 'settings.json');
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(settings, 'relocation payload\n');
    let destinationExistedDuringLastQuery = false;

    await relocatePortableApplication(sourceRoot, destinationRoot, join(sourceRoot, 'PDF-Scrubber.exe'), {
      queryOwnedProcesses: async () => {
        queries += 1;
        if (queries === 1) return liveProcess;
        try {
          await stat(destinationRoot);
          destinationExistedDuringLastQuery = true;
        } catch {
          destinationExistedDuringLastQuery = false;
        }
        return noProcesses;
      },
      report: (record) => { reports.push(record); },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      timeoutMs: 500,
      pollIntervalMs: 150,
    });

    expect(queries).toBe(2);
    expect(destinationExistedDuringLastQuery).toBe(false);
    await expect(readFile(join(destinationRoot, 'settings.json'), 'utf8')).resolves.toBe('relocation payload\n');
    await expect(stat(sourceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(reports.find(({ event }) => event === 'portable-owned-process-shutdown')).toMatchObject({
      initialSnapshot: liveProcess,
      finalSnapshot: noProcesses,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('does not attempt relocation if owned processes persist through the deadline', async () => {
  let now = 0;
  let renamed = false;
  const reports: Readonly<Record<string, unknown>>[] = [];
  await expect(relocatePortableApplication('C:\\temp\\app', 'C:\\temp\\moved', 'C:\\temp\\app\\PDF-Scrubber.exe', {
    queryOwnedProcesses: async () => liveProcess,
    renameDirectory: async () => { renamed = true; },
    report: (record) => { reports.push(record); },
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    timeoutMs: 200,
    pollIntervalMs: 100,
  })).rejects.toMatchObject({
    name: 'OwnedProcessShutdownError',
    initialSnapshot: liveProcess,
    lastSnapshot: liveProcess,
  });
  expect(renamed).toBe(false);
  expect(reports.find(({ event }) => event === 'portable-owned-process-shutdown-failed')).toMatchObject({
    initialSnapshot: liveProcess,
    lastSnapshot: liveProcess,
  });
});

test('does not attempt relocation when the owned-process query is denied', async () => {
  const denied = new Error('Win32_Process query denied');
  const reports: Readonly<Record<string, unknown>>[] = [];
  let renamed = false;
  await expect(relocatePortableApplication('C:\\temp\\app', 'C:\\temp\\moved', 'C:\\temp\\app\\PDF-Scrubber.exe', {
    queryOwnedProcesses: async () => { throw denied; },
    renameDirectory: async () => { renamed = true; },
    report: (record) => { reports.push(record); },
    now: () => 0,
    sleep: async () => undefined,
  })).rejects.toMatchObject({ name: 'OwnedProcessQueryError', cause: denied });
  expect(renamed).toBe(false);
  expect(reports.find(({ event }) => event === 'portable-owned-process-shutdown-failed')).toMatchObject({
    error: { name: 'OwnedProcessQueryError' },
  });
});

test('queries again after rename failure and preserves the original error as cause with its fields', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'pdf-scrubber-relocation-failure-test-'));
  const sourceRoot = join(temporaryRoot, 'app');
  const destinationRoot = join(temporaryRoot, 'moved');

  const renameFailure = Object.assign(new Error('rename denied'), {
    code: 'EPERM',
    syscall: 'rename',
    path: sourceRoot,
    dest: destinationRoot,
  });
  const events: string[] = [];
  const reports: Readonly<Record<string, unknown>>[] = [];
  let queries = 0;

  try {
    await mkdir(sourceRoot);
    const result = relocatePortableApplication(sourceRoot, destinationRoot, join(sourceRoot, 'PDF-Scrubber.exe'), {
      queryOwnedProcesses: async () => {
        queries += 1;
        events.push(`query-${queries}`);
        return queries === 1 ? noProcesses : liveProcess;
      },
      renameDirectory: async () => {
        events.push('rename');
        throw renameFailure;
      },
      report: (record) => { reports.push(record); },
      now: () => 0,
      sleep: async () => undefined,
    });

    await expect(result).rejects.toMatchObject({
      name: 'PortableRelocationError',
      code: 'EPERM',
      syscall: 'rename',
      path: renameFailure.path,
      dest: renameFailure.dest,
      cause: renameFailure,
      processSnapshot: liveProcess,
      rootAttributes: { exists: true, isDirectory: true },
    });
    expect(events).toEqual(['query-1', 'rename', 'query-2']);
    expect(reports.map(({ event }) => event)).toContain('portable-relocation-failed');
    expect(reports.find(({ event }) => event === 'portable-relocation-failed')).toMatchObject({
      renameError: { code: 'EPERM', syscall: 'rename', path: renameFailure.path, dest: destinationRoot },
      processSnapshot: liveProcess,
      rootAttributes: { exists: true, isDirectory: true },
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('does not replace the rename failure when the diagnostic process query also fails', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'pdf-scrubber-relocation-query-failure-test-'));
  const sourceRoot = join(temporaryRoot, 'app');
  const destinationRoot = join(temporaryRoot, 'moved');

  const renameFailure = Object.assign(new Error('rename denied'), {
    code: 'EPERM',
    path: sourceRoot,
    dest: destinationRoot,
  });
  const queryFailure = new Error('snapshot query denied');
  const handleFailure = new Error('Handle diagnostic timed out');
  let queries = 0;
  const events: string[] = [];
  const reports: Readonly<Record<string, unknown>>[] = [];

  try {
    await mkdir(sourceRoot);
    const result = relocatePortableApplication(sourceRoot, destinationRoot, join(sourceRoot, 'PDF-Scrubber.exe'), {
      queryOwnedProcesses: async () => {
        queries += 1;
        events.push(`query-${queries}`);
        if (queries === 1) return noProcesses;
        throw queryFailure;
      },
      renameDirectory: async () => {
        events.push('rename');
        throw renameFailure;
      },
      handleDiagnostic: async () => {
        events.push('handle');
        throw handleFailure;
      },
      report: (record) => { reports.push(record); },
      now: () => 0,
      sleep: async () => undefined,
    });

    await expect(result).rejects.toMatchObject({
      name: 'PortableRelocationError',
      code: 'EPERM',
      path: sourceRoot,
      dest: destinationRoot,
      cause: renameFailure,
      processSnapshotError: expect.objectContaining({ message: 'snapshot query denied' }),
    });
    expect(queries).toBe(2);
    expect(events).toEqual(['query-1', 'rename', 'handle', 'query-2']);
    expect(reports.find(({ event }) => event === 'portable-relocation-failed')).toMatchObject({
      renameError: { code: 'EPERM' },
      processSnapshotError: { message: 'snapshot query denied' },
      handleDiagnostic: {
        status: 'failed',
        error: { message: 'Handle diagnostic timed out' },
      },
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
