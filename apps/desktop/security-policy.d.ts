export function createSecureWebPreferences(): Readonly<Record<string, unknown>>;
export function isAllowedDesktopDownload(
  download: Readonly<{
    isMainWindow: boolean;
    initiatorOrigin: string | null;
    mimeType: string;
    userGesture: boolean;
  }>,
  editorOrigin: string,
): boolean;
export function isAllowedEditorURL(candidate: string, editorOrigin: string): boolean;
export function isAllowedNetworkRequest(candidate: string, editorOrigin: string): boolean;
export function isAllowedSessionPermission(
  permission: string,
  requestingUrl: string,
  editorOrigin: string,
): boolean;
