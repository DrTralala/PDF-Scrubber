import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { expect, test } from 'vitest';

type ConfigurationErrorInstance = Error & Readonly<{
  problem: string;
  line?: number;
  column?: number;
}>;

type ConfigurationErrorApi = Readonly<{
  ConfigurationError: new (
    problem: string,
    options?: Readonly<{ line?: number; column?: number; cause?: unknown }>,
  ) => ConfigurationErrorInstance;
  formatConfigurationError(error: unknown): Readonly<{ title: string; message: string }>;
  showConfigurationError(
    error: unknown,
    dependencies: Readonly<{
      dialog: Readonly<{ showErrorBox(title: string, message: string): void }>;
      app: Readonly<{ exit(code: number): void }>;
    }>,
  ): boolean;
}>;

const require = createRequire(import.meta.url);
const configurationErrorPath = resolve(import.meta.dirname, '../apps/desktop/runtime/configuration-error.cjs');

function configurationErrors(): ConfigurationErrorApi {
  expect(existsSync(configurationErrorPath), 'the shared configuration-error module exists').toBe(true);
  return require(configurationErrorPath) as ConfigurationErrorApi;
}

test('formats only safe configuration details and includes a trusted parser location', () => {
  const { ConfigurationError, formatConfigurationError } = configurationErrors();
  const error = new ConfigurationError('Invalid JSON.', {
    line: 4,
    column: 12,
    cause: new Error('raw settings text and stack details'),
  });

  expect(formatConfigurationError(error)).toEqual({
    title: 'PDF-Scrubber — Configuration error',
    message: 'File: settings.json\nProblem: Invalid JSON.\nLocation: line 4, column 12\n\nCorrect the file and restart PDF-Scrubber.\nYour settings have not been changed.',
  });
  expect(formatConfigurationError(error).message).not.toContain('raw settings text');
});

test('omits an unavailable parser location and rejects unsupported formatting inputs', () => {
  const { ConfigurationError, formatConfigurationError } = configurationErrors();
  const formatted = formatConfigurationError(new ConfigurationError('Invalid JSON.'));

  expect(formatted.message).toBe(
    'File: settings.json\nProblem: Invalid JSON.\n\nCorrect the file and restart PDF-Scrubber.\nYour settings have not been changed.',
  );
  expect(() => formatConfigurationError(new Error('unrelated error')))
    .toThrow(/ConfigurationError/);
  expect(() => new ConfigurationError('Invalid JSON.', { line: 0, column: 1 }))
    .toThrow(/positive/);
});

test('shows the standard error box synchronously and exits with status 1 afterwards', () => {
  const { ConfigurationError, showConfigurationError } = configurationErrors();
  const calls: unknown[][] = [];
  const shown = showConfigurationError(new ConfigurationError('Invalid JSON.'), {
    dialog: { showErrorBox: (title, message) => calls.push(['dialog', title, message]) },
    app: { exit: (code) => calls.push(['exit', code]) },
  });

  expect(shown).toBe(true);
  expect(calls).toEqual([
    ['dialog', 'PDF-Scrubber — Configuration error', 'File: settings.json\nProblem: Invalid JSON.\n\nCorrect the file and restart PDF-Scrubber.\nYour settings have not been changed.'],
    ['exit', 1],
  ]);
});

test('exits after a dialog failure and leaves unrelated errors to existing startup handling', () => {
  const { ConfigurationError, showConfigurationError } = configurationErrors();
  const calls: string[] = [];
  expect(() => showConfigurationError(new ConfigurationError('Invalid JSON.'), {
    dialog: {
      showErrorBox: () => {
        calls.push('dialog');
        throw new Error('dialog failed');
      },
    },
    app: { exit: (code) => calls.push(`exit:${code}`) },
  })).toThrow('dialog failed');
  expect(calls).toEqual(['dialog', 'exit:1']);
  expect(showConfigurationError(new Error('unrelated failure'), {
    dialog: { showErrorBox: () => calls.push('unexpected dialog') },
    app: { exit: () => calls.push('unexpected exit') },
  })).toBe(false);
});

