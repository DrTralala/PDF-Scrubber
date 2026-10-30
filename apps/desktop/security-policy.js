const NETWORK_PROTOCOLS = new Set(['ftp:', 'http:', 'https:', 'ws:', 'wss:']);

export function createSecureWebPreferences() {
  return Object.freeze({
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    devTools: false,
  });
}

export function isAllowedEditorURL(candidate, editorOrigin) {
  try {
    const candidateUrl = new URL(candidate);
    const trustedUrl = new URL(editorOrigin);
    return candidateUrl.protocol === 'http:'
      && trustedUrl.protocol === 'http:'
      && candidateUrl.username === ''
      && candidateUrl.password === ''
      && trustedUrl.username === ''
      && trustedUrl.password === ''
      && candidateUrl.origin === trustedUrl.origin;
  } catch {
    return false;
  }
}

export function isAllowedNetworkRequest(candidate, editorOrigin) {
  try {
    const url = new URL(candidate);
    if (!NETWORK_PROTOCOLS.has(url.protocol)) return true;
    return url.protocol === 'http:' && isAllowedEditorURL(candidate, editorOrigin);
  } catch {
    return false;
  }
}

export function isAllowedSessionPermission(permission, requestingUrl, editorOrigin) {
  return permission === 'local-fonts'
    && isAllowedEditorURL(requestingUrl, editorOrigin);
}

export function isAllowedDesktopDownload({ isMainWindow, initiatorOrigin, mimeType, userGesture }, editorOrigin) {
  return isMainWindow === true
    && mimeType === 'application/pdf'
    && userGesture === true
    && typeof initiatorOrigin === 'string'
    && isAllowedEditorURL(initiatorOrigin, editorOrigin);
}
