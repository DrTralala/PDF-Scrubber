import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { expect, test, vi } from 'vitest';

import {
  createBoundedDiagnosticWriter,
  createDesktopDownloadDiagnostic,
  createSecureWebPreferences,
  configureEditorSessionPermissions,
  fontSearchTarget,
  installUnsavedCloseWarning,
  isAllowedDesktopDownload,
  isAllowedEditorURL,
  isAllowedNetworkRequest,
  isAllowedSessionPermission,
} from '../apps/desktop/security-policy.js';

type SmokeDiagnosticSink = Readonly<{
  write(record: Readonly<Record<string, unknown>>): boolean;
  fileWriteFailed(): boolean;
}>;

type SmokeDiagnosticDependencies = Readonly<{
  diagnosticsPath?: string;
  appendFile(path: string, line: string, options: Readonly<{ encoding: 'utf8' }>): void;
  createBoundedDiagnosticWriter(
    writeLine: (line: string) => void,
    options: Readonly<{ maxRecords: number; maxBytes: number }>,
  ): (record: Readonly<Record<string, unknown>>) => boolean;
}>;

const require = createRequire(import.meta.url);
const smokeDiagnostics = require('../apps/desktop/runtime/smoke-diagnostics.cjs') as Readonly<{
  createSmokeDiagnosticSink(dependencies: SmokeDiagnosticDependencies): SmokeDiagnosticSink;
}>;

type FileSystemPermissionDetails = Readonly<{
  requestingUrl?: string;
  filePath?: string;
  isDirectory?: boolean;
  fileAccessType?: 'readable' | 'writable';
}>;

type PermissionCheckHandler = (
  contents: object | null,
  permission: string,
  requestingOrigin: string,
  details: FileSystemPermissionDetails,
) => boolean;

type PermissionRequestHandler = (
  contents: object,
  permission: string,
  callback: (granted: boolean) => void,
  details: Readonly<FileSystemPermissionDetails & { requestingUrl: string }>,
) => void;

const editorOrigin = 'http://127.0.0.1:43127';

test('hands off only the Fonts dialog search from the editor, without enabling renderer networking', () => {
  const link = 'https://fonts2u.com/search.html?q=Noto+Sans';
  expect(fontSearchTarget(link, `${editorOrigin}/`, editorOrigin)).toBe(link);
  expect(isAllowedNetworkRequest(link, editorOrigin)).toBe(false);
  expect(fontSearchTarget(link, 'about:blank', editorOrigin)).toBeNull();
  for (const invalid of ['https://example.org/search.html?q=Test', 'https://fonts2u.com/',
    'http://fonts2u.com/search.html?q=Test', `${link}&q=Other`, `${link}&extra=1`, `${link}#extra`,
    'https://fonts2u.com/search.html?q=']) {
    expect(fontSearchTarget(invalid, editorOrigin, editorOrigin)).toBeNull();
  }
});

test('allows only the exact editor origin for page navigation and renderer requests', () => {
  expect(isAllowedEditorURL(`${editorOrigin}/`, editorOrigin)).toBe(true);
  expect(isAllowedEditorURL(`${editorOrigin}/assets/app.js`, editorOrigin)).toBe(true);
  expect(isAllowedEditorURL('https://127.0.0.1:43127/', editorOrigin)).toBe(false);
  expect(isAllowedEditorURL('http://127.0.0.1.evil.test:43127/', editorOrigin)).toBe(false);
  expect(isAllowedEditorURL('http://127.0.0.1:5173/', editorOrigin)).toBe(false);
  expect(isAllowedEditorURL('file:///etc/passwd', editorOrigin)).toBe(false);

  expect(isAllowedNetworkRequest(`${editorOrigin}/assets/app.js`, editorOrigin)).toBe(true);
  expect(isAllowedNetworkRequest(`blob:${editorOrigin}/download-id`, editorOrigin)).toBe(true);
  expect(isAllowedNetworkRequest('https://example.com/document.pdf', editorOrigin)).toBe(false);
  expect(isAllowedNetworkRequest('ftp://example.com/document.pdf', editorOrigin)).toBe(false);
  expect(isAllowedNetworkRequest('wss://example.com/socket', editorOrigin)).toBe(false);
});

