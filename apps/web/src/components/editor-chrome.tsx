import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react';

import { downloadPdf } from '../download';
import type { EditorSnapshot } from '../model/editor-state';
import type { EditorController } from '../session/editor-controller';
import { ResetDialog } from './reset-dialog';

export function EditorChrome({
  controller,
  snapshot,
}: Readonly<{
  controller: EditorController;
  snapshot: EditorSnapshot;
}>): JSX.Element {
  const [pageValue, setPageValue] = useState(String(snapshot.pageIndex + 1));
  const [resetOpen, setResetOpen] = useState(false);
  const resetButtonRef = useRef<HTMLButtonElement>(null);
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
    if (snapshot.hasEdits) setResetOpen(true);
    else void controller.reset();
  };

  const confirmReset = (): void => {
    void controller.reset();
    restoreResetFocus();
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
        <button ref={resetButtonRef} type="button" onClick={requestReset}>
          Reset
        </button>
        <button
          type="button"
          disabled={!snapshot.downloadAvailable}
          onClick={() => downloadPdf(controller.download())}
        >
          Download copy
        </button>
      </div>
      <ResetDialog
        open={resetOpen}
        onKeep={restoreResetFocus}
        onReset={confirmReset}
      />
    </header>
  );
}
