import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { App } from '../app';
import type { EditorSnapshot } from '../model/editor-state';
import type { EditorController } from '../session/editor-controller';

function readyController(
  overrides: Partial<EditorSnapshot> = {},
): EditorController {
  const snapshot: EditorSnapshot = {
    phase: 'ready',
    generation: 1,
    fileName: 'report.pdf',
    pageIndex: 0,
    pageCount: 1,
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
    status: 'Ready',
    error: null,
    ...overrides,
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    close: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    saveAs: vi.fn().mockResolvedValue(undefined),
    downloadCurrent: vi.fn().mockResolvedValue({
      sourceFileName: 'report.pdf',
      bytes: Uint8Array.of(1, 2, 3),
    }),
    downloadCurrentDocument: vi.fn().mockResolvedValue({
      sourceFileName: 'report.pdf',
      bytes: Uint8Array.of(1, 2, 3),
    }),
    getDisplayPage: vi.fn(() => new Promise(() => undefined)),
    setPage: vi.fn().mockResolvedValue(undefined),
    setZoom: vi.fn(),
    setTool: vi.fn(),
    setShowOverlays: vi.fn(),
    canInsertImages: vi.fn(() => true),
    registerFont: vi.fn(),
    insertImage: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue(undefined),
    reportDisplayError: vi.fn(),
  } as unknown as EditorController;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('shows only implemented editor tools and current page controls', () => {
  render(<App controller={readyController({ fileName: 'report.pdf', pageCount: 3 })} />);

  expect(screen.getByRole('button', { name: 'Select text' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Pan document' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Show editable text' })).toBeTruthy();
  const fontsLauncher = screen.getByRole('button', { name: 'Fonts needed for editing' });
  expect(fontsLauncher.textContent).toContain('Fonts');
  expect((screen.getByLabelText('Page number') as HTMLInputElement).value).toBe('1');
  expect(screen.queryByRole('button', { name: /add image/i })).toBeNull();
});

it('places image insertion and Reset before Save as and Save', async () => {
  const controller = readyController();
  const { unmount } = render(<App controller={controller} />);

  const actions = document.querySelector('.document-actions')!;
  const buttons = Array.from(actions.querySelectorAll('button'));
  expect(buttons.map((button) => button.textContent)).toEqual([
    'Insert image',
    'Reset',
    'Save as...',
    'Save',
  ]);
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  expect(screen.getByLabelText('Choose image to insert').getAttribute('accept'))
    .toContain('image/jpeg');

  await userEvent.click(screen.getByRole('button', { name: 'Insert image' }));
  fireEvent(screen.getByLabelText('Choose image to insert'), new Event('cancel', { bubbles: true }));

  expect(controller.insertImage).not.toHaveBeenCalled();
});

it('saves through the active handle and adopts only a successfully selected Save as target', async () => {
  const controller = readyController({
    hasUnsavedChanges: true,
    hasWritableFileHandle: true,
  });
  const target = { name: 'copy.pdf' };
  const picker = vi.fn().mockResolvedValue(target);
  vi.stubGlobal('showSaveFilePicker', picker);
  render(<App controller={controller} />);

  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(controller.save).toHaveBeenCalledTimes(1);
  expect(controller.downloadCurrent).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('button', { name: 'Save as...' }));
  await waitFor(() => expect(controller.saveAs).toHaveBeenCalledWith(target));
  expect(picker).toHaveBeenCalledWith({
    suggestedName: 'report.pdf',
    types: [{
      description: 'PDF documents',
      accept: { 'application/pdf': ['.pdf'] },
    }],
  });
});

it('keeps the current document and warning when the Save as picker is cancelled', async () => {
  const controller = readyController({ hasUnsavedChanges: true });
  const picker = vi.fn().mockRejectedValue(Object.assign(new Error('cancelled'), {
    name: 'AbortError',
  }));
  vi.stubGlobal('showSaveFilePicker', picker);
  render(<App controller={controller} />);

  await userEvent.click(screen.getByRole('button', { name: 'Save as...' }));
  await waitFor(() => expect(picker).toHaveBeenCalledTimes(1));

  expect(controller.saveAs).not.toHaveBeenCalled();
  expect(controller.getSnapshot()).toMatchObject({
    fileName: 'report.pdf',
    hasUnsavedChanges: true,
  });
});

