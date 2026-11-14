const { app, BrowserWindow, dialog, Menu, screen } = require('electron');
const { appendFileSync } = require('node:fs');
const { basename, dirname, isAbsolute, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  configurePortableApp,
  preflightPortableStorage,
  preparePortableStorage,
} = require('./portable-storage.cjs');
const { showConfigurationError } = require('./configuration-error.cjs');
const { createSmokeDiagnosticSink } = require('./smoke-diagnostics.cjs');

let mainWindow;
let editorOrigin;
let staticServer;
let securityPolicy;
let isWindowsSmokeRun = false;
let smokeSaveDirectory = '';
let diagnosticsPath;
let diagnosticWriter;
let shutdownStarted = false;

app.setName('PDF-Scrubber');

let portablePaths;
try {
  const portableRoot = resolve(dirname(process.execPath), '..', '..');
  const launcherRoot = process.env.PDF_SCRUBBER_PORTABLE_ROOT;
  const requestedUserData = app.commandLine.getSwitchValue('user-data-dir');
  if (launcherRoot === undefined
    || !samePortablePath(launcherRoot, portableRoot)
    || !samePortablePath(requestedUserData, join(portableRoot, 'config', 'profile'))) {
    throw new Error('The portable launcher is required. Start the root PDF-Scrubber.exe from the extracted application folder; the inner runtime executable cannot be launched directly.');
  }

  preflightPortableStorage(portableRoot);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    portablePaths = preparePortableStorage(portableRoot);
    configurePortableApp(app, portablePaths);
  }
} catch (error) {
  portablePaths = undefined;
  if (!showConfigurationError(error, { dialog, app })) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('PDF-Scrubber portable storage bootstrap failed', error);
    dialog.showErrorBox(
      'PDF-Scrubber could not start',
      `${detail}\n\nMove the complete application folder to a writable location and start its root PDF-Scrubber.exe.`,
    );
    app.exit(1);
  }
}

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
  }).finally(() => {
    writeSmokeDiagnostic({ event: 'portable-shutdown' });
    app.quit();
  });
});

if (portablePaths !== undefined) {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => startDesktopEditor(portablePaths)).catch((error) => {
    void exitAfterEditorStartupFailure(error);
  });
}

async function exitAfterEditorStartupFailure(error) {
  try {
    writeSmokeDiagnostic({
      event: 'startup-error',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorCode: error !== null && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'none',
    });
    console.error('PDF-Scrubber failed to start', error);
    dialog.showErrorBox('PDF-Scrubber could not start', 'The local editor could not be opened.');
  } finally {
    const serverToClose = staticServer;
    staticServer = undefined;
    try {
      if (serverToClose !== undefined) await serverToClose.close();
    } catch (closeError) {
      console.error('Failed to close the local editor server after startup failure', closeError);
    } finally {
      app.exit(1);
    }
  }
}

async function startDesktopEditor(paths) {
  const { settings } = paths;
  securityPolicy = await import('./security-policy.js');
  configureSmokeDiagnostics();
  writeSmokeDiagnostic({
    event: 'portable-managed-paths',
    processId: process.pid,
    root: paths.root,
    userData: app.getPath('userData'),
    sessionData: app.getPath('sessionData'),
    temp: app.getPath('temp'),
    logs: app.getPath('logs'),
    crashDumps: app.getPath('crashDumps'),
    tempEnvironment: {
      TMP: process.env.TMP ?? '',
      TEMP: process.env.TEMP ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
    },
  });
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
    width: settings.window.width,
    height: settings.window.height,
    minWidth: 760,
    minHeight: 560,
    show: false,
    webPreferences: securityPolicy.createSecureWebPreferences(),
  });

  configureEditorSession(mainWindow);
  mainWindow.once('ready-to-show', () => {
    const bounds = mainWindow?.getBounds();
    if (bounds !== undefined) {
      const display = screen.getDisplayMatching(bounds);
      writeSmokeDiagnostic({
        event: 'portable-window-ready',
        requestedWidth: settings.window.width,
        requestedHeight: settings.window.height,
        width: bounds.width,
        height: bounds.height,
        displayId: display.id,
        workArea: display.workArea,
        minWidth: 760,
        minHeight: 560,
      });
    }
    mainWindow?.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  await mainWindow.loadURL(staticServer.url);
}

function samePortablePath(first, second) {
  if (typeof first !== 'string' || first.length === 0) return false;
  const normalizedFirst = resolve(first).replace(/[\\/]+$/, '').toLowerCase();
  const normalizedSecond = resolve(second).replace(/[\\/]+$/, '').toLowerCase();
  return normalizedFirst === normalizedSecond;
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
  diagnosticWriter = createSmokeDiagnosticSink({
    diagnosticsPath,
    appendFile: appendFileSync,
    createBoundedDiagnosticWriter: securityPolicy.createBoundedDiagnosticWriter,
  }).write;
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
