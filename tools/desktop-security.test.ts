import { createRequire } from 'node:module';

import { expect, test } from 'vitest';

import {
  createBoundedDiagnosticWriter,
  createDesktopDownloadDiagnostic,
  createSecureWebPreferences,
  fontSearchTarget,
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

test('grants only Local Font Access to the trusted editor origin', () => {
  expect(isAllowedSessionPermission('local-fonts', editorOrigin, editorOrigin)).toBe(true);
  expect(isAllowedSessionPermission('local-fonts', 'https://example.com', editorOrigin)).toBe(false);
  expect(isAllowedSessionPermission('geolocation', editorOrigin, editorOrigin)).toBe(false);
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
});
