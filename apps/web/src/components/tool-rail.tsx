import { useRef, useState, type JSX } from 'react';

import { MissingFontsDialog } from './missing-fonts-dialog';
import type { EditorSnapshot } from '../model/editor-state';
import type { EditorController } from '../session/editor-controller';

export function ToolRail({
  controller,
  snapshot,
}: Readonly<{
  controller: EditorController;
  snapshot: EditorSnapshot;
}>): JSX.Element {
  const [fontDialogOpen, setFontDialogOpen] = useState(false);
  const fontButtonRef = useRef<HTMLButtonElement>(null);

  const closeFontDialog = (): void => {
    setFontDialogOpen(false);
    fontButtonRef.current?.focus();
  };

  return (
    <>
      <nav className="tool-rail" aria-label="Editor tools">
        <button
          type="button"
          aria-label="Select text"
          aria-pressed={snapshot.tool === 'select'}
          onClick={() => controller.setTool('select')}
        >
          Select
        </button>
        <button
          type="button"
          aria-label="Pan document"
          aria-pressed={snapshot.tool === 'pan'}
          onClick={() => controller.setTool('pan')}
        >
          Pan
        </button>
        <button
          type="button"
          aria-label="Show editable text"
          aria-pressed={snapshot.showOverlays}
          onClick={() => controller.setShowOverlays(!snapshot.showOverlays)}
        >
          Text
        </button>
        <button
          ref={fontButtonRef}
          type="button"
           aria-label="Fonts needed for editing"
          aria-haspopup="dialog"
          aria-expanded={fontDialogOpen}
          onClick={() => setFontDialogOpen(true)}
        >
          Fonts
        </button>
      </nav>
      {fontDialogOpen && (
        <MissingFontsDialog
          inventoryState={snapshot.fontInventoryState}
          editingFonts={snapshot.editingFonts}
          registerFont={(fileName, bytes) => controller.registerFont('upload', fileName, bytes)}
          onClose={closeFontDialog}
        />
      )}
    </>
  );
}