test('allows only Local Font Access and user-picked PDF file handles at the trusted editor origin', () => {
  const allowPermission = (permission: string, requestingUrl: string, details?: FileSystemPermissionDetails) => (
    isAllowedSessionPermission(permission, requestingUrl, editorOrigin, details)
  );

  expect(isAllowedSessionPermission('local-fonts', editorOrigin, editorOrigin)).toBe(true);
  expect(isAllowedSessionPermission('local-fonts', 'https://example.com', editorOrigin)).toBe(false);
  expect(isAllowedSessionPermission('geolocation', editorOrigin, editorOrigin)).toBe(false);
  expect(isAllowedSessionPermission('fileSystem', editorOrigin, editorOrigin)).toBe(false);
  expect(allowPermission('fileSystem', editorOrigin, {
    filePath: 'C:\\Users\\Example\\Documents\\edited.PDF',
    isDirectory: false,
    fileAccessType: 'readable',
  })).toBe(true);
  expect(allowPermission('fileSystem', editorOrigin, {
    filePath: 'C:\\Users\\Example\\Documents\\edited.pdf',
    isDirectory: false,
    fileAccessType: 'writable',
  })).toBe(true);
  expect(allowPermission('fileSystem', editorOrigin, {
    filePath: 'C:\\Users\\Example\\Documents\\folder.pdf',
    isDirectory: true,
    fileAccessType: 'writable',
  })).toBe(false);
  expect(allowPermission('fileSystem', editorOrigin, {
    filePath: 'C:\\Users\\Example\\Documents\\notes.txt',
    isDirectory: false,
    fileAccessType: 'writable',
  })).toBe(false);
  expect(allowPermission('fileSystem', editorOrigin, {
    filePath: 'C:\\Users\\Example\\Documents\\edited.pdf',
    isDirectory: false,
  })).toBe(false);
  expect(allowPermission('fileSystem', editorOrigin, {
    filePath: 'relative/edited.pdf',
    isDirectory: false,
    fileAccessType: 'writable',
  })).toBe(false);
  expect(allowPermission('fileSystem', 'https://example.com', {
    filePath: 'C:\\Users\\Example\\Documents\\edited.pdf',
    isDirectory: false,
    fileAccessType: 'writable',
  })).toBe(false);
});

test('installs per-window permission checks that limit filesystem access to a selected PDF', () => {
  let checkPermission: PermissionCheckHandler | undefined;
  let requestPermission: PermissionRequestHandler | undefined;
  const contents = { getURL: () => `${editorOrigin}/` };
  const session = {
    setPermissionCheckHandler: vi.fn((handler: PermissionCheckHandler) => { checkPermission = handler; }),
    setPermissionRequestHandler: vi.fn((handler: PermissionRequestHandler) => { requestPermission = handler; }),
  };

  configureEditorSessionPermissions(session, contents, editorOrigin);

  expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
  expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
  expect(checkPermission?.(contents, 'fileSystem', editorOrigin, {
    filePath: 'C:\\Users\\Example\\edited.pdf',
    isDirectory: false,
    fileAccessType: 'writable',
  })).toBe(true);
  expect(checkPermission?.({} as object, 'fileSystem', editorOrigin, {
    filePath: 'C:\\Users\\Example\\edited.pdf',
    isDirectory: false,
    fileAccessType: 'writable',
  })).toBe(false);
  expect(checkPermission?.(contents, 'fileSystem', editorOrigin, {
    filePath: 'C:\\Users\\Example\\folder.pdf',
    isDirectory: true,
    fileAccessType: 'writable',
  })).toBe(false);

  const outcomes: boolean[] = [];
  requestPermission?.(contents, 'fileSystem', (granted) => outcomes.push(granted), {
    requestingUrl: `${editorOrigin}/`,
    filePath: 'C:\\Users\\Example\\edited.pdf',
    isDirectory: false,
    fileAccessType: 'writable',
  });
  requestPermission?.(contents, 'fileSystem', (granted) => outcomes.push(granted), {
    requestingUrl: '',
    filePath: 'C:\\Users\\Example\\edited.pdf',
    isDirectory: false,
    fileAccessType: 'readable',
  });
  requestPermission?.(contents, 'fileSystem', (granted) => outcomes.push(granted), {
    requestingUrl: 'https://example.com/',
    filePath: 'C:\\Users\\Example\\edited.pdf',
    isDirectory: false,
    fileAccessType: 'writable',
  });
  requestPermission?.(contents, 'fileSystem', (granted) => outcomes.push(granted), {
    requestingUrl: `${editorOrigin}/`,
    filePath: 'C:\\Users\\Example\\folder.pdf',
    isDirectory: true,
    fileAccessType: 'writable',
  });
  expect(outcomes).toEqual([true, false, false, false]);
});

