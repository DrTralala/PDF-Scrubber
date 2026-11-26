export type WritablePdfStream = Readonly<{
  write(data: ArrayBuffer | Blob | string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}>;

export type WritablePdfHandle = Readonly<{
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritablePdfStream>;
  requestPermission?(options: Readonly<{ mode: 'readwrite' }>): Promise<PermissionState>;
}>;

export type OpenedPdf = Readonly<{
  file: File;
  handle: WritablePdfHandle;
}>;

export type DroppedPdf = Readonly<{
  file: File;
  handle?: WritablePdfHandle;
}>;

type PickerWindow = Window & Readonly<{
  showOpenFilePicker?: (options?: Readonly<{
    multiple: false;
    types: readonly Readonly<{
      description: string;
      accept: Readonly<Record<string, readonly string[]>>;
    }>[];
  }>) => Promise<WritablePdfHandle[]>;
  showSaveFilePicker?: (options?: Readonly<{
    suggestedName: string;
    types: readonly Readonly<{
      description: string;
      accept: Readonly<Record<string, readonly string[]>>;
    }>[];
  }>) => Promise<WritablePdfHandle>;
}>;

const PDF_PICKER_TYPES = Object.freeze([Object.freeze({
  description: 'PDF documents',
  accept: Object.freeze({ 'application/pdf': Object.freeze(['.pdf']) }),
})]);

export class FileAccessError extends Error {
  constructor(readonly code: 'permission-denied' | 'write-failed' | 'picker-unavailable') {
    super(code);
    this.name = 'FileAccessError';
  }
}

function pickerWindow(): PickerWindow {
  return window as PickerWindow;
}

function isCancelled(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && (error as { name?: unknown }).name === 'AbortError';
}

function asWritablePdfHandle(value: unknown): WritablePdfHandle | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Partial<WritablePdfHandle>;
  return typeof candidate.name === 'string'
    && typeof candidate.getFile === 'function'
    && typeof candidate.createWritable === 'function'
    ? candidate as WritablePdfHandle
    : null;
}

export function readDroppedPdf(
  item: DataTransferItem | undefined,
  fallbackFile: File | undefined,
): Promise<DroppedPdf | null> {
  const fallback = fallbackFile === undefined
    ? null
    : Object.freeze({ file: fallbackFile });
  if (item === undefined) return Promise.resolve(fallback);
  const getHandle = Reflect.get(item, 'getAsFileSystemHandle');
  if (typeof getHandle !== 'function') return Promise.resolve(fallback);

  let selectedHandle: unknown;
  try {
    // Capture the file capability synchronously during the drop gesture.
    selectedHandle = getHandle.call(item);
  } catch {
    return Promise.resolve(fallback);
  }
  return Promise.resolve(selectedHandle).then(async (value) => {
    const handle = asWritablePdfHandle(value);
    if (handle === null) return fallback;
    try {
      return Object.freeze({ file: await handle.getFile(), handle });
    } catch {
      return fallback;
    }
  }, () => fallback);
}

export function canPickPdf(): boolean {
  return typeof pickerWindow().showOpenFilePicker === 'function';
}

export function canPickSaveTarget(): boolean {
  return typeof pickerWindow().showSaveFilePicker === 'function';
}

export async function pickPdfFile(): Promise<OpenedPdf | null> {
  const picker = pickerWindow().showOpenFilePicker;
  if (picker === undefined) throw new FileAccessError('picker-unavailable');
  try {
    const [handle] = await picker.call(window, {
      multiple: false,
      types: PDF_PICKER_TYPES,
    });
    if (handle === undefined) return null;
    const file = await handle.getFile();
    return Object.freeze({ file, handle });
  } catch (error) {
    if (isCancelled(error)) return null;
    throw error;
  }
}

export async function pickSaveTarget(suggestedName: string): Promise<WritablePdfHandle | null> {
  const picker = pickerWindow().showSaveFilePicker;
  if (picker === undefined) throw new FileAccessError('picker-unavailable');
  try {
    return await picker.call(window, {
      suggestedName,
      types: PDF_PICKER_TYPES,
    });
  } catch (error) {
    if (isCancelled(error)) return null;
    throw error;
  }
}

export function requestWritePermission(handle: WritablePdfHandle): Promise<boolean> {
  if (handle.requestPermission === undefined) return Promise.resolve(true);
  try {
    return handle.requestPermission({ mode: 'readwrite' })
      .then((permission) => permission === 'granted', () => false);
  } catch {
    return Promise.resolve(false);
  }
}

export async function writePdfFile(
  handle: WritablePdfHandle,
  bytes: Uint8Array,
  permission: Promise<boolean> = requestWritePermission(handle),
): Promise<void> {
  if (!await permission) throw new FileAccessError('permission-denied');

  let writable: WritablePdfStream | null = null;
  try {
    writable = await handle.createWritable();
    const output = bytes.slice();
    await writable.write(output.buffer as ArrayBuffer);
    await writable.close();
  } catch {
    try {
      await writable?.abort?.();
    } catch {
      // A failed abort does not make the original write successful.
    }
    throw new FileAccessError('write-failed');
  }
}
