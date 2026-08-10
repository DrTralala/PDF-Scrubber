import type { JSX } from 'react';

export function ResetDialog({
  open,
  onKeep,
  onReset,
}: Readonly<{
  open: boolean;
  onKeep(): void;
  onReset(): void;
}>): JSX.Element | null {
  if (!open) return null;
  return (
    <dialog open className="reset-dialog" aria-labelledby="reset-dialog-title">
      <h2 id="reset-dialog-title">Reset all replacements?</h2>
      <p>This restores the untouched original PDF and removes every replacement.</p>
      <div className="dialog-actions">
        <button type="button" onClick={onKeep}>Keep editing</button>
        <button type="button" className="destructive" onClick={onReset}>
          Reset to original
        </button>
      </div>
    </dialog>
  );
}
