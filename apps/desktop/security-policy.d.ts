export function createSecureWebPreferences(): Readonly<Record<string, unknown>>;
export function createBoundedDiagnosticWriter(
  writeLine: (line: string) => void,
  options?: Readonly<{ maxRecords?: number; maxBytes?: number }>,
): (record: unknown) => boolean;
export function createDesktopDownloadDiagnostic(
  input: Readonly<{
    phase: 'will-download' | 'updated' | 'done';
    isMainWindow: boolean;
    initiatorOrigin: string | null;
    mimeType: string;
    userGesture: boolean;
    smokeSaveMode: boolean;
    state?: string;
    receivedBytes?: number;
    totalBytes?: number;
  }>,
  editorOrigin: string,
): Readonly<Record<string, unknown>>;
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
