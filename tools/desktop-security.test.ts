import { expect, test } from 'vitest';

import {
  createSecureWebPreferences,
  isAllowedDesktopDownload,
  isAllowedEditorURL,
  isAllowedNetworkRequest,
  isAllowedSessionPermission,
} from '../apps/desktop/security-policy.js';

const editorOrigin = 'http://127.0.0.1:43127';

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
