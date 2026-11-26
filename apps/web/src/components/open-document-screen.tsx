import { useRef, useState, type ChangeEvent, type DragEvent, type JSX } from 'react';
import { MAX_PDF_FILE_BYTES, MAX_PDF_FILE_MIB } from '@pdf-editor/pdf-engine';

import {
  canPickPdf,
  pickPdfFile,
  readDroppedPdf,
  type WritablePdfHandle,
} from '../file-access';
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
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = snapshot.phase === 'opening';

  const acceptFile = (file: File | undefined, handle?: WritablePdfHandle): void => {
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
    void controller.open(file, handle);
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>): void => {
    acceptFile(event.currentTarget.files?.[0]);
    event.currentTarget.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    const fileItems = Array.from(event.dataTransfer.items ?? [])
      .filter((item) => item.kind === 'file');
    const matchingItem = fileItems.find((item) => {
      const itemFile = item.getAsFile();
      return itemFile !== null
        && file !== undefined
        && itemFile.name === file.name
        && itemFile.size === file.size;
    });
    const dropped = readDroppedPdf(
      matchingItem ?? fileItems[0],
      file,
    );
    void dropped.then((selection) => {
      if (selection !== null) acceptFile(selection.file, selection.handle);
    });
  };

  const openFile = async (): Promise<void> => {
    if (busy) return;
    if (!canPickPdf()) {
      inputRef.current?.click();
      return;
    }
    setLocalError(null);
    try {
      const opened = await pickPdfFile();
      if (opened !== null) acceptFile(opened.file, opened.handle);
    } catch {
      setLocalError('This PDF could not be opened safely. Choose another file.');
    }
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
        <p className="drop-copy">Choose a file or drop it here.</p>
        <button
          type="button"
          className="open-button"
          disabled={busy}
          onClick={() => void openFile()}
        >
          {busy ? 'Opening PDF…' : 'Open PDF'}
        </button>
        <input
          ref={inputRef}
          aria-label="Open PDF"
          type="file"
          accept="application/pdf,.pdf"
          disabled={busy}
          hidden
          tabIndex={-1}
          onChange={handleInput}
        />
        {(localError ?? snapshot.error?.message) !== null && (
          <p className="open-error" role="alert">
            {localError ?? snapshot.error?.message}
          </p>
        )}
      </section>
    </main>
  );
}
