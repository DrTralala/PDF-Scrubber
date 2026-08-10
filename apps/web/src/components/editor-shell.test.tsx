import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

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
    hasEdits: false,
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
    getDisplayPage: vi.fn(() => new Promise(() => undefined)),
    setPage: vi.fn().mockResolvedValue(undefined),
    setZoom: vi.fn(),
    setTool: vi.fn(),
    setShowOverlays: vi.fn(),
    registerFont: vi.fn(),
    reset: vi.fn().mockResolvedValue(undefined),
    reportDisplayError: vi.fn(),
  } as unknown as EditorController;
}

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
