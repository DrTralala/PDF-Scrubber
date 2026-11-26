import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type JSX,
} from 'react';

import { downloadPdf } from '../download';
import { canPickSaveTarget, pickSaveTarget } from '../file-access';
import type { EditorSnapshot } from '../model/editor-state';
import type { EditorController, ImageInsertionContext } from '../session/editor-controller';
import { ResetDialog } from './reset-dialog';

export function EditorChrome({
  controller,
  snapshot,
  onInsertImage,
}: Readonly<{
  controller: EditorController;
  snapshot: EditorSnapshot;
  onInsertImage(file: File, context: Pick<ImageInsertionContext, 'generation' | 'pageIndex'>): void;
}>): JSX.Element {
  const [pageValue, setPageValue] = useState(String(snapshot.pageIndex + 1));
  const [resetOpen, setResetOpen] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const resetButtonRef = useRef<HTMLButtonElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imagePickerContext = useRef<Pick<ImageInsertionContext, 'generation' | 'pageIndex'> | null>(null);
  useEffect(() => {
    setPageValue(String(snapshot.pageIndex + 1));
  }, [snapshot.pageIndex]);

  const goToEnteredPage = (): void => {
    const parsed = Number.parseInt(pageValue, 10);
    const oneBased = Number.isFinite(parsed) ? parsed : snapshot.pageIndex + 1;
    const clamped = Math.max(1, Math.min(snapshot.pageCount, oneBased));
    setPageValue(String(clamped));
    void controller.setPage(clamped - 1);
  };

  const submitPage = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    goToEnteredPage();
  };

  const restoreResetFocus = (): void => {
    setResetOpen(false);
    resetButtonRef.current?.focus();
  };

  const requestReset = (): void => {
    if (snapshot.hasEdits || snapshot.hasUnsavedChanges) setResetOpen(true);
    else void controller.reset();
  };

  const confirmReset = (): void => {
    void controller.reset();
    restoreResetFocus();
  };

  const openImagePicker = (): void => {
    imagePickerContext.current = Object.freeze({
      generation: snapshot.generation,
      pageIndex: snapshot.pageIndex,
    });
    imageInputRef.current?.click();
  };

  const acceptImage = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    const context = imagePickerContext.current;
    if (file !== undefined && context !== null) onInsertImage(file, context);
    event.currentTarget.value = '';
  };

  const save = (): void => {
    setCopyMessage('');
    void controller.save();
  };

  const saveAs = async (): Promise<void> => {
    setCopyMessage('');
    if (canPickSaveTarget()) {
      try {
        const handle = await pickSaveTarget(snapshot.fileName ?? 'document.pdf');
        if (handle !== null) await controller.saveAs(handle);
      } catch {
        setCopyMessage('The PDF could not be saved. Your changes remain unsaved.');
      }
      return;
    }
    const asset = await controller.downloadCurrentDocument();
    if (asset === null) {
      setCopyMessage('The PDF could not be prepared for download. Your changes remain unsaved.');
      return;
    }
    downloadPdf(asset);
    setCopyMessage(
      'A copy download was started. The original was not changed; this document remains unsaved.',
    );
  };

  return (
    <header className="editor-chrome">
      <div className="chrome-identity">
        <span className="wordmark">PDF-Scrubber</span>
        <span className="file-name" title={snapshot.fileName ?? undefined}>
          {snapshot.fileName}
        </span>
      </div>
      <nav className="page-controls" aria-label="Page navigation">
        <button
          type="button"
          aria-label="Previous page"
          disabled={snapshot.pageIndex <= 0}
          onClick={() => void controller.setPage(snapshot.pageIndex - 1)}
        >
          ←
        </button>
        <form onSubmit={submitPage}>
          <label>
            <span className="sr-only">Page number</span>
            <input
              aria-label="Page number"
              inputMode="numeric"
              value={pageValue}
              onChange={(event) => setPageValue(event.currentTarget.value)}
              onBlur={goToEnteredPage}
            />
          </label>
          <span aria-hidden="true">/ {snapshot.pageCount}</span>
        </form>
        <button
          type="button"
          aria-label="Next page"
          disabled={snapshot.pageIndex >= snapshot.pageCount - 1}
          onClick={() => void controller.setPage(snapshot.pageIndex + 1)}
        >
          →
        </button>
      </nav>
      <div className="zoom-controls" aria-label="Zoom controls">
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => controller.setZoom(snapshot.zoom - 0.25, 'custom')}
        >
          −
        </button>
        <span className="zoom-value">{Math.round(snapshot.zoom * 100)}%</span>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => controller.setZoom(snapshot.zoom + 0.25, 'custom')}
        >
          +
        </button>
        <button
          type="button"
          aria-pressed={snapshot.fitMode === 'page'}
          onClick={() => controller.setZoom(snapshot.zoom, 'page')}
        >
          Fit page
        </button>
        <button
          type="button"
          aria-pressed={snapshot.fitMode === 'width'}
          onClick={() => controller.setZoom(snapshot.zoom, 'width')}
        >
          Fit width
        </button>
      </div>
      <div className="document-actions">
        <input
          ref={imageInputRef}
          className="sr-only"
          aria-label="Choose image to insert"
          type="file"
          accept="image/png,image/jpeg,.png,.jpg,.jpeg"
          tabIndex={-1}
          onChange={acceptImage}
        />
        <button
          type="button"
          disabled={!controller.canInsertImages()}
          onClick={openImagePicker}
        >
          Insert image
        </button>
        <button
          ref={resetButtonRef}
          type="button"
          disabled={snapshot.isSaving}
          onClick={requestReset}
        >
          Reset
        </button>
        <button
          type="button"
          disabled={snapshot.isSaving || snapshot.isDownloading || snapshot.phase !== 'ready'}
          onClick={() => void saveAs()}
        >
          Save as...
        </button>
        <button
          type="button"
          disabled={!snapshot.hasUnsavedChanges || snapshot.isSaving || snapshot.isDownloading || snapshot.phase !== 'ready'}
          onClick={save}
        >
          Save
        </button>
      </div>
      {copyMessage !== '' && <p className="save-copy-status" aria-live="polite">{copyMessage}</p>}
      {snapshot.imageError !== null && (
        <p className="image-error" role="alert">{snapshot.imageError}</p>
      )}
      <ResetDialog
        open={resetOpen}
        disabled={snapshot.isSaving}
        onKeep={restoreResetFocus}
        onReset={confirmReset}
      />
    </header>
  );
}
