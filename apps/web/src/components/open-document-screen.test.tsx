import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { App } from '../app';
import type { EditorSnapshot } from '../model/editor-state';
import type { EditorController } from '../session/editor-controller';

function emptySnapshot(): EditorSnapshot {
  return {
    phase: 'empty',
    generation: 0,
    fileName: null,
    pageIndex: 0,
    pageCount: 0,
    zoom: 1,
    fitMode: 'page',
    tool: 'select',
    showOverlays: true,
    analysis: null,
    fonts: [],
    fontInventoryState: 'ready',
    editingFonts: [],
    selection: null,
    replacement: '',
    acceptSubstitution: false,
    preview: null,
    richEditor: null,
    images: [],
    selectedImageId: null,
    imageError: null,
    isDownloading: false,
    isSaving: false,
    hasEdits: false,
    hasUnsavedChanges: false,
    hasWritableFileHandle: false,
    downloadAvailable: false,
    displayVersion: 0,
    status: 'Open a PDF to begin',
    error: null,
  };
}

function fakeController(): EditorController {
  const snapshot = emptySnapshot();
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as EditorController;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('passes a selected PDF to the controller', async () => {
  const controller = fakeController();
  render(<App controller={controller} />);
  const file = new File([Uint8Array.of(1)], 'report.pdf', {
    type: 'application/pdf',
  });
  const input = screen.getByLabelText('Open PDF');
  expect(input).toHaveProperty('hidden', true);
  expect(input).toHaveProperty('tabIndex', -1);

  await userEvent.upload(input, file);

  expect(controller.open).toHaveBeenCalledWith(file, undefined);
});

it('opens through a user-selected picker and retains its writable handle', async () => {
  const controller = fakeController();
  const file = new File([Uint8Array.of(1)], 'picked.pdf', {
    type: 'application/pdf',
  });
  const handle = { name: 'picked.pdf', getFile: vi.fn().mockResolvedValue(file) };
  const picker = vi.fn().mockResolvedValue([handle]);
  vi.stubGlobal('showOpenFilePicker', picker);
  render(<App controller={controller} />);

  await userEvent.click(screen.getByRole('button', { name: 'Open PDF' }));
  await waitFor(() => expect(controller.open).toHaveBeenCalledWith(file, handle));

  expect(picker).toHaveBeenCalledTimes(1);
});

it('keeps dropped PDFs on the handle-free fallback path', async () => {
  const controller = fakeController();
  render(<App controller={controller} />);
  const file = new File([Uint8Array.of(4, 5)], 'dropped.pdf', {
    type: 'application/pdf',
  });

  fireEvent.drop(screen.getByRole('region', { name: 'Open a PDF to edit text' }), {
    dataTransfer: { files: [file] },
  });

  await waitFor(() => expect(controller.open).toHaveBeenCalledWith(file, undefined));
});

it('uses the synchronously captured dropped file handle when available', async () => {
  const controller = fakeController();
  render(<App controller={controller} />);
  const fallbackFile = new File([Uint8Array.of(1)], 'fallback.pdf', {
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
  const unrelatedItem = {
    kind: 'string',
    getAsFile: vi.fn().mockReturnValue(null),
    getAsFileSystemHandle: vi.fn(),
  };
  const item = {
    kind: 'file',
    getAsFile: vi.fn().mockReturnValue(fallbackFile),
    getAsFileSystemHandle: vi.fn().mockResolvedValue(handle),
  };

  fireEvent.drop(screen.getByRole('region', { name: 'Open a PDF to edit text' }), {
    dataTransfer: { files: [fallbackFile], items: [unrelatedItem, item] },
  });

  expect(unrelatedItem.getAsFileSystemHandle).not.toHaveBeenCalled();
  expect(item.getAsFileSystemHandle).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(controller.open).toHaveBeenCalledWith(handleFile, handle));
  expect(handle.getFile).toHaveBeenCalledTimes(1);
});

it('accepts a PDF at the exact 15 MiB product boundary', async () => {
  const controller = fakeController();
  render(<App controller={controller} />);
  const file = new File(
    [new Uint8Array(15_728_640)],
    'boundary.pdf',
    { type: 'application/pdf' },
  );

  await userEvent.upload(screen.getByLabelText('Open PDF'), file);

  expect(controller.open).toHaveBeenCalledWith(file, undefined);
});

it('rejects a file above the measured input limit before opening', async () => {
  const controller = fakeController();
  render(<App controller={controller} />);
  const file = new File(
    [new Uint8Array(15_728_641)],
    'large.pdf',
    { type: 'application/pdf' },
  );

  await userEvent.upload(screen.getByLabelText('Open PDF'), file);

  expect(screen.getByText('This release supports PDFs up to 15 MiB.')).toBeTruthy();
  expect(controller.open).not.toHaveBeenCalled();
});

it('rejects a non-PDF file through the shared local validation path', async () => {
  const controller = fakeController();
  render(<App controller={controller} />);
  const file = new File([Uint8Array.of(1)], 'notes.txt', {
    type: 'text/plain',
  });

  await userEvent.upload(screen.getByLabelText('Open PDF'), file, {
    applyAccept: false,
  });

  expect(screen.getByText('Choose a PDF file.')).toBeTruthy();
  expect(controller.open).not.toHaveBeenCalled();
});