test('routes invalid settings through the real bootstrap before editor startup', () => {
  configurationErrors();
  const root = mkdtempSync(join(tmpdir(), 'pdf-scrubber-invalid-startup-'));
  const configDirectory = join(root, 'config');
  const settingsPath = join(root, 'settings.json');
  const invalidBytes = Buffer.from('{"schemaVersion":1,"window":', 'utf8');
  mkdirSync(configDirectory);
  writeFileSync(settingsPath, invalidBytes);

  const calls: unknown[][] = [];
  const appEvents: string[] = [];
  let whenReadyCalls = 0;
  let browserWindowCreations = 0;
  const fakeApp = {
    setName: (name: string) => calls.push(['setName', name]),
    commandLine: {
      getSwitchValue(name: string) {
        if (name === 'user-data-dir') return join(root, 'config', 'profile');
        return '';
      },
    },
    requestSingleInstanceLock: () => {
      calls.push(['lock']);
      return true;
    },
    on: (event: string) => appEvents.push(event),
    whenReady: () => {
      whenReadyCalls += 1;
      return { then: () => undefined };
    },
    exit: (code: number) => calls.push(['exit', code]),
    quit: () => calls.push(['quit']),
  };
  const fakeElectron = {
    app: fakeApp,
    BrowserWindow: class {
      constructor() {
        browserWindowCreations += 1;
      }
    },
    dialog: {
      showErrorBox: (title: string, message: string) => calls.push(['dialog', title, message]),
    },
    Menu: { setApplicationMenu: () => undefined },
    screen: {},
  };
  const nativeRequire = createRequire(import.meta.url);
  const mainPath = resolve(import.meta.dirname, '../apps/desktop/runtime/main.cjs');
  const mainSource = readFileSync(mainPath, 'utf8');
  const storagePath = resolve(import.meta.dirname, '../apps/desktop/runtime/portable-storage.cjs');
  const diagnosticsPath = resolve(import.meta.dirname, '../apps/desktop/runtime/smoke-diagnostics.cjs');
  const errorText: string[] = [];
  const mockedRequire = (specifier: string) => {
    if (specifier === 'electron') return fakeElectron;
    if (specifier === 'node:fs') return nativeRequire('node:fs');
    if (specifier === 'node:path' || specifier === 'node:url') return nativeRequire(specifier);
    if (specifier === './portable-storage.cjs') return nativeRequire(storagePath);
    if (specifier === './configuration-error.cjs') return nativeRequire(configurationErrorPath);
    if (specifier === './smoke-diagnostics.cjs') return nativeRequire(diagnosticsPath);
    throw new Error(`Unexpected main-process dependency: ${specifier}`);
  };

  try {
    runInNewContext(mainSource, {
      require: mockedRequire,
      process: {
        execPath: join(root, 'config', 'runtime', 'PDF-Scrubber.exe'),
        env: { PDF_SCRUBBER_PORTABLE_ROOT: root },
        pid: 1234,
        versions: { electron: '45.1.0' },
      },
      console: { error: (...arguments_: unknown[]) => errorText.push(String(arguments_[0])) },
    }, { filename: mainPath });

    expect(calls.find(([kind]) => kind === 'dialog')).toEqual([
      'dialog',
      'PDF-Scrubber — Configuration error',
      'File: settings.json\nProblem: Invalid JSON.\n\nCorrect the file and restart PDF-Scrubber.\nYour settings have not been changed.',
    ]);
    expect(calls).toContainEqual(['exit', 1]);
    expect(whenReadyCalls).toBe(0);
    expect(browserWindowCreations).toBe(0);
    expect(appEvents).not.toContain('ready');
    expect(errorText).toEqual([]);
    expect(readFileSync(settingsPath)).toEqual(invalidBytes);
    expect(JSON.stringify(calls)).not.toContain(invalidBytes.toString('utf8'));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
