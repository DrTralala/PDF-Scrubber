import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';

import { readyController } from '../test/fakes';
import { EditorShell } from './editor-shell';
import { ResetDialog } from './reset-dialog';

it('restores focus after keeping an edited session', async () => {
  const controller = readyController({
    hasEdits: true,
    downloadAvailable: true,
  });
  render(<EditorShell controller={controller} snapshot={controller.getSnapshot()} />);
  const reset = screen.getByRole('button', { name: 'Reset' });

  await userEvent.click(reset);
  expect(screen.getByRole('dialog', { name: 'Reset all replacements?' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

  expect(document.activeElement).toBe(reset);
  expect(controller.reset).not.toHaveBeenCalled();
});

it('resets immediately when the session has no edits', async () => {
  const controller = readyController({ hasEdits: false });
  render(<EditorShell controller={controller} snapshot={controller.getSnapshot()} />);

  await userEvent.click(screen.getByRole('button', { name: 'Reset' }));

  expect(controller.reset).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('confirms Reset before discarding an unapplied replacement draft', async () => {
  const controller = readyController({
    hasEdits: false,
    hasUnsavedChanges: true,
  });
  render(<EditorShell controller={controller} snapshot={controller.getSnapshot()} />);

  await userEvent.click(screen.getByRole('button', { name: 'Reset' }));

  expect(screen.getByRole('dialog', { name: 'Reset all replacements?' })).toBeTruthy();
  expect(controller.reset).not.toHaveBeenCalled();
});

it('disables the dialog reset action while a save is in progress', () => {
  render(
    <ResetDialog
      open
      disabled
      onKeep={() => undefined}
      onReset={() => undefined}
    />,
  );

  expect(screen.getByRole('button', { name: 'Reset to original' }))
    .toHaveProperty('disabled', true);
});