test('confirms dirty close through one parented native modal and leaves clean close unprompted', () => {
  let title = 'PDF-Scrubber';
  const registeredEvents: string[] = [];
  let preventUnload: ((event: Readonly<{ preventDefault(): void }>) => void) | undefined;
  const parent = {
    webContents: {
      on(event: 'will-prevent-unload', listener: (event: Readonly<{ preventDefault(): void }>) => void) {
        registeredEvents.push(event);
        preventUnload = listener;
      },
      getTitle: () => title,
    },
  };
  const showMessageBoxSync = vi.fn().mockReturnValue(0);
  const onPrompt = vi.fn();
  installUnsavedCloseWarning(parent, { showMessageBoxSync }, onPrompt);

  expect(registeredEvents).toEqual(['will-prevent-unload']);
  expect(showMessageBoxSync).not.toHaveBeenCalled();

  title = 'report <script>alert(1)</script>.pdf — Unsaved changes | PDF-Scrubber';
  const keepEditingEvent = { preventDefault: vi.fn() };
  preventUnload?.(keepEditingEvent);

  expect(showMessageBoxSync).toHaveBeenCalledTimes(1);
  expect(showMessageBoxSync).toHaveBeenCalledWith(parent, {
    type: 'warning',
    title: 'Unsaved changes',
    message: 'Exit without saving changes to “report <script>alert(1)</script>.pdf”?',
    buttons: ['Keep editing', 'Exit without saving'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  expect(keepEditingEvent.preventDefault).not.toHaveBeenCalled();
  expect(onPrompt).toHaveBeenCalledWith(1);
});

test('allows the renderer to unload synchronously only after confirmed discard, including repeated attempts', () => {
  const listeners: Array<(event: Readonly<{ preventDefault(): void }>) => void> = [];
  const parent = {
    webContents: {
      on(_event: 'will-prevent-unload', listener: (event: Readonly<{ preventDefault(): void }>) => void) {
        listeners.push(listener);
      },
      getTitle: () => 'notes.pdf — Unsaved changes | PDF-Scrubber',
    },
  };
  const choices = [0, 1];
  const showMessageBoxSync = vi.fn(() => choices.shift() ?? 0);
  const attempts: number[] = [];
  installUnsavedCloseWarning(parent, { showMessageBoxSync }, (attempt) => attempts.push(attempt));

  const firstClose = { preventDefault: vi.fn() };
  listeners[0]?.(firstClose);
  expect(firstClose.preventDefault).not.toHaveBeenCalled();

  const secondClose = { preventDefault: vi.fn() };
  listeners[0]?.(secondClose);
  expect(secondClose.preventDefault).toHaveBeenCalledTimes(1);
  expect(showMessageBoxSync).toHaveBeenCalledTimes(2);
  expect(attempts).toEqual([1, 2]);
});

test('wires the tested close and filesystem policy into the desktop runtime without IPC or restricted-path overrides', async () => {
  const main = await readFile(new URL('../apps/desktop/runtime/main.cjs', import.meta.url), 'utf8');

  expect(main).toContain('securityPolicy.configureEditorSessionPermissions(editorSession, window.webContents, editorOrigin);');
  expect(main).toContain('securityPolicy.installUnsavedCloseWarning(mainWindow, dialog,');
  expect(main).toContain('event: `unsaved-close-prompt-${attempt}`');
  expect(main).not.toContain('file-system-access-restricted');
  expect(main).not.toMatch(/\bipcMain\b/);
});

test('accepts only user-triggered PDF downloads from the main editor window', () => {
  expect(isAllowedDesktopDownload({
    isMainWindow: true,
    initiatorOrigin: editorOrigin,
    mimeType: 'application/pdf',
    userGesture: true,
  }, editorOrigin)).toBe(true);
  expect(isAllowedDesktopDownload({
    isMainWindow: true,
    initiatorOrigin: 'https://example.com',
    mimeType: 'application/pdf',
    userGesture: true,
  }, editorOrigin)).toBe(false);
  expect(isAllowedDesktopDownload({
    isMainWindow: true,
    initiatorOrigin: editorOrigin,
    mimeType: 'application/octet-stream',
    userGesture: true,
  }, editorOrigin)).toBe(false);
  expect(isAllowedDesktopDownload({
    isMainWindow: false,
    initiatorOrigin: editorOrigin,
    mimeType: 'application/pdf',
    userGesture: true,
  }, editorOrigin)).toBe(false);
  expect(isAllowedDesktopDownload({
    isMainWindow: true,
    initiatorOrigin: editorOrigin,
    mimeType: 'application/pdf',
    userGesture: false,
  }, editorOrigin)).toBe(false);
});

test('download diagnostics preserve decision metadata without including filenames or PDF data', () => {
  const diagnostic = createDesktopDownloadDiagnostic({
    phase: 'done',
    isMainWindow: true,
    initiatorOrigin: editorOrigin,
    mimeType: 'application/pdf',
    userGesture: true,
    smokeSaveMode: true,
    state: 'completed',
    receivedBytes: 512,
    totalBytes: 512,
  }, editorOrigin);

  expect(diagnostic).toEqual({
    event: 'done',
    isMainWindow: true,
    initiatorOriginPresent: true,
    initiatorIsEditor: true,
    mimeType: 'application/pdf',
    userGesture: true,
    policyAccepted: true,
    smokeSaveMode: true,
    state: 'completed',
    receivedBytes: 512,
    totalBytes: 512,
  });
  expect(JSON.stringify(diagnostic)).not.toMatch(/filename|pdfBytes|documentText/i);
});

test('caps diagnostic line count and bytes while marking truncated output once', () => {
  const lines: string[] = [];
  const writer = createBoundedDiagnosticWriter((line) => lines.push(line), {
    maxRecords: 4,
    maxBytes: 512,
  });

  for (let index = 0; index < 100; index += 1) {
    writer({ event: 'updated', state: 'progressing', receivedBytes: index });
  }

  expect(lines).toHaveLength(4);
  expect(lines.at(-1)).toBe('{"event":"truncated"}\n');
  expect(Buffer.byteLength(lines.join(''), 'utf8')).toBeLessThanOrEqual(512);
  expect(writer({ event: 'later' })).toBe(false);
  expect(lines).toHaveLength(4);
});

test('replaces an oversized diagnostic record with a bounded truncation marker', () => {
  const lines: string[] = [];
  const writer = createBoundedDiagnosticWriter((line) => lines.push(line), {
    maxRecords: 4,
    maxBytes: 48,
  });

  expect(writer({ event: 'updated', detail: 'x'.repeat(10_000) })).toBe(false);
  expect(lines).toEqual(['{"event":"truncated"}\n']);
  expect(Buffer.byteLength(lines.join(''), 'utf8')).toBeLessThanOrEqual(48);
});

test('persists bounded diagnostics without touching an unavailable GUI stdout handle', () => {
  const persisted: Array<Readonly<{ path: string; line: string }>> = [];
  const callOrder: string[] = [];
  let bounds: Readonly<{ maxRecords: number; maxBytes: number }> | undefined;
  const sink = smokeDiagnostics.createSmokeDiagnosticSink({
    diagnosticsPath: 'desktop-diagnostics.jsonl',
    appendFile(path, line) {
      callOrder.push('file');
      persisted.push({ path, line });
    },
    createBoundedDiagnosticWriter(writeLine, options) {
      bounds = options;
      return (record) => {
        writeLine(`${JSON.stringify(record)}\n`);
        return true;
      };
    },
  });

  const originalStdoutWrite = process.stdout.write;
  let sinkThrew = false;
  process.stdout.write = (() => {
    throw new Error('GUI child has no inherited stdout handle');
  }) as typeof process.stdout.write;
  try {
    sink.write({ event: 'portable-window-ready', width: 1280, height: 860 });
  } catch {
    sinkThrew = true;
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  expect(sinkThrew).toBe(false);
  expect(callOrder).toEqual(['file']);
  expect(persisted).toEqual([{
    path: 'desktop-diagnostics.jsonl',
    line: '{"event":"portable-window-ready","width":1280,"height":860}\n',
  }]);
  expect(bounds).toEqual({ maxRecords: 64, maxBytes: 16_384 });
  expect(sink.fileWriteFailed()).toBe(false);
});

test('records file diagnostic failures without throwing or retrying as a silent smoke pass', () => {
  let appendAttempts = 0;
  const sink = smokeDiagnostics.createSmokeDiagnosticSink({
    diagnosticsPath: 'desktop-diagnostics.jsonl',
    appendFile() {
      appendAttempts += 1;
      throw new Error('diagnostic directory is not writable');
    },
    createBoundedDiagnosticWriter(writeLine) {
      return (record) => {
        writeLine(`${JSON.stringify(record)}\n`);
        return true;
      };
    },
  });

  expect(() => sink.write({ event: 'portable-managed-paths' })).not.toThrow();
  expect(() => sink.write({ event: 'portable-window-ready' })).not.toThrow();
  expect(appendAttempts).toBe(1);
  expect(sink.fileWriteFailed()).toBe(true);
});

test('keeps renderer Node access and insecure web features disabled', () => {
  expect(createSecureWebPreferences()).toMatchObject({
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  });
  expect(createSecureWebPreferences()).not.toHaveProperty('preload');
});
