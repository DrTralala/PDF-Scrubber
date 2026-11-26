import {
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';

import { canonicalPageSize } from '@pdf-editor/pdf-engine';

import type { EditorSnapshot } from '../model/editor-state';
import { renderPageToCanvas } from '../pdf/display-document';
import { fitScale } from '../pdf/viewport';
import type { EditorController } from '../session/editor-controller';
import { CapabilityOverlay } from './capability-overlay';
import { ImageOverlay } from './image-overlay';

type Size = Readonly<{ width: number; height: number }>;
type ImageRequest = Readonly<{
  id: number;
  file: File;
  generation: number;
  pageIndex: number;
}>;

export function PdfPageView({
  controller,
  snapshot,
  imageRequest = null,
  onImageRequestHandled = () => undefined,
}: Readonly<{
  controller: EditorController;
  snapshot: EditorSnapshot;
  imageRequest?: ImageRequest | null;
  onImageRequestHandled?: (requestId: number) => void;
}>): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageFrameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [available, setAvailable] = useState<Size>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Size | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const update = (width: number, height: number): void => {
      setAvailable((current) => current.width === width && current.height === height
        ? current
        : { width, height });
    };
    update(container.clientWidth, container.clientHeight);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        update(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const abortController = new AbortController();
    setViewport(null);

    void (async () => {
      try {
        const page = await controller.getDisplayPage(snapshot.pageIndex);
        if (abortController.signal.aborted) return;
        const unscaled = page.getViewport({ scale: 1 });
        if (
          snapshot.fitMode !== 'custom'
          && available.width > 0
          && available.height > 0
        ) {
          const nextZoom = fitScale(
            { width: unscaled.width, height: unscaled.height },
            available,
            snapshot.fitMode,
          );
          if (Math.abs(nextZoom - snapshot.zoom) > 1e-6) {
            controller.setZoom(nextZoom, snapshot.fitMode);
            return;
          }
        }
        const dimensions = await renderPageToCanvas(
          page,
          canvas,
          snapshot.zoom,
          abortController.signal,
        );
        if (!abortController.signal.aborted) setViewport(dimensions);
      } catch (error) {
        if (!abortController.signal.aborted) controller.reportDisplayError(error);
      }
    })();

    return () => abortController.abort();
  }, [
    available.height,
    available.width,
    controller,
    snapshot.displayVersion,
    snapshot.fitMode,
    snapshot.generation,
    snapshot.pageIndex,
    snapshot.zoom,
  ]);

  useEffect(() => {
    if (imageRequest === null) return;
    if (
      imageRequest.generation !== snapshot.generation
      || imageRequest.pageIndex !== snapshot.pageIndex
    ) {
      onImageRequestHandled(imageRequest.id);
      return;
    }
    if (
      snapshot.analysis === null
      || snapshot.analysis.pageIndex !== imageRequest.pageIndex
    ) return;
    const pageFrame = pageFrameRef.current;
    const canvas = containerRef.current?.closest<HTMLElement>('.document-canvas');
    if (
      viewport === null
      || pageFrame === null
      || canvas === null
      || canvas === undefined
    ) return;

    const pageRect = pageFrame.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const visibleLeft = Math.max(pageRect.left, canvasRect.left + canvas.clientLeft);
    const visibleTop = Math.max(pageRect.top, canvasRect.top + canvas.clientTop);
    const visibleRight = Math.min(
      pageRect.right,
      canvasRect.left + canvas.clientLeft + canvas.clientWidth,
    );
    const visibleBottom = Math.min(
      pageRect.bottom,
      canvasRect.top + canvas.clientTop + canvas.clientHeight,
    );
    if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
      onImageRequestHandled(imageRequest.id);
      return;
    }

    const [canonicalWidth, canonicalHeight] = canonicalPageSize(snapshot.analysis.pageSpace);
    const scale = viewport.width / canonicalWidth;
    const centerX = ((visibleLeft + visibleRight) / 2 - pageRect.left) / scale;
    const centerY = canonicalHeight
      - (((visibleTop + visibleBottom) / 2 - pageRect.top) / scale);
    void controller.insertImage(imageRequest.file, {
      generation: imageRequest.generation,
      pageIndex: imageRequest.pageIndex,
      center: { x: centerX, y: centerY },
    });
    onImageRequestHandled(imageRequest.id);
  }, [
    controller,
    imageRequest,
    onImageRequestHandled,
    snapshot.analysis,
    snapshot.generation,
    snapshot.pageIndex,
    viewport,
  ]);

  return (
    <div ref={containerRef} className="page-viewport">
      {viewport === null && <p className="render-status">Rendering page…</p>}
      <div
        className="page-frame"
        ref={pageFrameRef}
        style={viewport === null ? undefined : {
          width: `${viewport.width}px`,
          height: `${viewport.height}px`,
        }}
      >
        <canvas
          ref={canvasRef}
          data-testid="pdf-canvas"
          aria-label={`Page ${snapshot.pageIndex + 1}`}
        />
        {viewport !== null && snapshot.analysis !== null && (
          <CapabilityOverlay
            controller={controller}
            analysis={snapshot.analysis}
            selection={snapshot.selection}
            richEditor={snapshot.richEditor}
            fonts={snapshot.fonts}
            viewport={viewport}
            showOverlays={snapshot.showOverlays}
            tool={snapshot.tool}
          />
        )}
        {viewport !== null
          && snapshot.analysis !== null
          && snapshot.analysis.pageIndex === snapshot.pageIndex && (
          <ImageOverlay
            controller={controller}
            analysis={snapshot.analysis}
            images={snapshot.images}
            selectedImageId={snapshot.selectedImageId}
            viewport={viewport}
            tool={snapshot.tool}
          />
        )}
      </div>
    </div>
  );
}
