const { app, BrowserWindow, dialog, Menu } = require('electron');
const { appendFileSync } = require('node:fs');
const { basename, dirname, isAbsolute, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

let mainWindow;
let editorOrigin;
let staticServer;
let securityPolicy;
let isWindowsSmokeRun = false;
let smokeSaveDirectory = '';
let diagnosticsPath;
let diagnosticWriter;
let diagnosticFileWriteFailed = false;
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
  writeSmokeDiagnostic({
    event: 'startup-error',
    errorName: error instanceof Error ? error.name : 'UnknownError',
    errorCode: error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'none',
  });
  console.error('PDF-Scrubber failed to start', error);
  dialog.showErrorBox('PDF-Scrubber could not start', 'The local editor could not be opened.');
  app.quit();
});

async function startDesktopEditor() {
  securityPolicy = await import('./security-policy.js');
  configureSmokeDiagnostics();
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
  writeSmokeDiagnostic({ event: 'editor-server-ready', editorOrigin });

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
    const downloadMetadata = {
      isMainWindow: contents === window.webContents,
      initiatorOrigin: item.getInitiatorOrigin(),
      mimeType: item.getMimeType(),
      userGesture: item.hasUserGesture(),
      smokeSaveMode: smokeSaveDirectory.length > 0,
    };
    const decision = securityPolicy.createDesktopDownloadDiagnostic({
      phase: 'will-download',
      ...downloadMetadata,
    }, editorOrigin);
    writeSmokeDiagnostic(decision);
    if (!decision.policyAccepted) {
      event.preventDefault();
      return;
    }

    item.on('updated', (_updateEvent, state) => {
      writeSmokeDiagnostic(securityPolicy.createDesktopDownloadDiagnostic({
        phase: 'updated',
        ...downloadMetadata,
        state,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
      }, editorOrigin));
    });
    item.once('done', (_doneEvent, state) => {
      const savePath = item.getSavePath();
      writeSmokeDiagnostic({
        ...securityPolicy.createDesktopDownloadDiagnostic({
          phase: 'done',
          ...downloadMetadata,
          state,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
        }, editorOrigin),
        savePathSet: savePath.length > 0,
        savePathInSmokeDirectory: smokeSaveDirectory.length > 0
          && savePath.length > 0
          && resolve(dirname(savePath)) === resolve(smokeSaveDirectory),
      });
    });

    const fileName = safePdfFileName(item.getFilename());
    if (smokeSaveDirectory.length > 0) {
      if (!isAbsolute(smokeSaveDirectory)) {
        event.preventDefault();
        writeSmokeDiagnostic({ event: 'download-save-target', mode: 'ci-smoke', validPath: false });
        return;
      }
      item.setSavePath(join(smokeSaveDirectory, fileName));
      writeSmokeDiagnostic({ event: 'download-save-target', mode: 'ci-smoke', validPath: true });
      return;
    }

    item.setSaveDialogOptions({
      title: 'Save edited PDF',
      defaultPath: fileName,
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    });
    writeSmokeDiagnostic({ event: 'download-save-target', mode: 'native-dialog' });
  });
}

function configureSmokeDiagnostics() {
  isWindowsSmokeRun = process.env.GITHUB_ACTIONS === 'true'
    && process.env.RUNNER_OS === 'Windows';
  const requestedDirectory = app.commandLine.getSwitchValue('pdf-scrubber-smoke-save-dir');
  smokeSaveDirectory = isWindowsSmokeRun && isAbsolute(requestedDirectory)
    ? requestedDirectory
    : '';
  diagnosticsPath = smokeSaveDirectory.length > 0
    ? join(smokeSaveDirectory, 'desktop-diagnostics.jsonl')
    : undefined;
  diagnosticWriter = securityPolicy.createBoundedDiagnosticWriter((line) => {
    process.stdout.write(`PDF_SCRUBBER_DIAG ${line}`);
    if (diagnosticsPath === undefined || diagnosticFileWriteFailed) return;
    try {
      appendFileSync(diagnosticsPath, line, { encoding: 'utf8' });
    } catch {
      diagnosticFileWriteFailed = true;
      process.stdout.write('PDF_SCRUBBER_DIAG {"event":"diagnostic-file-write-failed"}\n');
    }
  }, { maxRecords: 64, maxBytes: 16_384 });
  writeSmokeDiagnostic({
    event: 'app-start',
    electronVersion: process.versions.electron,
    githubActions: process.env.GITHUB_ACTIONS === 'true',
    windowsRunner: process.env.RUNNER_OS === 'Windows',
    smokeSaveSwitchPresent: requestedDirectory.length > 0,
    smokeSaveDirectoryAccepted: smokeSaveDirectory.length > 0,
  });
}

function writeSmokeDiagnostic(record) {
  if (!isWindowsSmokeRun || diagnosticWriter === undefined) return;
  diagnosticWriter(record);
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