it('offers a download-only copy without claiming the document was saved', async () => {
  const controller = readyController({ hasUnsavedChanges: true });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download-copy');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.stubGlobal('showSaveFilePicker', undefined);
  render(<App controller={controller} />);

  await userEvent.click(screen.getByRole('button', { name: 'Save as...' }));

  await waitFor(() => expect(controller.downloadCurrentDocument).toHaveBeenCalledTimes(1));
  expect(click).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/The original was not changed/)).toBeTruthy();
  expect(controller.getSnapshot().hasUnsavedChanges).toBe(true);
});

it('attaches the plain dirty filename to the document title and guards unload only while dirty', async () => {
  const controller = readyController({
    fileName: 'report <draft>.pdf',
    hasUnsavedChanges: true,
  });
  const { unmount } = render(<App controller={controller} />);

  await waitFor(() => expect(document.title)
    .toBe('report <draft>.pdf — Unsaved changes | PDF-Scrubber'));
  const dirtyUnload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(dirtyUnload);
  expect(dirtyUnload.defaultPrevented).toBe(true);

  unmount();
  render(<App controller={readyController({ hasUnsavedChanges: false })} />);
  await waitFor(() => expect(document.title).toBe('PDF-Scrubber'));
  const cleanUnload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(cleanUnload);
  expect(cleanUnload.defaultPrevented).toBe(false);
});

it('disables Reset while a save is in progress', () => {
  render(<App controller={readyController({ isSaving: true, hasEdits: true })} />);

  expect(screen.getByRole('button', { name: 'Reset' })).toHaveProperty('disabled', true);
});

it('announces image validation errors inside the editor', () => {
  render(<App controller={readyController({ imageError: 'Choose a readable PNG or JPEG image.' })} />);

  expect(screen.getByRole('alert').textContent).toBe('Choose a readable PNG or JPEG image.');
});

it('opens missing fonts without changing editor mode and restores launcher focus', async () => {
  const controller = readyController({
    tool: 'pan',
    showOverlays: false,
    fontInventoryState: 'ready',
    editingFonts: [{ name: 'DejaVuSans', reason: 'not-embedded' }],
  });
  render(<App controller={controller} />);
  const launcher = screen.getByRole('button', { name: 'Fonts needed for editing' });

  await userEvent.click(launcher);
  expect(launcher.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('dialog', { name: 'Fonts needed for editing' })).toBeTruthy();
  expect(screen.getByText('DejaVuSans')).toBeTruthy();
  expect(controller.setTool).not.toHaveBeenCalled();
  expect(controller.setShowOverlays).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog', { name: 'Fonts needed for editing' })).toBeNull();
  expect(document.activeElement).toBe(launcher);
  expect(launcher.getAttribute('aria-expanded')).toBe('false');
});

it('closes missing fonts from a focused descendant with Escape and restores launcher focus', async () => {
  const controller = readyController({
    tool: 'pan',
    showOverlays: false,
    fontInventoryState: 'ready',
    editingFonts: [{ name: 'DejaVuSans', reason: 'not-embedded' }],
  });
  render(<App controller={controller} />);
  const launcher = screen.getByRole('button', { name: 'Fonts needed for editing' });

  await userEvent.click(launcher);
  const closeButton = screen.getByRole('button', { name: 'Close' });
  expect(document.activeElement).toBe(closeButton);
  await userEvent.keyboard('{Escape}');

  expect(screen.queryByRole('dialog', { name: 'Fonts needed for editing' })).toBeNull();
  expect(document.activeElement).toBe(launcher);
  expect(launcher.getAttribute('aria-expanded')).toBe('false');
  expect(controller.setTool).not.toHaveBeenCalled();
  expect(controller.setShowOverlays).not.toHaveBeenCalled();
});

it('changes only implemented tool state', async () => {
  const controller = readyController({ tool: 'select', showOverlays: false });
  render(<App controller={controller} />);

  await userEvent.click(screen.getByRole('button', { name: 'Pan document' }));
  await userEvent.click(screen.getByRole('button', { name: 'Show editable text' }));

  expect(controller.setTool).toHaveBeenCalledWith('pan');
  expect(controller.setShowOverlays).toHaveBeenCalledWith(true);
});

it('uses one-based clamped page navigation', async () => {
  const controller = readyController({ pageCount: 3, pageIndex: 0 });
  render(<App controller={controller} />);

  await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
  const pageInput = screen.getByLabelText('Page number');
  await userEvent.clear(pageInput);
  await userEvent.type(pageInput, '99{Enter}');

  expect(controller.setPage).toHaveBeenNthCalledWith(1, 1);
  expect(controller.setPage).toHaveBeenNthCalledWith(2, 2);
});
