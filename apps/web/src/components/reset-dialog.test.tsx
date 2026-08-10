import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';

import { readyController } from '../test/fakes';
import { EditorShell } from './editor-shell';

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
