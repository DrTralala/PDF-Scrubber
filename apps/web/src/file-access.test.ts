import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  pickPdfFile,
  pickSaveTarget,
  readDroppedPdf,
  requestWritePermission,
  writePdfFile,
} from './file-access';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local file access', () => {
  it('opens a PDF with the selected file handle attached', async () => {
    const file = new File([Uint8Array.of(1, 2, 3)], 'source.pdf', {
      type: 'application/pdf',
    });
    const handle = {
      name: 'source.pdf',
      getFile: vi.fn().mockResolvedValue(file),
      createWritable: vi.fn(),
    };
    const picker = vi.fn().mockResolvedValue([handle]);
    vi.stubGlobal('showOpenFilePicker', picker);

    await expect(pickPdfFile()).resolves.toEqual({ file, handle });
    expect(picker).toHaveBeenCalledWith({
      multiple: false,
      types: [{
        description: 'PDF documents',
        accept: { 'application/pdf': ['.pdf'] },
      }],
    });
  });

  it('treats a cancelled picker as no selection', async () => {
    const picker = vi.fn().mockRejectedValue(Object.assign(
      new Error('The user aborted a request.'),
      { name: 'AbortError' },
    ));
    vi.stubGlobal('showOpenFilePicker', picker);

    await expect(pickPdfFile()).resolves.toBeNull();
  });

  it('captures the dropped item handle synchronously and reads through that handle', async () => {
    const fallback = new File([Uint8Array.of(1)], 'data-transfer.pdf', {
      type: 'application/pdf',
    });
    const handleFile = new File([Uint8Array.of(2)], 'handle.pdf', {
      type: 'application/pdf',
    });
    const handle = {
      name: 'handle.pdf',
      getFile: vi.fn().mockResolvedValue(handleFile),
      createWritable: vi.fn(),
    };
    const getAsFileSystemHandle = vi.fn().mockResolvedValue(handle);
    const item = { getAsFileSystemHandle } as unknown as DataTransferItem;

    const dropped = readDroppedPdf(item, fallback);
    expect(getAsFileSystemHandle).toHaveBeenCalledTimes(1);
    await expect(dropped).resolves.toEqual({ file: handleFile, handle });
    expect(handle.getFile).toHaveBeenCalledTimes(1);
  });

  it('falls back to the dropped File when no writable item handle is available', async () => {
    const file = new File([Uint8Array.of(1)], 'fallback.pdf', {
      type: 'application/pdf',
    });
    const item = {
      getAsFileSystemHandle: vi.fn().mockResolvedValue(null),
    } as unknown as DataTransferItem;

    await expect(readDroppedPdf(item, file)).resolves.toEqual({ file });
    await expect(readDroppedPdf({} as DataTransferItem, file)).resolves.toEqual({ file });
  });

  it('falls back to the dropped File when reading the item handle fails', async () => {
    const file = new File([Uint8Array.of(1)], 'fallback.pdf', {
      type: 'application/pdf',
    });
    const item = {
      getAsFileSystemHandle: vi.fn().mockResolvedValue({
        name: 'fallback.pdf',
        getFile: vi.fn().mockRejectedValue(new Error('transient file access failure')),
        createWritable: vi.fn(),
      }),
    } as unknown as DataTransferItem;

    await expect(readDroppedPdf(item, file)).resolves.toEqual({ file });
  });

  it('waits for file write close before reporting a successful write', async () => {
    const events: string[] = [];
    const handle = {
      name: 'target.pdf',
      getFile: vi.fn(),
      requestPermission: vi.fn().mockImplementation(async () => {
        events.push('permission');
        return 'granted';
      }),
      createWritable: vi.fn().mockImplementation(async () => ({
        write: vi.fn().mockImplementation(async (value: ArrayBuffer) => {
          events.push(`write:${Array.from(new Uint8Array(value)).join(',')}`);
        }),
        close: vi.fn().mockImplementation(async () => {
          events.push('close');
        }),
        abort: vi.fn(),
      })),
    };
    const permission = requestWritePermission(handle);

    await writePdfFile(handle, Uint8Array.of(7, 8, 9), permission);

    expect(events).toEqual(['permission', 'write:7,8,9', 'close']);
  });

  it('does not open a writable stream when permission is denied', async () => {
    const handle = {
      name: 'protected.pdf',
      getFile: vi.fn(),
      requestPermission: vi.fn().mockResolvedValue('denied'),
      createWritable: vi.fn(),
    };
    const permission = requestWritePermission(handle);

    await expect(writePdfFile(handle, Uint8Array.of(1), permission))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect(handle.createWritable).not.toHaveBeenCalled();
  });

  it('aborts a writable stream when writing fails', async () => {
    const abort = vi.fn().mockResolvedValue(undefined);
    const handle = {
      name: 'target.pdf',
      getFile: vi.fn(),
      createWritable: vi.fn().mockResolvedValue({
        write: vi.fn().mockRejectedValue(new Error('private filesystem detail')),
        close: vi.fn(),
        abort,
      }),
    };

    await expect(writePdfFile(handle, Uint8Array.of(1), Promise.resolve(true)))
      .rejects.toMatchObject({ code: 'write-failed' });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('uses the requested name with the save picker and treats cancellation as non-destructive', async () => {
    const picker = vi.fn().mockRejectedValue(Object.assign(new Error(), { name: 'AbortError' }));
    vi.stubGlobal('showSaveFilePicker', picker);

    await expect(pickSaveTarget('report.pdf')).resolves.toBeNull();
    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'report.pdf',
      types: [{
        description: 'PDF documents',
        accept: { 'application/pdf': ['.pdf'] },
      }],
    });
  });
});
