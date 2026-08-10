import { useState, type ChangeEvent, type DragEvent, type JSX } from 'react';
import { MAX_PDF_FILE_BYTES, MAX_PDF_FILE_MIB } from '@pdf-editor/pdf-engine';

import type { EditorSnapshot } from '../model/editor-state';
import type { EditorController } from '../session/editor-controller';

export function OpenDocumentScreen({
  controller,
  snapshot,
}: Readonly<{
  controller: EditorController;
  snapshot: EditorSnapshot;
}>): JSX.Element {
  const [localError, setLocalError] = useState<string | null>(null);
  const busy = snapshot.phase === 'opening';

  const acceptFile = (file: File | undefined): void => {
    if (file === undefined || busy) return;
    if (
      file.type.toLowerCase() !== 'application/pdf'
      && !file.name.toLowerCase().endsWith('.pdf')
    ) {
      setLocalError('Choose a PDF file.');
      return;
    }
    if (file.size > MAX_PDF_FILE_BYTES) {
      setLocalError(`This release supports PDFs up to ${MAX_PDF_FILE_MIB} MiB.`);
      return;
    }
    setLocalError(null);
    void controller.open(file);
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>): void => {
    acceptFile(event.currentTarget.files?.[0]);
    event.currentTarget.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    acceptFile(event.dataTransfer.files[0]);
  };

  return (
    <main className="open-screen">
      <div className="wordmark">PDF-Scrubber</div>
      <section
        className="open-card"
        aria-labelledby="open-title"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <p className="eyebrow">Local PDF · Existing text</p>
        <h1 id="open-title">Open a PDF to edit text</h1>
        <p>Your file stays in this browser. {MAX_PDF_FILE_MIB} MiB maximum.</p>
        <p className="drop-copy">Choose a file or drop it on this desk.</p>
        <label className="open-button" aria-disabled={busy}>
          {busy ? 'Opening PDF…' : 'Open PDF'}
          <input
            aria-label="Open PDF"
            type="file"
            accept="application/pdf,.pdf"
            disabled={busy}
            onChange={handleInput}
          />
        </label>
        {(localError ?? snapshot.error?.message) !== null && (
          <p className="open-error" role="alert">
            {localError ?? snapshot.error?.message}
          </p>
        )}
      </section>
    </main>
  );
}
