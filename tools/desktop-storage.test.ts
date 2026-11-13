import { createRequire } from 'node:module';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

type DesktopSettings = Readonly<{
  schemaVersion: 1;
  window: Readonly<{ width: number; height: number }>;
}>;

type PortablePaths = Readonly<{
  root: string;
  profile: string;
  temp: string;
  logs: string;
  crashes: string;
  settings: DesktopSettings;
}>;

type PortableDirectories = Readonly<Omit<PortablePaths, 'settings'>>;

type PortableStorage = Readonly<{
  DEFAULT_SETTINGS: DesktopSettings;
  validateSettings(value: unknown): DesktopSettings;
  preflightPortableStorage(root: string): PortableDirectories;
  preparePortableStorage(root: string): PortablePaths;
  configurePortableApp(app: unknown, paths: PortablePaths): void;
}>;

const require = createRequire(import.meta.url);
const temporaryDirectories: string[] = [];

function storage(): PortableStorage {
  return require('../apps/desktop/runtime/portable-storage.cjs') as PortableStorage;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

test('validates the documented settings schema and window bounds', () => {
  const { DEFAULT_SETTINGS, validateSettings } = storage();

  expect(validateSettings({ schemaVersion: 1, window: { width: 1280, height: 860 } }))
    .toEqual(DEFAULT_SETTINGS);
  expect(validateSettings({ schemaVersion: 1, window: { width: 760, height: 560 } }))
    .toEqual({ schemaVersion: 1, window: { width: 760, height: 560 } });
  expect(validateSettings({ schemaVersion: 1, window: { width: 16_384, height: 16_384 } }))
    .toEqual({ schemaVersion: 1, window: { width: 16_384, height: 16_384 } });
  for (const invalid of [
    { schemaVersion: 1, window: { width: 759, height: 860 } },
    { schemaVersion: 1, window: { width: 16_385, height: 860 } },
    { schemaVersion: 1, window: { width: 1280.5, height: 860 } },
    { schemaVersion: 2, window: { width: 1280, height: 860 } },
    { schemaVersion: 1, window: { width: '1280', height: 860 } },
    { schemaVersion: 1, window: { width: 1280, height: 860 }, extra: true },
    null,
  ]) {
    expect(() => validateSettings(invalid)).toThrow();
  }
});

test('creates managed directories and initialises missing settings with defaults', () => {
  const root = createPortableRoot();
  const paths = storage().preparePortableStorage(root);

  expect(paths).toMatchObject({
    root,
    profile: join(root, 'config', 'profile'),
    temp: join(root, 'config', 'temp'),
    logs: join(root, 'config', 'logs'),
    crashes: join(root, 'config', 'crashes'),
    settings: storage().DEFAULT_SETTINGS,
  });
  expect(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')))
    .toEqual(storage().DEFAULT_SETTINGS);
  for (const directory of [paths.profile, paths.temp, paths.logs, paths.crashes]) {
    expect(statSync(directory).isDirectory()).toBe(true);
  }
  expect(readdirSync(paths.temp)).toEqual([]);
  expect(readdirSync(root).sort()).toEqual(['config', 'settings.json']);
});

test('preserves valid custom dimensions and rejects malformed settings without changing bytes', () => {
  const root = createPortableRoot();
  const settingsPath = join(root, 'settings.json');
  const customBytes = Buffer.from('{"schemaVersion":1,"window":{"width":1440,"height":960}}\n');
  writeFileSync(settingsPath, customBytes);

  expect(storage().preparePortableStorage(root).settings)
    .toEqual({ schemaVersion: 1, window: { width: 1440, height: 960 } });
  expect(readFileSync(settingsPath)).toEqual(customBytes);

  const malformedBytes = Buffer.from('{"schemaVersion":1,"window":');
  writeFileSync(settingsPath, malformedBytes);
  expect(() => storage().preparePortableStorage(root)).toThrow();
  expect(readFileSync(settingsPath)).toEqual(malformedBytes);
});

test('rejects linked root, config, profile and settings paths', () => {
  const parent = createTemporaryDirectory();
  const linkedRoot = join(parent, 'linked-root');
  const actualRoot = join(parent, 'actual-root');
  mkdirSync(actualRoot);
  mkdirSync(join(actualRoot, 'config'));
  symlinkSync(actualRoot, linkedRoot, 'dir');
  expect(() => storage().preparePortableStorage(linkedRoot)).toThrow(/regular directory|reparse|symbolic/i);

  const configRoot = createPortableRoot();
  const config = join(configRoot, 'config');
  rmSync(config, { recursive: true });
  const actualConfig = join(configRoot, 'actual-config');
  mkdirSync(actualConfig);
  symlinkSync(actualConfig, config, 'dir');
  expect(() => storage().preparePortableStorage(configRoot)).toThrow(/regular directory|reparse|symbolic/i);

  const profileRoot = createPortableRoot();
  const profile = join(profileRoot, 'config', 'profile');
  const actualProfile = join(profileRoot, 'actual-profile');
  mkdirSync(actualProfile);
  symlinkSync(actualProfile, profile, 'dir');
  expect(() => storage().preparePortableStorage(profileRoot)).toThrow(/regular directory|reparse|symbolic/i);

  const settingsRoot = createPortableRoot();
  const outsideSettings = join(settingsRoot, 'outside-settings.json');
  writeFileSync(outsideSettings, '{"schemaVersion":1,"window":{"width":1280,"height":860}}');
  symlinkSync(outsideSettings, join(settingsRoot, 'settings.json'));
  expect(() => storage().preparePortableStorage(settingsRoot)).toThrow(/regular file|reparse|symbolic/i);
  expect(readFileSync(outsideSettings, 'utf8')).toContain('1280');
});

test('rejects non-directory managed storage and reports storage write failures', () => {
  const badDirectoryRoot = createPortableRoot();
  rmSync(join(badDirectoryRoot, 'config'), { recursive: true });
  writeFileSync(join(badDirectoryRoot, 'config'), 'not a directory');
  expect(() => storage().preparePortableStorage(badDirectoryRoot)).toThrow(/regular directory|directory/i);

  const unwritableRoot = createPortableRoot();
  const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
    throw permissionError;
  });
  expect(() => storage().preparePortableStorage(unwritableRoot)).toThrow(/writable|permission/i);
});

