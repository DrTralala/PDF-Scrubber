import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

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
    hasEdits: false,
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

it('passes a selected PDF to the controller', async () => {
  const controller = fakeController();
  render(<App controller={controller} />);
  const file = new File([Uint8Array.of(1)], 'report.pdf', {
    type: 'application/pdf',
  });

  await userEvent.upload(screen.getByLabelText('Open PDF'), file);

  expect(controller.open).toHaveBeenCalledWith(file);
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

  expect(controller.open).toHaveBeenCalledWith(file);
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
