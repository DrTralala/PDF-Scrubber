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
export function fontSearchTarget(candidate: string, editorPage: string, editorOrigin: string): string | null;
export function isAllowedNetworkRequest(candidate: string, editorOrigin: string): boolean;
export function isAllowedSessionPermission(
  permission: string,
  requestingUrl: string,
  editorOrigin: string,
  details?: Readonly<{
    filePath?: string;
    isDirectory?: boolean;
    fileAccessType?: 'readable' | 'writable';
  }>,
): boolean;
export function configureEditorSessionPermissions(
  session: Readonly<{
    setPermissionCheckHandler(handler: (
      contents: object | null,
      permission: string,
      requestingOrigin: string,
      details: Readonly<{
        filePath?: string;
        isDirectory?: boolean;
        fileAccessType?: 'readable' | 'writable';
      }>,
    ) => boolean): void;
    setPermissionRequestHandler(handler: (
      contents: object,
      permission: string,
      callback: (granted: boolean) => void,
      details: Readonly<{
        requestingUrl: string;
        filePath?: string;
        isDirectory?: boolean;
        fileAccessType?: 'readable' | 'writable';
      }>,
    ) => void): void;
  }>,
  editorContents: object,
  editorOrigin: string,
): void;
export function installUnsavedCloseWarning(
  window: Readonly<{
    webContents: Readonly<{
      on(event: 'will-prevent-unload', listener: (event: Readonly<{
        preventDefault(): void;
      }>) => void): void;
      getTitle(): string;
    }>;
  }>,
  dialog: Readonly<{
    showMessageBoxSync(
      parent: object,
      options: Readonly<{
        type: 'warning';
        title: 'Unsaved changes';
        message: string;
        buttons: readonly ['Keep editing', 'Exit without saving'];
        defaultId: 0;
        cancelId: 0;
        noLink: true;
      }>,
    ): number;
  }>,
  onPrompt?: (attempt: number) => void,
): void;