test('rejects an unwritable root even when valid settings already exist', () => {
  const root = createPortableRoot();
  const settingsPath = join(root, 'settings.json');
  const existingSettings = Buffer.from('{"schemaVersion":1,"window":{"width":1280,"height":860}}\n');
  writeFileSync(settingsPath, existingSettings);
  const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  vi.spyOn(fs, 'accessSync').mockImplementationOnce(() => {
    throw permissionError;
  });

  expect(() => storage().preparePortableStorage(root)).toThrow(/not writable/i);
  expect(readFileSync(settingsPath)).toEqual(existingSettings);
});

test('rejects an unwritable existing profile directory', () => {
  const root = createPortableRoot();
  const profile = join(root, 'config', 'profile');
  const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const accessSpy = vi.spyOn(fs, 'accessSync');
  accessSpy.mockImplementationOnce(() => undefined);
  accessSpy.mockImplementationOnce(() => {
    throw permissionError;
  });

  expect(() => storage().preparePortableStorage(root)).toThrow(/profile.*not writable/i);
});

test('preflights writable storage without creating settings before the instance lock', () => {
  const root = createPortableRoot();

  expect(storage().preflightPortableStorage(root)).toMatchObject({
    root,
    profile: join(root, 'config', 'profile'),
    temp: join(root, 'config', 'temp'),
    logs: join(root, 'config', 'logs'),
    crashes: join(root, 'config', 'crashes'),
  });
  expect(readdirSync(root)).toEqual(['config']);
});

test('configures every application-managed Electron path before a session is created', () => {
  const root = createPortableRoot();
  const paths = storage().preparePortableStorage(root);
  const calls: unknown[][] = [];
  const fakeApp = {
    setPath(name: string, value: string) {
      calls.push(['setPath', name, value]);
    },
    setAppLogsPath(value: string) {
      calls.push(['setAppLogsPath', value]);
    },
  };

  storage().configurePortableApp(fakeApp, paths);

  expect(calls).toEqual([
    ['setPath', 'userData', paths.profile],
    ['setPath', 'sessionData', paths.profile],
    ['setPath', 'temp', paths.temp],
    ['setPath', 'crashDumps', paths.crashes],
    ['setAppLogsPath', paths.logs],
  ]);
});

function createPortableRoot(): string {
  const root = createTemporaryDirectory();
  mkdirSync(join(root, 'config'));
  return root;
}

function createTemporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'pdf-scrubber-portable-storage-'));
  temporaryDirectories.push(path);
  return path;
}
