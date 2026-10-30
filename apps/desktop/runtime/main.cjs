const { app, BrowserWindow, dialog, Menu } = require('electron');
const { basename, isAbsolute, join } = require('node:path');
const { pathToFileURL } = require('node:url');

let mainWindow;
let editorOrigin;
let staticServer;
let securityPolicy;
let shutdownStarted = false;

app.setName('PDF-Scrubber');

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (details, navigationUrl) => {
    const url = typeof navigationUrl === 'string' ? navigationUrl : details.url;
    if (!isTrustedEditorURL(url)) details.preventDefault();
  });
  contents.on('will-frame-navigate', (details) => {
    if (!isTrustedEditorURL(details.url)) details.preventDefault();
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (event) => {
  if (staticServer === undefined || shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  const serverToClose = staticServer;
  staticServer = undefined;
  void serverToClose.close().catch((error) => {
    console.error('Failed to close the local editor server', error);
  }).finally(() => app.quit());
});

app.whenReady().then(startDesktopEditor).catch((error) => {
  console.error('PDF-Scrubber failed to start', error);
  dialog.showErrorBox('PDF-Scrubber could not start', 'The local editor could not be opened.');
  app.quit();
});

async function startDesktopEditor() {
  securityPolicy = await import('./security-policy.js');
  Menu.setApplicationMenu(null);
  const { startStaticServer } = await import(
    pathToFileURL(join(app.getAppPath(), 'server.mjs')).href
  );
  staticServer = await startStaticServer({
    webRoot: join(app.getAppPath(), 'web'),
    port: 0,
    explicitPort: false,
  });
  editorOrigin = new URL(staticServer.url).origin;

  mainWindow = new BrowserWindow({
    title: 'PDF-Scrubber',
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    show: false,
    webPreferences: securityPolicy.createSecureWebPreferences(),
  });

  configureEditorSession(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  await mainWindow.loadURL(staticServer.url);
}

function configureEditorSession(window) {
  const editorSession = window.webContents.session;
  editorSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !securityPolicy.isAllowedNetworkRequest(details.url, editorOrigin) });
  });
  editorSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => (
    contents === window.webContents
      && securityPolicy.isAllowedSessionPermission(permission, requestingOrigin, editorOrigin)
  ));
  editorSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl || contents.getURL();
    callback(contents === window.webContents
      && securityPolicy.isAllowedSessionPermission(permission, requestingUrl, editorOrigin));
  });
  editorSession.on('will-download', (event, item, contents) => {
    const allowed = securityPolicy.isAllowedDesktopDownload({
      isMainWindow: contents === window.webContents,
      initiatorOrigin: item.getInitiatorOrigin(),
      mimeType: item.getMimeType(),
      userGesture: item.hasUserGesture(),
    }, editorOrigin);
    if (!allowed) {
      event.preventDefault();
      return;
    }

    const fileName = safePdfFileName(item.getFilename());
    const smokeDirectory = process.env.GITHUB_ACTIONS === 'true'
      && process.env.RUNNER_OS === 'Windows'
      ? app.commandLine.getSwitchValue('pdf-scrubber-smoke-save-dir')
      : '';
    if (smokeDirectory.length > 0) {
      if (!isAbsolute(smokeDirectory)) {
        event.preventDefault();
        return;
      }
      item.setSavePath(join(smokeDirectory, fileName));
      return;
    }

    item.setSaveDialogOptions({
      title: 'Save edited PDF',
      defaultPath: fileName,
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    });
  });
}

function isTrustedEditorURL(value) {
  return editorOrigin !== undefined
    && securityPolicy !== undefined
    && securityPolicy.isAllowedEditorURL(value, editorOrigin);
}

function safePdfFileName(value) {
  const fileName = basename(value.replaceAll('\\', '/'));
  if (fileName.length === 0 || fileName === '.' || fileName === '..') {
    return 'document-edited.pdf';
  }
  return fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`;
}
